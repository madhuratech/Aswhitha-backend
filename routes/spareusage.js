const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Self-migration: ensure spare_usage table exists on startup
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS spare_usage (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usage_no VARCHAR(100) UNIQUE NOT NULL,
        usage_date DATE NOT NULL,
        pcb_model VARCHAR(255) NOT NULL,
        job_batch_no VARCHAR(255) NOT NULL,
        spare_code VARCHAR(100) NOT NULL,
        spare_name VARCHAR(255) NOT NULL,
        quantity_used DECIMAL(10,2) NOT NULL,
        unit_cost DECIMAL(10,2) NOT NULL,
        total_cost DECIMAL(12,2) NOT NULL,
        employee_name VARCHAR(255) NOT NULL,
        department VARCHAR(255) NOT NULL,
        usage_type VARCHAR(100) NOT NULL,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log("Spare Usage table validated/created successfully");
  } catch (err) {
    console.error("Error creating spare_usage table:", err.message);
  }
})();

// Helper to generate next sequential Usage Number
async function generateNextSno() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM spare_usage"
  );
  const nextId = (rows[0].lastId || 0) + 1;
  return `USG-${String(nextId).padStart(3, "0")}`;
}

// Route to get the next auto-generated usage number
router.get("/next-sno", async (req, res) => {
  try {
    const nextSno = await generateNextSno();
    res.json({ nextSno });
  } catch (err) {
    console.error("Error generating next usage number:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Search route
router.get("/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      `SELECT * FROM spare_usage 
       WHERE usage_no LIKE ? OR pcb_model LIKE ? OR spare_code LIKE ? OR spare_name LIKE ? OR employee_name LIKE ? OR usage_type LIKE ?
       ORDER BY id DESC LIMIT 50`,
      [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error searching spare usage:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all entries
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM spare_usage ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching all spare usage entries:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single entry details
router.get("/:usageNo", async (req, res) => {
  const { usageNo } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM spare_usage WHERE usage_no = ?",
      [usageNo]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Spare Usage entry not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching spare usage details:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create new Spare Usage entry
router.post("/new", async (req, res) => {
  try {
    const {
      usage_date,
      pcb_model,
      job_batch_no,
      spare_code,
      spare_name,
      quantity_used,
      unit_cost,
      employee_name,
      department,
      usage_type,
      remarks
    } = req.body;

    if (!usage_date || !pcb_model || !job_batch_no || !spare_code || !spare_name || quantity_used === undefined || unit_cost === undefined || !employee_name || !department || !usage_type) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    const usage_no = await generateNextSno();
    const total_cost = parseFloat(quantity_used) * parseFloat(unit_cost);

    const [result] = await db.promise().query(
      `INSERT INTO spare_usage (
        usage_no, usage_date, pcb_model, job_batch_no, spare_code, spare_name,
        quantity_used, unit_cost, total_cost, employee_name, department, usage_type, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        usage_no,
        usage_date,
        pcb_model,
        job_batch_no,
        spare_code,
        spare_name,
        parseFloat(quantity_used),
        parseFloat(unit_cost),
        total_cost,
        employee_name,
        department,
        usage_type,
        remarks || null
      ]
    );

    res.json({ success: true, id: result.insertId, usage_no });
  } catch (err) {
    console.error("Error saving Spare Usage entry:", err);
    res.status(500).json({ message: "Failed to save Spare Usage entry." });
  }
});

// Update Spare Usage entry
router.put("/:usageNo", async (req, res) => {
  const { usageNo } = req.params;
  try {
    const {
      usage_date,
      pcb_model,
      job_batch_no,
      spare_code,
      spare_name,
      quantity_used,
      unit_cost,
      employee_name,
      department,
      usage_type,
      remarks
    } = req.body;

    if (!usage_date || !pcb_model || !job_batch_no || !spare_code || !spare_name || quantity_used === undefined || unit_cost === undefined || !employee_name || !department || !usage_type) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    const total_cost = parseFloat(quantity_used) * parseFloat(unit_cost);

    await db.promise().query(
      `UPDATE spare_usage SET 
        usage_date = ?, pcb_model = ?, job_batch_no = ?, spare_code = ?, spare_name = ?,
        quantity_used = ?, unit_cost = ?, total_cost = ?, employee_name = ?, department = ?, usage_type = ?, remarks = ?
      WHERE usage_no = ?`,
      [
        usage_date,
        pcb_model,
        job_batch_no,
        spare_code,
        spare_name,
        parseFloat(quantity_used),
        parseFloat(unit_cost),
        total_cost,
        employee_name,
        department,
        usage_type,
        remarks || null,
        usageNo
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating Spare Usage entry:", err);
    res.status(500).json({ message: "Failed to update Spare Usage entry." });
  }
});

// Delete Spare Usage entry
router.delete("/:usageNo", async (req, res) => {
  const { usageNo } = req.params;
  try {
    await db.promise().query(
      "DELETE FROM spare_usage WHERE usage_no = ?",
      [usageNo]
    );
    res.json({ success: true, message: "Spare Usage entry deleted successfully" });
  } catch (err) {
    console.error("Error deleting Spare Usage entry:", err);
    res.status(500).json({ message: "Failed to delete Spare Usage entry" });
  }
});

module.exports = router;
