const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Self-migration: ensure standby_dc tables exist
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS standby_dc_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        standby_dc_no VARCHAR(100) UNIQUE NOT NULL,
        dc_date DATE NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        order_no VARCHAR(100) NOT NULL,
        order_date VARCHAR(500),
        payment_terms VARCHAR(100),
        despatch_through VARCHAR(100),
        order_type VARCHAR(50) DEFAULT 'Service',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS standby_dc_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        standby_dc_id INT NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        hsn VARCHAR(50),
        quantity INT NOT NULL,
        uom VARCHAR(50),
        remarks TEXT,
        despatch_qty INT DEFAULT 0,
        pending_qty INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Safety check: ensure purpose column exists in standby_dc_entries
    await db.promise().query(
      "ALTER TABLE standby_dc_entries ADD COLUMN purpose VARCHAR(255) DEFAULT NULL"
    ).catch(() => {});

    // Ensure per-item client DC columns exist
    await db.promise().query(
      "ALTER TABLE standby_dc_items ADD COLUMN client_dc_no VARCHAR(100) NULL"
    ).catch(() => {});
    await db.promise().query(
      "ALTER TABLE standby_dc_items ADD COLUMN client_dc_date DATE NULL"
    ).catch(() => {});

    // Ensure serial_no column exists
    await db.promise().query(
      "ALTER TABLE standby_dc_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});

    console.log("Standby DC tables validated/created successfully");
  } catch (err) {
    console.error("Error creating/migrating Standby DC tables:", err.message);
  }
})();

