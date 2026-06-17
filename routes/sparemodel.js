const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, sanitizeBody } = require("../helpers/sanitize");

router.post("/new", (req, res) => {
console.log("REQ BODY:", req.body);
  const s = sanitizeBody(req.body);

  if (!s.spare_name) {
    return res.status(400).json({ message: "Spare name is required" });
  }
  const sql = `
    INSERT INTO sparedata
    (spare_name, hsn_number)
    VALUES (?, ?)
  `;

    db.query(
    sql,[s.spare_name, emptyToNull(s.hsn_number)],
     (err, result) => {
      if (err) {
        console.error("DB ERROR:", err);
        return res.status(500).json({ message: "Insert failed" });
      }
      res.json({ success: true, id: result.insertId });
     })
});


// Get all PCB models
router.get("/all", (req, res) => {
  const sql = "SELECT * FROM sparedata";


db.query(sql, (err, results) => {
  if (err) {
    console.error("DB ERROR:", err);
    return res.status(500).json({ message: "Failed to fetch PCB models" });
  }
  res.json(results);
});
});

// Update PCB model
router.put("/update/:id", (req, res) => {
  const { id } = req.params;
  const s = sanitizeBody(req.body);

  if (!s.spare_name) {
    return res.status(400).json({ message: "Spare name is required" });
  }

  const sql = `
    UPDATE sparedata
    SET spare_name = ?, hsn_number = ?
    WHERE id = ?
  `;

  db.query(sql, [s.spare_name, emptyToNull(s.hsn_number), id], (err) => {
    if (err) {
      console.error("DB ERROR:", err);
      return res.status(500).json({ message: "Update failed" });
    }
    res.json({ success: true });
  });
});

// Delete PCB model
router.delete("/delete/:id", (req, res) => {
  const { id } = req.params;
  const sql = "DELETE FROM sparedata WHERE id = ?";
  db.query(sql, [id], (err) => {
    if (err) {
      console.error("DB ERROR:", err);
      return res.status(500).json({ message: "Delete failed" });
    }   

    res.json({ success: true });
  });
});


// search PCB model

router.get("/search/:key", (req, res) => {
  const { key } = req.params;
  const sql = "SELECT * FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ?";
  db.query(sql, [`%${key}%`, `%${key}%`], (err, results) => {
    if (err) {
      console.error("DB ERROR:", err);
      return res.status(500).json({ message: "Search failed" });
    }
    res.json(results);
  });
});

module.exports = router;

