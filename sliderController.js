const db = require("../config/db");
const moment = require("moment");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ImageProcessor = require("../utils/imageProcessor");

// Dosya yükleme için multer ayarları
// Dosya yükleme için multer ayarları (Bellek üzerinden)
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const extname = filetypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error("Yalnızca JPEG, JPG, PNG ve WEBP dosyaları destekleniyor!"));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
}).single("image");

const resolveLink = (slider) => {
  if (!slider) return null;
  if (slider.link_type === "product" && slider.link_target_id) {
    return `/product/${slider.link_target_id}`;
  }
  if (slider.link_type === "coupon" && slider.link_target_id) {
    return `/campaign/${slider.link_target_id}`;
  }
  if (slider.link_type === "menu" && slider.link_target_id) {
    return `/menu/${slider.link_target_id}`;
  }
  return slider.link || null;
};

// Tüm sliderları getir (aktif/pasif dahil)
const getAllSliders = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const query = `
    SELECT
      id,
      title,
      image_url,
      order_number,
      link,
      link_type,
      link_target_id,
      active
    FROM
      sliders
    WHERE
      restaurant_id = ?
    ORDER BY
      order_number ASC
  `;

  db.query(query, [restaurant_id], (err, results) => {
    if (err) {
      console.error("Slider sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    const mapped = results.map((row) => ({
      ...row,
      resolved_link: resolveLink(row),
    }));

    res.status(200).json({
      status: "success",
      data: mapped
    });
  });
};

// Slider detayını getir
const getSliderById = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const sliderId = req.params.id;

  if (!sliderId) {
    return res.status(400).json({ error: "Slider ID gereklidir" });
  }

  const query = `
    SELECT
      id,
      title,
      image_url,
      order_number,
      link,
      link_type,
      link_target_id,
      active
    FROM
      sliders
    WHERE
      id = ? AND restaurant_id = ?
  `;

  db.query(query, [sliderId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Slider sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Slider bulunamadı" });
    }

    const row = results[0];
    res.status(200).json({
      status: "success",
      data: {
        ...row,
        resolved_link: resolveLink(row),
      }
    });
  });
};

