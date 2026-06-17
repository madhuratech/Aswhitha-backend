const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Self-migration: ensure job_dc tables exist and have description column
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS job_dc_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_dc_no VARCHAR(100) UNIQUE NOT NULL,
        dc_date DATE NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        is_returnable VARCHAR(50) DEFAULT 'No',
        despatch_through VARCHAR(100),
        purpose VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS job_dc_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_dc_id INT NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        uom VARCHAR(50),
        remarks TEXT,
        despatch_qty INT DEFAULT 0,
        pending_qty INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Safety check: ensure description column exists in job_dc_items
    await db.promise().query(
      "ALTER TABLE job_dc_items ADD COLUMN description TEXT DEFAULT NULL"
    ).catch(() => {});

    // Safety check: ensure despatch_qty column exists in job_dc_items
    await db.promise().query(
      "ALTER TABLE job_dc_items ADD COLUMN despatch_qty INT DEFAULT 0"
    ).catch(() => {});

    // Safety check: ensure pending_qty column exists in job_dc_items
    await db.promise().query(
      "ALTER TABLE job_dc_items ADD COLUMN pending_qty INT DEFAULT 0"
    ).catch(() => {});

    // Safety check: ensure order_type column exists in job_dc_entries
    await db.promise().query(
      "ALTER TABLE job_dc_entries ADD COLUMN order_type VARCHAR(50) DEFAULT 'Service'"
    ).catch(() => {});

    // Ensure per-item client DC columns exist
    await db.promise().query(
      "ALTER TABLE job_dc_items ADD COLUMN client_dc_no VARCHAR(100) NULL"
    ).catch(() => {});
    await db.promise().query(
      "ALTER TABLE job_dc_items ADD COLUMN client_dc_date DATE NULL"
    ).catch(() => {});

    // Ensure serial_no column exists
    await db.promise().query(
      "ALTER TABLE job_dc_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});

    console.log("Job DC tables validated/created successfully");
  } catch (err) {
    console.error("Error creating/migrating Job DC tables:", err.message);
  }
})();

