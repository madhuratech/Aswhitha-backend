const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Self-migration: ensure scrap_pcb table exists on startup
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS scrap_pcb (
        id INT AUTO_INCREMENT PRIMARY KEY,
        scrap_no VARCHAR(100) UNIQUE NOT NULL,
        pcb_code VARCHAR(100) NOT NULL,
        pcb_name VARCHAR(255) NOT NULL,
        pcb_model VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        damage_date DATE NOT NULL,
        damage_type VARCHAR(100) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        source VARCHAR(100) NOT NULL,
        scrap_value DECIMAL(10,2) NOT NULL,
        approved_by VARCHAR(255) NOT NULL,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log("Scrap PCB table validated/created successfully");
  } catch (err) {
    console.error("Error creating scrap_pcb table:", err.message);
  }
})();

// Helper to generate next sequential Scrap Number
async function generateNextSno() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM scrap_pcb"
  );
  const nextId = (rows[0].lastId || 0) + 1;
  return `SCRP-${String(nextId).padStart(3, "0")}`;
}

// Route to get the next auto-generated scrap number
router.get("/next-sno", async (req, res) => {
  try {
    const nextSno = await generateNextSno();
    res.json({ nextSno });
  } catch (err) {
    console.error("Error generating next scrap number:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Search route
router.get("/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      `SELECT * FROM scrap_pcb 
       WHERE scrap_no LIKE ? OR pcb_code LIKE ? OR pcb_name LIKE ? OR source LIKE ? OR damage_type LIKE ?
       ORDER BY id DESC LIMIT 50`,
      [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error searching scrap PCB:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all entries
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM scrap_pcb ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching all scrap entries:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single entry details
router.get("/:scrapNo", async (req, res) => {
  const { scrapNo } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM scrap_pcb WHERE scrap_no = ?",
      [scrapNo]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Scrap PCB entry not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching scrap PCB details:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create new Scrap PCB entry
router.post("/new", async (req, res) => {
  try {
    const {
      pcb_code,
      pcb_name,
      pcb_model,
      quantity,
      damage_date,
      damage_type,
      reason,
      source,
      scrap_value,
      approved_by,
      remarks
    } = req.body;

    if (!pcb_code || !pcb_name || !pcb_model || quantity === undefined || !damage_date || !damage_type || !reason || !source || scrap_value === undefined || !approved_by) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    const scrap_no = await generateNextSno();

    const [result] = await db.promise().query(
      `INSERT INTO scrap_pcb (
        scrap_no, pcb_code, pcb_name, pcb_model, quantity, damage_date,
        damage_type, reason, source, scrap_value, approved_by, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scrap_no,
        pcb_code,
        pcb_name,
        pcb_model,
        parseInt(quantity),
        damage_date,
        damage_type,
        reason,
        source,
        parseFloat(scrap_value),
        approved_by,
        remarks
      ]
    );

    res.json({ success: true, id: result.insertId, scrap_no });
  } catch (err) {
    console.error("Error saving Scrap PCB entry:", err);
    res.status(500).json({ message: "Failed to save Scrap PCB entry." });
  }
});

// Update Scrap PCB entry
router.put("/:scrapNo", async (req, res) => {
  const { scrapNo } = req.params;
  try {
    const {
      pcb_code,
      pcb_name,
      pcb_model,
      quantity,
      damage_date,
      damage_type,
      reason,
      source,
      scrap_value,
      approved_by,
      remarks
    } = req.body;

    if (!pcb_code || !pcb_name || !pcb_model || quantity === undefined || !damage_date || !damage_type || !reason || !source || scrap_value === undefined || !approved_by) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    await db.promise().query(
      `UPDATE scrap_pcb SET 
        pcb_code = ?, pcb_name = ?, pcb_model = ?, quantity = ?, damage_date = ?,
        damage_type = ?, reason = ?, source = ?, scrap_value = ?, approved_by = ?, remarks = ?
      WHERE scrap_no = ?`,
      [
        pcb_code,
        pcb_name,
        pcb_model,
        parseInt(quantity),
        damage_date,
        damage_type,
        reason,
        source,
        parseFloat(scrap_value),
        approved_by,
        remarks,
        scrapNo
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating Scrap PCB entry:", err);
    res.status(500).json({ message: "Failed to update Scrap PCB entry." });
  }
});

// Delete Scrap PCB entry
router.delete("/:scrapNo", async (req, res) => {
  const { scrapNo } = req.params;
  try {
    await db.promise().query(
      "DELETE FROM scrap_pcb WHERE scrap_no = ?",
      [scrapNo]
    );
    res.json({ success: true, message: "Scrap PCB entry deleted successfully" });
  } catch (err) {
    console.error("Error deleting Scrap PCB entry:", err);
    res.status(500).json({ message: "Failed to delete Scrap PCB entry" });
  }
});

module.exports = router;
