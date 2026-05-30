const express = require("express");
const router = express.Router();
const db = require("../config/database");

router.post("/new", (req, res) => {
  const { item_name, hsn_number } = req.body;
    console.log("REQ BODY:", req.body); 

    if(!item_name || !hsn_number) {
        return res.status(400).json({ message: "Required fields missing" });
    }
    const sql = `
    INSERT INTO purchaseitems
    (item_name, hsn_number)
    VALUES (?, ?)
  `;
    db.query(sql, [item_name, hsn_number], (err, result) => {
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Insert failed" });
        }
        res.json({ success: true, item_id: result.insertId });
    });
});

// Get all purchase items

router.get("/all", (req, res) => {
    const sql = "SELECT * FROM purchaseitems";
    db.query(sql, (err, results) => {   
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Failed to fetch purchase items" });
        }  
            res.json(results);
 
    });
});

// Update purchase item

router.put("/update/:id", (req, res) => {
    const { id } = req.params;
    const { item_name, hsn_number } = req.body;


    const sql = `
        UPDATE purchaseitems
        SET item_name = ?, hsn_number = ?
        WHERE id = ?
    `;
    db.query(sql, [item_name, hsn_number, id], (err, result) => {
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Update failed" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Purchase item not found" });
        }
        res.json({ success: true, message: "Purchase item updated successfully" });
    });
});

// Delete purchase item

router.delete("/delete/:id", (req, res) => {
    const { id } = req.params;

    const sql = "DELETE FROM purchaseitems WHERE id = ?";
    db.query(sql, [id], (err, result) => {
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Delete failed" });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Purchase item not found" });
        }
        res.json({ success: true, message: "Purchase item deleted successfully" });
    });
});


// Search purchase items

router.get("/search/:key", (req, res) => {
  const { key } = req.params;
  const sql = "SELECT * FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ?";
  db.query(sql, [`%${key}%`, `%${key}%`], (err, results) => {
    if (err) {
      console.error("DB ERROR:", err);
      return res.status(500).json({ message: "Search failed" });
    }
    res.json(results);
  });
});
module.exports = router;