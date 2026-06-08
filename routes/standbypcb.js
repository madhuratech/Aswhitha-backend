const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Self-migration: ensure standby_pcb table exists on startup
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS standby_pcb (
        id INT AUTO_INCREMENT PRIMARY KEY,
        standby_no VARCHAR(100) UNIQUE NOT NULL,
        pcb_code VARCHAR(100) NOT NULL,
        pcb_name VARCHAR(255) NOT NULL,
        pcb_model VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        service_dc_no VARCHAR(100),
        inward_dc_no VARCHAR(100),
        allocated_date DATE NOT NULL,
        expected_return_date DATE,
        status VARCHAR(100) NOT NULL,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log("Standby PCB table validated/created successfully");
  } catch (err) {
    console.error("Error creating standby_pcb table:", err.message);
  }
})();

// Helper to generate next sequential Standby Number
async function generateNextNo() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM standby_pcb"
  );
  const nextId = (rows[0].lastId || 0) + 1;
  return `STBY-${String(nextId).padStart(3, "0")}`;
}

// Route to get the next auto-generated standby number
router.get("/next-no", async (req, res) => {
  try {
    const nextNo = await generateNextNo();
    res.json({ nextNo });
  } catch (err) {
    console.error("Error generating next standby number:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Search route
router.get("/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      `SELECT * FROM standby_pcb 
       WHERE standby_no LIKE ? OR customer_name LIKE ? OR pcb_code LIKE ? OR pcb_name LIKE ? 
       ORDER BY id DESC LIMIT 50`,
      [searchTerm, searchTerm, searchTerm, searchTerm]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error searching standby PCB:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all entries
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM standby_pcb ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching all standby entries:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single entry details
router.get("/:standbyNo", async (req, res) => {
  const { standbyNo } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM standby_pcb WHERE standby_no = ?",
      [standbyNo]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Standby PCB entry not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching standby PCB details:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create new Standby PCB entry
router.post("/new", async (req, res) => {
  try {
    const {
      pcb_code,
      pcb_name,
      pcb_model,
      quantity,
      customer_name,
      service_dc_no,
      inward_dc_no,
      allocated_date,
      expected_return_date,
      status,
      remarks
    } = req.body;

    if (!pcb_code || !pcb_name || !pcb_model || quantity === undefined || !customer_name || !allocated_date || !status) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    const standby_no = await generateNextNo();

    const parsedReturnDate = expected_return_date === "" ? null : expected_return_date;

    const [result] = await db.promise().query(
      `INSERT INTO standby_pcb (
        standby_no, pcb_code, pcb_name, pcb_model, quantity, customer_name,
        service_dc_no, inward_dc_no, allocated_date, expected_return_date,
        status, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        standby_no,
        pcb_code,
        pcb_name,
        pcb_model,
        parseInt(quantity),
        customer_name,
        service_dc_no,
        inward_dc_no,
        allocated_date,
        parsedReturnDate,
        status,
        remarks
      ]
    );

    res.json({ success: true, id: result.insertId, standby_no });
  } catch (err) {
    console.error("Error saving Standby PCB entry:", err);
    res.status(500).json({ message: "Failed to save Standby PCB entry." });
  }
});

// Update Standby PCB entry
router.put("/:standbyNo", async (req, res) => {
  const { standbyNo } = req.params;
  try {
    const {
      pcb_code,
      pcb_name,
      pcb_model,
      quantity,
      customer_name,
      service_dc_no,
      inward_dc_no,
      allocated_date,
      expected_return_date,
      status,
      remarks
    } = req.body;

    if (!pcb_code || !pcb_name || !pcb_model || quantity === undefined || !customer_name || !allocated_date || !status) {
      return res.status(400).json({ message: "Required fields are missing." });
    }

    const parsedReturnDate = expected_return_date === "" ? null : expected_return_date;

    await db.promise().query(
      `UPDATE standby_pcb SET 
        pcb_code = ?, pcb_name = ?, pcb_model = ?, quantity = ?, customer_name = ?,
        service_dc_no = ?, inward_dc_no = ?, allocated_date = ?, expected_return_date = ?,
        status = ?, remarks = ?
      WHERE standby_no = ?`,
      [
        pcb_code,
        pcb_name,
        pcb_model,
        parseInt(quantity),
        customer_name,
        service_dc_no,
        inward_dc_no,
        allocated_date,
        parsedReturnDate,
        status,
        remarks,
        standbyNo
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error updating Standby PCB entry:", err);
    res.status(500).json({ message: "Failed to update Standby PCB entry." });
  }
});

// Delete Standby PCB entry
router.delete("/:standbyNo", async (req, res) => {
  const { standbyNo } = req.params;
  try {
    await db.promise().query(
      "DELETE FROM standby_pcb WHERE standby_no = ?",
      [standbyNo]
    );
    res.json({ success: true, message: "Standby PCB entry deleted successfully" });
  } catch (err) {
    console.error("Error deleting Standby PCB entry:", err);
    res.status(500).json({ message: "Failed to delete Standby PCB entry" });
  }
});

// Reports filter route
router.get("/report/filters", async (req, res) => {
  try {
    const { fromDate, toDate, customerName, pcbCode, status, reportType } = req.query;
    let query = "SELECT * FROM standby_pcb WHERE 1=1";
    let values = [];

    if (fromDate && toDate) {
      query += " AND allocated_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (customerName) {
      query += " AND customer_name = ?";
      values.push(customerName);
    }

    if (pcbCode) {
      query += " AND pcb_code = ?";
      values.push(pcbCode);
    }

    if (status) {
      query += " AND status = ?";
      values.push(status);
    }

    // Dynamic filters based on Report types
    if (reportType === "allocated") {
      query += " AND status IN ('Allocated', 'Installed')";
    } else if (reportType === "returned") {
      query += " AND status = 'Returned'";
    } else if (reportType === "available") {
      query += " AND status = 'Available'";
    }

    query += " ORDER BY allocated_date DESC, id DESC";

    const [rows] = await db.promise().query(query, values);
    res.json(rows);
  } catch (err) {
    console.error("Error running Standby PCB filters query:", err);
    res.status(500).json({ error: "Failed to run report query" });
  }
});

module.exports = router;