// Slider oluştur
const createSlider = (req, res) => {
  const restaurant_id = req.restaurant_id || "unknown";
  upload(req, res, async (err) => {
    if (err) {
      console.error("Dosya yükleme hatası:", err);
      return res.status(400).json({ error: err.message || "Dosya yükleme hatası." });
    }

    const { title, link, link_type = "custom", link_target_id, order_number = 0, active = 1 } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Başlık zorunludur" });
    }

    if (!req.file && !req.body.image_url) {
      return res.status(400).json({ error: "Resim zorunludur" });
    }

    let image_url = null;

    if (req.file) {
      // Resmi işleyip kaydet
      try {
        const processedBuffer = await ImageProcessor.processSliderImage(req.file.buffer);
        const uploadDir = path.join(__dirname, `../uploads/${restaurant_id}/sliders/`);
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filename = Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webp";
        const targetPath = path.join(uploadDir, filename);

        fs.writeFileSync(targetPath, processedBuffer);

        // Dosya izinlerini ayarla (Herkes okuyabilir - 644)
        try {
          fs.chmodSync(targetPath, 0o644);
        } catch (permErr) {
          console.error("Dosya izni ayarlanamadı:", permErr);
        }

        image_url = `/uploads/${restaurant_id}/sliders/${filename}`;
      } catch (processError) {
        console.error("Slider resmi işleme hatası:", processError);
        return res.status(500).json({ error: "Resim işlenirken hata oluştu" });
      }
    } else if (req.body.image_url && (req.body.image_url.startsWith('http://') || req.body.image_url.startsWith('https://'))) {
      try {
        const processedBuffer = await ImageProcessor.downloadAndProcessExternalImage(req.body.image_url, 'slider');
        const uploadDir = path.join(__dirname, `../uploads/${restaurant_id}/sliders/`);
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        const filename = Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webp";
        const targetPath = path.join(uploadDir, filename);
        fs.writeFileSync(targetPath, processedBuffer);
        try { fs.chmodSync(targetPath, 0o644); } catch (e) {}
        
        image_url = `/uploads/${restaurant_id}/sliders/${filename}`;
      } catch (extErr) {
        console.error("Dış slider resmi işleme hatası:", extErr);
        image_url = req.body.image_url;
      }
    } else {
      image_url = req.body.image_url;
    }

    const allowedTypes = ["custom", "product", "coupon", "menu"];
    if (!allowedTypes.includes(link_type)) {
      return res.status(400).json({ error: "Geçersiz link türü (custom/product/coupon/menu)" });
    }

    if (link_type !== "custom" && !link_target_id) {
      return res.status(400).json({ error: "Seçilen link türü için target_id zorunludur." });
    }

    // if (link_type === "custom" && !link) {
    //   return res.status(400).json({ error: "Özel link için URL zorunludur." });
    // }

    const query = `
      INSERT INTO sliders (
        title,
        image_url,
        order_number,
        link_type,
        link_target_id,
        link,
        active,
        restaurant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      title,
      image_url,
      order_number,
      link_type,
      link_target_id || null,
      link || null,
      active === "true" || active === true || active === "1" || active === 1 ? 1 : 0,
      restaurant_id
    ];

    db.query(query, values, (err, result) => {
      if (err) {
        console.error("Slider ekleme hatası:", err);
        return res.status(500).json({ error: "Slider eklenemedi: " + err.message });
      }

      res.status(201).json({
        status: "success",
        message: "Slider başarıyla eklendi",
        slider_id: result.insertId
      });
    });
  });
};

// Slider güncelle
const updateSlider = (req, res) => {
  const restaurant_id = req.restaurant_id || "unknown";
  upload(req, res, async (err) => {
    if (err) {
      console.error("Dosya yükleme hatası:", err);
      return res.status(400).json({ error: err.message || "Dosya yükleme hatası." });
    }

    const sliderId = req.params.id;

    if (!sliderId) {
      return res.status(400).json({ error: "Slider ID gereklidir" });
    }

    const { title, link, link_type, link_target_id, order_number, active } = req.body;

    // Önce mevcut slider'ı kontrol et
    db.query("SELECT * FROM sliders WHERE id = ? AND restaurant_id = ?", [sliderId, restaurant_id], async (err, results) => {
      if (err) {
        console.error("Slider sorgulama hatası:", err);
        return res.status(500).json({ error: "Veritabanı hatası" });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: "Slider bulunamadı" });
      }

      const existingSlider = results[0];
      let image_url = existingSlider.image_url;

      // Eğer yeni resim yüklendiyse
      if (req.file) {
        // Eski resmi silme işlemi (optional)
        if (existingSlider.image_url && existingSlider.image_url.startsWith('/uploads/')) {
          const oldImagePath = path.join(__dirname, '..', existingSlider.image_url);
          fs.unlink(oldImagePath, (err) => {
            if (err && err.code !== 'ENOENT') {
              console.error("Eski resim silinirken hata oluştu:", err);
            }
          });
        }

        try {
          const processedBuffer = await ImageProcessor.processSliderImage(req.file.buffer);
          const uploadDir = path.join(__dirname, `../uploads/${restaurant_id}/sliders/`);
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }

          const filename = Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webp";
          const targetPath = path.join(uploadDir, filename);

          fs.writeFileSync(targetPath, processedBuffer);

          // Yeni resim URL'ini ayarla
          image_url = `/uploads/${restaurant_id}/sliders/${filename}`;

          // Dosya izinlerini ayarla (Herkes okuyabilir - 644)
          try {
            fs.chmodSync(targetPath, 0o644);
          } catch (permErr) {
            console.error("Dosya izni ayarlanamadı:", permErr);
          }
        } catch (processError) {
          console.error("Slider resmi işleme hatası:", processError);
          return res.status(500).json({ error: "Resim işlenirken hata oluştu" });
        }
      } else if (req.body.image_url) {
        if (req.body.image_url.startsWith('http://') || req.body.image_url.startsWith('https://')) {
          try {
            const processedBuffer = await ImageProcessor.downloadAndProcessExternalImage(req.body.image_url, 'slider');
            const uploadDir = path.join(__dirname, `../uploads/${restaurant_id}/sliders/`);
            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }
            const filename = Date.now() + "-" + Math.round(Math.random() * 1e9) + ".webp";
            const targetPath = path.join(uploadDir, filename);
            fs.writeFileSync(targetPath, processedBuffer);
            try { fs.chmodSync(targetPath, 0o644); } catch (e) {}
            
            image_url = `/uploads/${restaurant_id}/sliders/${filename}`;
            
            // Eski resmi sil (varsa)
            if (existingSlider.image_url && existingSlider.image_url.startsWith('/uploads/')) {
              const oldImagePath = path.join(__dirname, "..", existingSlider.image_url);
              fs.unlink(oldImagePath, (err) => {});
            }
          } catch (extErr) {
            console.error("Dış slider resmi işleme hatası:", extErr);
            image_url = req.body.image_url;
          }
        } else {
          image_url = req.body.image_url;
        }
      }

      // Güncelleme sorgusu
      const query = `
        UPDATE sliders
        SET
          title = ?,
          image_url = ?,
          order_number = ?,
          link_type = ?,
          link_target_id = ?,
          link = ?,
          active = ?
        WHERE
          id = ? AND restaurant_id = ?
      `;

      const values = [
        title || existingSlider.title,
        image_url,
        order_number !== undefined ? order_number : existingSlider.order_number,
        link_type || existingSlider.link_type || "custom",
        link_target_id !== undefined ? (link_target_id === "" ? null : link_target_id) : existingSlider.link_target_id,
        link !== undefined ? (link === "" ? null : link) : existingSlider.link,
        active !== undefined ? (active === "true" || active === true || active === "1" || active === 1 ? 1 : 0) : existingSlider.active,
        sliderId,
        restaurant_id
      ];

      db.query(query, values, (err, result) => {
        if (err) {
          console.error("Slider güncelleme hatası:", err);
          return res.status(500).json({ error: "Slider güncellenemedi: " + err.message });
        }

        res.status(200).json({
          status: "success",
          message: "Slider başarıyla güncellendi"
        });
      });
    });
  });
};

// Slider sil
const deleteSlider = (req, res) => {
  const restaurant_id = req.restaurant_id;
  const sliderId = req.params.id;

  if (!sliderId) {
    return res.status(400).json({ error: "Slider ID gereklidir" });
  }

  // Önce mevcut slider'ı kontrol et
  db.query("SELECT * FROM sliders WHERE id = ? AND restaurant_id = ?", [sliderId, restaurant_id], (err, results) => {
    if (err) {
      console.error("Slider sorgulama hatası:", err);
      return res.status(500).json({ error: "Veritabanı hatası" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Slider bulunamadı" });
    }

    const existingSlider = results[0];

    // Slider'ı veritabanından sil
    db.query("DELETE FROM sliders WHERE id = ? AND restaurant_id = ?", [sliderId, restaurant_id], (err, result) => {
      if (err) {
        console.error("Slider silme hatası:", err);
        return res.status(500).json({ error: "Slider silinemedi: " + err.message });
      }

      // Resmi diskten sil (optional)
      if (existingSlider.image_url && existingSlider.image_url.startsWith('/uploads/')) {
        const imagePath = path.join(__dirname, '..', existingSlider.image_url);
        fs.unlink(imagePath, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.error("Resim silinirken hata oluştu:", err);
          }
        });
      }

      res.status(200).json({
        status: "success",
        message: "Slider başarıyla silindi"
      });
    });
  });
};

module.exports = {
  getAllSliders,
  getSliderById,
  createSlider,
  updateSlider,
  deleteSlider
};