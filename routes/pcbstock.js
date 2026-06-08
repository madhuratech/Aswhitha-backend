const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Self-migration: ensure database table exists on startup
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS pcb_stock (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pcb_code VARCHAR(100) UNIQUE NOT NULL,
        pcb_name VARCHAR(255) NOT NULL,
        pcb_model VARCHAR(255) NOT NULL,
        pcb_category VARCHAR(100) NOT NULL,
        supplier_name VARCHAR(255) NOT NULL,
        purchase_invoice_no VARCHAR(100) NOT NULL,
        purchase_date DATE NOT NULL,
        quantity_received DECIMAL(10,2) NOT NULL,
        available_quantity DECIMAL(10,2) NOT NULL,
        minimum_stock_level DECIMAL(10,2) NOT NULL,
        unit_cost DECIMAL(10,2) NOT NULL,
        stock_value DECIMAL(12,2) NOT NULL,
        rack_location VARCHAR(255),
        status VARCHAR(100) NOT NULL,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log("PCB Stock simplified table validated/created successfully");
  } catch (err) {
    console.error("Error creating pcb_stock table:", err.message);
  }
})();

// Helper function to generate next PCB Code
async function generateNextCode() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM pcb_stock"
  );
  const nextId = (rows[0].lastId || 0) + 1;
  return `PCB-${String(nextId).padStart(3, "0")}`;
}

// Route to get the next auto-generated PCB code
router.get("/next-code", async (req, res) => {
  try {
    const nextCode = await generateNextCode();
    res.json({ nextCode });
  } catch (err) {
    console.error("Error generating next PCB Code:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Search route for loading entries
router.get("/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      "SELECT pcb_code, pcb_name FROM pcb_stock WHERE pcb_code LIKE ? OR pcb_name LIKE ? ORDER BY id DESC LIMIT 50",
      [searchTerm, searchTerm]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error searching PCB stock:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all entries
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM pcb_stock ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching all PCB Stock:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single entry details
router.get("/:pcbCode", async (req, res) => {
  const { pcbCode } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM pcb_stock WHERE pcb_code = ?",
      [pcbCode]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "PCB Stock entry not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching PCB stock details:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create new PCB Stock entry
router.post("/new", async (req, res) => {
  try {
    const {
      pcb_name,
      pcb_model,
      pcb_category,
      supplier_name,
      purchase_invoice_no,
      purchase_date,
      quantity_received,
      available_quantity,
      minimum_stock_level,
      unit_cost,
      stock_value,
      rack_location,
      status,
      remarks
    } = req.body;

    if (!pcb_name || !pcb_model || !pcb_category || !supplier_name || !purchase_invoice_no || !purchase_date || quantity_received === undefined || available_quantity === undefined || minimum_stock_level === undefined || !unit_cost || !status) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    const pcb_code = await generateNextCode();

    const [result] = await db.promise().query(
      `INSERT INTO pcb_stock (
        pcb_code, pcb_name, pcb_model, pcb_category, supplier_name, purchase_invoice_no,
        purchase_date, quantity_received, available_quantity, minimum_stock_level,
        unit_cost, stock_value, rack_location, status, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pcb_code,
        pcb_name,
        pcb_model,
        pcb_category,
        supplier_name,
        purchase_invoice_no,
        purchase_date,
        quantity_received,
        available_quantity,
        minimum_stock_level,
        unit_cost,
        stock_value,
        rack_location,
        status,
        remarks
      ]
    );

    res.json({ success: true, id: result.insertId, pcb_code });
  } catch (err) {
    console.error("Error saving PCB Stock entry:", err);
    res.status(500).json({ message: "Failed to save PCB Stock entry." });
  }
});

// Update PCB Stock entry
router.put("/:pcbCode", async (req, res) => {
  const { pcbCode } = req.params;
  try {
    const {
      pcb_name,
      pcb_model,
      pcb_category,
      supplier_name,
      purchase_invoice_no,
      purchase_date,
      quantity_received,
      available_quantity,
      minimum_stock_level,
      unit_cost,
      stock_value,
      rack_location,
      status,
      remarks
    } = req.body;

    if (!pcb_name || !pcb_model || !pcb_category || !supplier_name || !purchase_invoice_no || !purchase_date || quantity_received === undefined || available_quantity === undefined || minimum_stock_level === undefined || !unit_cost || !status) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    await db.promise().query(
      `UPDATE pcb_stock SET 
        pcb_name = ?, pcb_model = ?, pcb_category = ?, supplier_name = ?, purchase_invoice_no = ?,
        purchase_date = ?, quantity_received = ?, available_quantity = ?, minimum_stock_level = ?,
        unit_cost = ?, stock_value = ?, rack_location = ?, status = ?, remarks = ?
      WHERE pcb_code = ?`,
      [
        pcb_name,
        pcb_model,
        pcb_category,
        supplier_name,
        purchase_invoice_no,
        purchase_date,
        quantity_received,
        available_quantity,
        minimum_stock_level,
        unit_cost,
        stock_value,
        rack_location,
        status,
        remarks,
        pcbCode
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating PCB Stock entry:", err);
    res.status(500).json({ message: "Failed to update PCB Stock entry." });
  }
});

// Delete PCB Stock entry
router.delete("/:pcbCode", async (req, res) => {
  const { pcbCode } = req.params;
  try {
    await db.promise().query(
      "DELETE FROM pcb_stock WHERE pcb_code = ?",
      [pcbCode]
    );
    res.json({ success: true, message: "PCB Stock deleted successfully" });
  } catch (err) {
    console.error("Error deleting PCB Stock entry:", err);
    res.status(500).json({ message: "Failed to delete PCB Stock entry" });
  }
});

module.exports = router;
