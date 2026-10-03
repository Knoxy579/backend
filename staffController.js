const db = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const moment = require("moment");
const config = require("../config/config");
const smsService = require("../utils/smsService");

/**
 * 
 * Adım 1: POST /api/staff/login
 * - Telefon numarasını doğrular (TR formatı)
 * - Staff'ı global olarak (restaurant_id'den bağımsız) telefona göre bulur
 * - 6 haneli OTP kodu üretip SMS ile gönderir
 * - verification_codes tablosuna staff'ın gerçek restaurant_id'si ile kaydeder
 * - Token DÖNDÜRMEZ — sadece "Kod gönderildi" mesajı
 */
const loginStaff = async (req, res) => {
  const { phone } = req.body;

  // --- Telefon format kontrolü ---
  // Geçerli TR formatları: 05XXXXXXXXX (11 hane) veya 5XXXXXXXXX (10 hane)
  const cleanPhone = (phone || "").replace(/\D/g, "");
  if (!/^(05\d{9}|5\d{9})$/.test(cleanPhone)) {
    return res.status(400).json({
      error: "Geçerli bir TR telefon numarası girin. (Örn: 05XXXXXXXXX)",
    });
  }

  // DB'ye kaydedilecek format: başında 0 olmadan (smsService de 0'ı siliyor ama tutarlı olsun)
  const normalizedPhone = cleanPhone.startsWith("0")
    ? cleanPhone.substring(1)
    : cleanPhone;

  try {
    // --- Staff sorgusu: restaurant_id FİLTRESİ YOK ---
    // Neden? Login öncesi frontend hangi restorana ait olduğunu bilmiyor.
    // Staff'ın gerçek restaurant_id'si DB'den çekilecek, req.restaurant_id (hardcoded '1') kullanılmıyor.
    // DB'de numara hem '05XXXXXXXXX' hem '5XXXXXXXXX' formatında olabilir — her ikisini de dene
    const phoneWith0 = normalizedPhone.startsWith('5') ? '0' + normalizedPhone : normalizedPhone;
    const phoneWithout0 = normalizedPhone.startsWith('0') ? normalizedPhone.substring(1) : normalizedPhone;
    const [staffResults] = await db
      .promise()
      .query(
        "SELECT * FROM staff WHERE (phone = ? OR phone = ?) AND status = 'active' LIMIT 1",
        [phoneWith0, phoneWithout0]
      );

    if (staffResults.length === 0) {
      return res.status(401).json({
        error: "Bu numaraya kayıtlı aktif bir hesap bulunamadı.",
      });
    }

    const staff = staffResults[0];

    // --- OTP kodu üret ---
    const verificationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    const expiresAt = moment().add(3, "minutes").toDate();

    // --- verification_codes tablosuna kaydet ---
    // staff.restaurant_id kullanıyoruz — req.restaurant_id (hardcoded '1') DEĞİL
    await db
      .promise()
      .query(
        "INSERT INTO verification_codes (phone, code, purpose, expires_at, restaurant_id) VALUES (?, ?, ?, ?, ?)",
        [
          normalizedPhone,
          verificationCode,
          "staff_login",
          expiresAt,
          staff.restaurant_id,
        ]
      );

    // Restoran adını DB'den çek (SMS'te kullanmak için)
    const [restaurantRows] = await db.promise().query(
      'SELECT name FROM restaurants WHERE id = ? LIMIT 1',
      [staff.restaurant_id]
    );
    const restaurantName = restaurantRows.length > 0 ? restaurantRows[0].name : 'Kutyemek';

    const message = `${verificationCode} ${restaurantName} giriş doğrulama kodunuzdur.\n@${config.WEB_OTP_DOMAIN} #${verificationCode}`;

    try {
      const smsSent = await smsService.sendSMS(normalizedPhone, message);
      if (!smsSent) {
        console.warn(
          `[StaffLogin] SMS gönderilemedi (${normalizedPhone}), kod: ${verificationCode}`
        );
      } else {
        console.log(
          `[StaffLogin] SMS başarıyla gönderildi → ${normalizedPhone}`
        );
      }
    } catch (smsErr) {
      console.error("[StaffLogin] SMS gönderim hatası:", smsErr.message);
      // SMS hatasında isteği durdurmuyoruz — log'dan kod okunabilir (development)
    }

    // Geliştirme ortamında kodu loglara da yaz
    console.log(
      `[StaffLogin][DEV] Telefon: ${normalizedPhone}, OTP: ${verificationCode}`
    );

    return res.json({
      message: "Doğrulama kodu gönderildi.",
    });
  } catch (err) {
    console.error("[StaffLogin] Hata:", err);
    return res.status(500).json({ error: "Giriş işlemi sırasında hata oluştu." });
  }
};