// Auto-generate next Standby DC number
router.get("/next-dc-no", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT MAX(id) AS lastId FROM standby_dc_entries");
    const nextId = (rows[0].lastId || 0) + 1;
    res.json({ dc_no: `AT/SBDC-${nextId.toString().padStart(3, "0")}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search Standby DC entries by auto-generated DC number
router.get("/DC/search", async (req, res) => {
  try {
    const { q } = req.query;
    const [rows] = await db.promise().query(
      "SELECT standby_dc_no AS dc_number FROM standby_dc_entries WHERE standby_dc_no LIKE ? ORDER BY id DESC LIMIT 20",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Search Failed" });
  }
});

// Create new Standby DC Entry
router.post("/createdc", async (req, res) => {
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.despatch_through?.trim()) {
      return res.status(400).json({ message: "Despatch Through cannot be null." });
    }

    const [result] = await db.promise().query(
      `INSERT INTO standby_dc_entries
      (standby_dc_no, dc_date, customer_name, order_no, order_date, payment_terms, despatch_through, order_type, purpose)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.standby_dc_no,
        emptyToNull(s.dc_date),
        s.customer_name,
        s.order_no,
        emptyToNull(s.order_date),
        emptyToNull(s.payment_terms),
        emptyToNull(s.despatch_through),
        s.order_type || "Service",
        emptyToNull(s.purpose)
      ]
    );

    const newDcEntryId = result.insertId;

    for (const item of items) {
      const qty = toNum(item.quantity, 1);
      await db.promise().query(
        `INSERT INTO standby_dc_items
        (standby_dc_id, item_name, hsn, quantity, uom, remarks, despatch_qty, pending_qty, client_dc_no, client_dc_date, serial_no)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          newDcEntryId,
          item.item_name,
          emptyToNull(item.hsn),
          qty,
          emptyToNull(item.uom || "NOS"),
          emptyToNull(item.remarks),
          qty,
          emptyToNull(item.client_dc_no),
          emptyToNull(item.client_dc_date),
          emptyToNull(item.serial_no)
        ]
      );
    }

    res.status(201).json({ message: "Standby DC Entry created successfully", standby_dc_no: s.standby_dc_no });

  } catch (error) {
    console.error("Error creating Standby DC Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Update Standby DC Entry
router.put("/updatedc/:id", async (req, res) => {
  try {
    const dcId = req.params.id;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.despatch_through?.trim()) {
      return res.status(400).json({ message: "Despatch Through cannot be null." });
    }

    await db.promise().query(
      `UPDATE standby_dc_entries
       SET standby_dc_no=?, dc_date=?, customer_name=?, order_no=?,
           order_date=?, payment_terms=?, despatch_through=?, order_type=?, purpose=?
       WHERE id=?`,
      [
        s.standby_dc_no,
        emptyToNull(s.dc_date),
        s.customer_name,
        s.order_no,
        emptyToNull(s.order_date),
        emptyToNull(s.payment_terms),
        emptyToNull(s.despatch_through),
        s.order_type || "Service",
        emptyToNull(s.purpose),
        dcId
      ]
    );

    // Re-link existing item despatch quantities
    const [existingItems] = await db.promise().query(
      "SELECT item_name, despatch_qty FROM standby_dc_items WHERE standby_dc_id=?",
      [dcId]
    );
    const despatchMap = {};
    existingItems.forEach(row => {
      despatchMap[row.item_name] = row.despatch_qty;
    });

    // Delete items
    await db.promise().query("DELETE FROM standby_dc_items WHERE standby_dc_id=?", [dcId]);

    // Re-insert updated items
    for (const item of items) {
      const qty = toNum(item.quantity, 1);
      const prevDespatch = despatchMap[item.item_name] || 0;
      const finalDespatch = prevDespatch > qty ? qty : prevDespatch;
      const finalPending = qty - finalDespatch;

      await db.promise().query(
        `INSERT INTO standby_dc_items
        (standby_dc_id, item_name, hsn, quantity, uom, remarks, despatch_qty, pending_qty, client_dc_no, client_dc_date, serial_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dcId,
          item.item_name,
          emptyToNull(item.hsn),
          qty,
          emptyToNull(item.uom || "NOS"),
          emptyToNull(item.remarks),
          finalDespatch,
          finalPending,
          emptyToNull(item.client_dc_no),
          emptyToNull(item.client_dc_date),
          emptyToNull(item.serial_no)
        ]
      );
    }

    res.json({ message: "Standby DC Entry updated successfully" });
  } catch (error) {
    console.error("Error updating Standby DC Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Fetch Single Standby DC for Edit
router.get("/editdc/:standby_dc_no", async (req, res) => {
  try {
    const { standby_dc_no } = req.params;
    const [rows] = await db.promise().query(
      "SELECT * FROM standby_dc_entries WHERE standby_dc_no = ?",
      [standby_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Standby DC not found" });
    }

    const dcEntry = rows[0];

    const [items] = await db.promise().query(
      "SELECT * FROM standby_dc_items WHERE standby_dc_id = ? ORDER BY id ASC",
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
router.get("/full/:standby_dc_no", async (req, res) => {
  const { standby_dc_no } = req.params;
  try {
    const [dcRows] = await db.promise().query(
      `SELECT * FROM standby_dc_entries WHERE standby_dc_no = ?`,
      [standby_dc_no]
    );

    if (dcRows.length === 0) {
      return res.status(404).json({ message: "Standby DC not found" });
    }

    const dcEntry = dcRows[0];

    const [items] = await db.promise().query(
      `SELECT * FROM standby_dc_items WHERE standby_dc_id = ? ORDER BY id ASC`,
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

// Delete Standby DC
router.delete("/deletedc/:standby_dc_no", async (req, res) => {
  try {
    const { standby_dc_no } = req.params;
    const [rows] = await db.promise().query(
      "SELECT id FROM standby_dc_entries WHERE standby_dc_no = ?",
      [standby_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Standby DC not found" });
    }

    const dcEntryId = rows[0].id;

    // Delete items
    await db.promise().query("DELETE FROM standby_dc_items WHERE standby_dc_id = ?", [dcEntryId]);

    // Delete main entry
    await db.promise().query("DELETE FROM standby_dc_entries WHERE id = ?", [dcEntryId]);

    res.json({ message: "Standby DC Entry deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Fetch All Standby DC Data
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM standby_dc_entries ORDER BY id DESC"
    );

    for (const row of rows) {
      const [items] = await db.promise().query(
        "SELECT * FROM standby_dc_items WHERE standby_dc_id = ? ORDER BY id ASC",
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

// Standby Pending Details Report Filter
router.get("/report/filters", async (req, res) => {
  try {
    const { fromDate, toDate, customerName, dcNo } = req.query;

    let query = `
      SELECT 
        sde.customer_name AS name,
        sde.standby_dc_no AS dc_no,
        sde.dc_date AS dc_date,
        sdi.item_name,
        sdi.quantity AS order_qty,
        sdi.despatch_qty,
        sdi.pending_qty
      FROM standby_dc_entries sde
      JOIN standby_dc_items sdi ON sde.id = sdi.standby_dc_id
      WHERE sdi.pending_qty > 0
    `;

    let values = [];

    if (fromDate && toDate) {
      query += " AND sde.dc_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (dcNo) {
      query += " AND sde.standby_dc_no = ?";
      values.push(dcNo);
    }

    if (customerName) {
      query += " AND sde.customer_name = ?";
      values.push(customerName);
    }

    query += " ORDER BY sde.id DESC, sdi.id ASC";

    const [rows] = await db.promise().query(query, values);
    res.json(rows);

  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});

module.exports = router;