// Auto-generate next Job DC number
router.get("/next-dc-no", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT MAX(id) AS lastId FROM job_dc_entries");
    const nextId = (rows[0].lastId || 0) + 1;
    res.json({ dc_no: `AT/JBDC-${nextId.toString().padStart(3, "0")}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search Job DC entries by auto-generated DC number
router.get("/DC/search", async (req, res) => {
  try {
    const { q } = req.query;
    const [rows] = await db.promise().query(
      "SELECT job_dc_no AS dc_number FROM job_dc_entries WHERE job_dc_no LIKE ? ORDER BY id DESC LIMIT 20",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Search Failed" });
  }
});

// Create new Job DC Entry
router.post("/createdc", async (req, res) => {
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const [result] = await db.promise().query(
      `INSERT INTO job_dc_entries
      (job_dc_no, dc_date, customer_name, is_returnable, despatch_through,order_no, order_date, purpose, order_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        s.job_dc_no,
        emptyToNull(s.dc_date),
        s.customer_name,
        s.is_returnable || "No",
        emptyToNull(s.order_no),
        emptyToNull(s.order_date),
        emptyToNull(s.despatch_through),
        emptyToNull(s.purpose),
        s.order_type || "Service"
      ]
    );

    const newDcEntryId = result.insertId;

    for (const item of items) {
      const qty = toNum(item.quantity, 1);
      await db.promise().query(
        `INSERT INTO job_dc_items
        (job_dc_id, item_name, quantity, uom, remarks, hsn, despatch_qty, pending_qty, order_no, order_date, serial_no)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          newDcEntryId,
          item.item_name,
          qty,
          emptyToNull(item.uom || "NOS"),
          emptyToNull(item.remarks),
          emptyToNull(item.hsn),
          qty,
          emptyToNull(item.client_dc_no),
          emptyToNull(item.client_dc_date),
          emptyToNull(item.serial_no)
        ]
      );
    }

    res.status(201).json({ message: "Job DC Entry created successfully", job_dc_no: s.job_dc_no });

  } catch (error) {
    console.error("Error creating Job DC Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Update Edit Job DC Entry
router.put("/updatedc/:id", async (req, res) => {
  try {
    const dcId = req.params.id;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    await db.promise().query(
      `UPDATE job_dc_entries
       SET job_dc_no=?, dc_date=?, customer_name=?, is_returnable=?,
           despatch_through=?, purpose=?, order_type=?
       WHERE id=?`,
      [
        s.job_dc_no,
        emptyToNull(s.dc_date),
        s.customer_name,
        s.is_returnable || "No",
        emptyToNull(s.despatch_through),
        emptyToNull(s.purpose),
        s.order_type || "Service",
        dcId
      ]
    );

    // Keep existing items' despatch quantities if names match, to preserve returned quantities!
    const [existingItems] = await db.promise().query(
      "SELECT item_name, despatch_qty FROM job_dc_items WHERE job_dc_id=?",
      [dcId]
    );
    const despatchMap = {};
    existingItems.forEach(row => {
      despatchMap[row.item_name] = row.despatch_qty;
    });

    // Delete existing items
    await db.promise().query("DELETE FROM job_dc_items WHERE job_dc_id=?", [dcId]);

    // Insert updated items
    for (const item of items) {
      const qty = toNum(item.quantity, 1);
      const prevDespatch = despatchMap[item.item_name] || 0;
      const finalDespatch = prevDespatch > qty ? qty : prevDespatch;
      const finalPending = qty - finalDespatch;

      await db.promise().query(
        `INSERT INTO job_dc_items
        (job_dc_id, item_name, quantity, uom, remarks, hsn, despatch_qty, pending_qty, client_dc_no, client_dc_date, serial_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dcId,
          item.item_name,
          qty,
          emptyToNull(item.uom || "NOS"),
          emptyToNull(item.remarks),
          emptyToNull(item.hsn),
          finalDespatch,
          finalPending,
          emptyToNull(item.client_dc_no),
          emptyToNull(item.client_dc_date),
          emptyToNull(item.serial_no)
        ]
      );
    }

    res.json({ message: "Job DC Entry updated successfully" });
  } catch (error) {
    console.error("Error updating Job DC Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Fetch Single Job DC for Edit
router.get("/editdc/:job_dc_no", async (req, res) => {
  try {
    const { job_dc_no } = req.params;
    const [rows] = await db.promise().query(
      "SELECT * FROM job_dc_entries WHERE job_dc_no = ?",
      [job_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Job DC not found" });
    }

    const dcEntry = rows[0];

    const [items] = await db.promise().query(
      "SELECT * FROM job_dc_items WHERE job_dc_id = ? ORDER BY id ASC",
      [dcEntry.id]
    );

    res.json({
      header: dcEntry,
      items
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Get Full Details for Print
router.get("/full/:job_dc_no", async (req, res) => {
  const { job_dc_no } = req.params;
  try {
    const [dcRows] = await db.promise().query(
      `SELECT * FROM job_dc_entries WHERE job_dc_no = ?`,
      [job_dc_no]
    );

    if (dcRows.length === 0) {
      return res.status(404).json({ message: "Job DC not found" });
    }

    const dcEntry = dcRows[0];

    const [items] = await db.promise().query(
      `SELECT * FROM job_dc_items WHERE job_dc_id = ? ORDER BY id ASC`,
      [dcEntry.id]
    );

    const [clientRows] = await db.promise().query(
      `SELECT * FROM newclient WHERE customer_name = ?`,
      [dcEntry.customer_name]
    );

    // Aggregate unique client DC nos and dates from item level
    const seenNos = new Set(), seenDates = new Set();
    const uniqueDcNos = [], uniqueDcDates = [];
    for (const item of items) {
      if (item.client_dc_no && !seenNos.has(item.client_dc_no)) {
        seenNos.add(item.client_dc_no);
        uniqueDcNos.push(item.client_dc_no);
      }
      if (item.client_dc_date) {
        const d = new Date(item.client_dc_date).toISOString().split('T')[0];
        if (!seenDates.has(d)) { seenDates.add(d); uniqueDcDates.push(d); }
      }
    }

    res.json({
      ...dcEntry,
      items: items || [],
      client: clientRows[0] || {},
      aggregated_client_dc_no: uniqueDcNos.join(','),
      aggregated_client_dc_date: uniqueDcDates.join(',')
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Delete Job DC
router.delete("/deletedc/:job_dc_no", async (req, res) => {
  try {
    const { job_dc_no } = req.params;
    const [rows] = await db.promise().query(
      "SELECT id FROM job_dc_entries WHERE job_dc_no = ?",
      [job_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Job DC not found" });
    }

    const dcEntryId = rows[0].id;

    // Delete items
    await db.promise().query("DELETE FROM job_dc_items WHERE job_dc_id = ?", [dcEntryId]);

    // Delete main entry
    await db.promise().query("DELETE FROM job_dc_entries WHERE id = ?", [dcEntryId]);

    res.json({ message: "Job DC Entry deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Fetch All Job DC Data
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM job_dc_entries ORDER BY id DESC"
    );

    for (const row of rows) {
      const [items] = await db.promise().query(
        "SELECT * FROM job_dc_items WHERE job_dc_id = ? ORDER BY id ASC",
        [row.id]
      );
      row.items = items;
    }

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Job Pending Details Report Filter
router.get("/report/filters", async (req, res) => {
  try {
    const { fromDate, toDate, customerName, dcNo } = req.query;

    let query = `
      SELECT 
        jde.customer_name AS name,
        jde.job_dc_no AS dc_no,
        jde.dc_date AS dc_date,
        jdi.item_name,
        jdi.quantity AS order_qty,
        jdi.despatch_qty,
        jdi.pending_qty
      FROM job_dc_entries jde
      JOIN job_dc_items jdi ON jde.id = jdi.job_dc_id
      WHERE jdi.pending_qty > 0
    `;

    let values = [];

    if (fromDate && toDate) {
      query += " AND jde.dc_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (dcNo) {
      query += " AND jde.job_dc_no = ?";
      values.push(dcNo);
    }

    if (customerName) {
      query += " AND jde.customer_name = ?";
      values.push(customerName);
    }

    query += " ORDER BY jde.id DESC, jdi.id ASC";

    const [rows] = await db.promise().query(query, values);
    res.json(rows);

  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});

module.exports = router;