/**
 * Adım 2: POST /api/staff/verify-login
 * - OTP kodunu verification_codes tablosunda doğrular
 * - Başarılıysa JWT token üretir (staff.restaurant_id ile — req.restaurant_id DEĞİL)
 * - last_login_date günceller
 */
const verifyStaffLogin = async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: "Telefon ve kod zorunludur." });
  }

  const cleanPhone = (phone || "").replace(/\D/g, "");
  const normalizedPhone = cleanPhone.startsWith("0")
    ? cleanPhone.substring(1)
    : cleanPhone;

  try {
    // --- Staff'ı bul (yine global, restaurant_id'den bağımsız) ---
    // Hem 05li hem de 5li format destekleniyor
    const phoneWith0 = normalizedPhone.startsWith('5') ? '0' + normalizedPhone : normalizedPhone;
    const phoneWithout0 = normalizedPhone.startsWith('0') ? normalizedPhone.substring(1) : normalizedPhone;
    const [staffResults] = await db
      .promise()
      .query(
        "SELECT * FROM staff WHERE (phone = ? OR phone = ?) AND status = 'active' LIMIT 1",
        [phoneWith0, phoneWithout0]
      );

    if (staffResults.length === 0) {
      return res.status(401).json({ error: "Hesap bulunamadı." });
    }

    const staff = staffResults[0];

    // --- OTP kodunu doğrula ---
    // staff.restaurant_id ile eşleştiriyoruz — req.restaurant_id (hardcoded '1') DEĞİL
    const [codeResults] = await db.promise().query(
      `SELECT * FROM verification_codes 
       WHERE phone = ? AND code = ? AND purpose = 'staff_login' 
         AND used = 0 AND expires_at > ? AND restaurant_id = ?
       LIMIT 1`,
      [normalizedPhone, code, moment().toDate(), staff.restaurant_id]
    );

    if (codeResults.length === 0) {
      return res
        .status(400)
        .json({ error: "Geçersiz veya süresi dolmuş doğrulama kodu." });
    }

    // --- Kodu kullanıldı olarak işaretle ---
    await db
      .promise()
      .query(
        "UPDATE verification_codes SET used = 1 WHERE id = ?",
        [codeResults[0].id]
      );

    // --- last_login_date güncelle ---
    await db
      .promise()
      .query(
        "UPDATE staff SET last_login_date = ? WHERE id = ? AND restaurant_id = ?",
        [moment().toDate(), staff.id, staff.restaurant_id]
      );

    // --- JWT üret ---
    // restaurant_id olarak staff.restaurant_id kullanıyoruz — req.restaurant_id DEĞİL
    const token = jwt.sign(
      {
        id: staff.id,
        role: staff.role,
        isStaff: true,
        restaurant_id: staff.restaurant_id, // Gerçek restaurant_id (DB'den)
      },
      config.JWT_SECRET,
      { expiresIn: "8h" }
    );

    console.log(
      `[StaffLogin] Başarılı giriş: ${staff.full_name} (Restoran: ${staff.restaurant_id})`
    );

    return res.status(200).json({
      status: "success",
      message: "Giriş başarılı.",
      token,
      restaurant_id: staff.restaurant_id,
      staff: {
        id: staff.id,
        full_name: staff.full_name,
        email: staff.email,
        role: staff.role,
        restaurant_id: staff.restaurant_id,
      },
    });
  } catch (err) {
    console.error("[StaffVerify] Hata:", err);
    return res
      .status(500)
      .json({ error: "Doğrulama işlemi sırasında hata oluştu." });
  }
};

const getStaffProfile = (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(400).json({ error: "Authorization header eksik." });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res
      .status(400)
      .json({ error: "Token bulunamadı veya yanlış formatta." });
  }
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    console.log("Decoded token:", decoded);
    const query = `
              SELECT id, full_name, email, role
              FROM staff
              WHERE id = ? AND status = 'active' AND restaurant_id = ?
            `;
    db.query(query, [decoded.id, decoded.restaurant_id], (err, results) => {
      if (err) {
        console.error("Personel sorgulama hatası:", err);
        return res.status(500).json({ error: "Veritabanı hatası" });
      }
      if (results.length === 0) {
        return res.status(404).json({ error: "Personel bulunamadı." });
      }
      const staff = results[0];
      res.status(200).json(staff);
    });
  } catch (err) {
    console.error("Token doğrulama hatası:", err.message);
    return res
      .status(401)
      .json({ error: "Geçersiz veya süresi dolmuş token." });
  }
};

module.exports = {
  loginStaff,
  verifyStaffLogin,
  getStaffProfile,
};