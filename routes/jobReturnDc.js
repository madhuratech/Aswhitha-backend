const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Self-migration: ensure job_return tables exist on startup
(async () => {
  try {
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS job_return_dc_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        return_dc_no VARCHAR(100) UNIQUE NOT NULL,
        return_date DATE NOT NULL,
        job_dc_no VARCHAR(100) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        despatch_through VARCHAR(100),
        general_remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS job_return_dc_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        job_return_dc_id INT NOT NULL,
        job_dc_item_id INT NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        uom VARCHAR(50),
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Ensure per-item client DC columns exist
    await db.promise().query(
      "ALTER TABLE job_return_dc_items ADD COLUMN client_dc_no VARCHAR(100) NULL"
    ).catch(() => {});
    await db.promise().query(
      "ALTER TABLE job_return_dc_items ADD COLUMN client_dc_date DATE NULL"
    ).catch(() => {});
    await db.promise().query(
      "ALTER TABLE job_return_dc_items ADD COLUMN hsn_code VARCHAR(100) NULL"
    ).catch(() => {});
    await db.promise().query(
      "ALTER TABLE job_return_dc_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});

    console.log("Job Return DC tables validated/created successfully");
  } catch (err) {
    console.error("Error creating Job Return DC tables:", err.message);
  }
})();

// Auto-generate next Return DC number
router.get("/next-dc-no", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT MAX(id) AS lastId FROM job_return_dc_entries");
    const nextId = (rows[0].lastId || 0) + 1;
    res.json({ dc_no: `AT/JBRDC-${nextId.toString().padStart(3, "0")}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search Job Return DC entries by Return DC number
router.get("/DC/search", async (req, res) => {
  try {
    const { q } = req.query;
    const [rows] = await db.promise().query(
      "SELECT return_dc_no AS dc_number FROM job_return_dc_entries WHERE return_dc_no LIKE ? ORDER BY id DESC LIMIT 20",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Search Failed" });
  }
});

// Fetch pending Job DCs (those with items where pending_qty > 0)
router.get("/pending-jobs", async (req, res) => {
  try {
    const [jobs] = await db.promise().query(`
      SELECT DISTINCT jde.id, jde.job_dc_no, jde.customer_name 
      FROM job_dc_entries jde
      JOIN job_dc_items jdi ON jde.id = jdi.job_dc_id
      WHERE jdi.pending_qty > 0
      ORDER BY jde.id DESC
    `);

    for (const job of jobs) {
      const [items] = await db.promise().query(`
        SELECT id, item_name, serial_no, hsn, quantity AS issue_qty, pending_qty, uom, remarks
        FROM job_dc_items
        WHERE job_dc_id = ? AND pending_qty > 0
        ORDER BY id ASC
      `, [job.id]);
      job.items = items;
    }

    res.json(jobs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch pending jobs" });
  }
});

// Create new Job Return DC
router.post("/createdc", async (req, res) => {
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.return_dc_no || !s.job_dc_no || !s.customer_name) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    // Insert Return DC Entry
    const [result] = await db.promise().query(
      `INSERT INTO job_return_dc_entries
      (return_dc_no, return_date, job_dc_no, customer_name, despatch_through, general_remarks)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        s.return_dc_no,
        emptyToNull(s.return_date),
        s.job_dc_no,
        s.customer_name,
        emptyToNull(s.despatch_through),
        emptyToNull(s.general_remarks)
      ]
    );

    const newReturnId = result.insertId;

    for (const item of items) {
      const retQty = toNum(item.quantity, 1);
      const jobItemId = toNum(item.job_dc_item_id);

      // Insert Return DC Item
      await db.promise().query(
        `INSERT INTO job_return_dc_items
        (job_return_dc_id, job_dc_item_id, item_name, quantity, uom, remarks, client_dc_no, client_dc_date, hsn_code, serial_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newReturnId,
          jobItemId,
          item.item_name,
          retQty,
          emptyToNull(item.uom),
          emptyToNull(item.remarks),
          emptyToNull(item.client_dc_no),
          emptyToNull(item.client_dc_date),
          emptyToNull(item.hsn_code),
          emptyToNull(item.serial_no)
        ]
      );

      // Update despatch_qty in job_dc_items
      await db.promise().query(
        `UPDATE job_dc_items 
         SET despatch_qty = despatch_qty + ? 
         WHERE id = ?`,
        [retQty, jobItemId]
      );

      // Recalculate pending_qty based on the updated despatch_qty
      await db.promise().query(
        `UPDATE job_dc_items 
         SET pending_qty = quantity - despatch_qty 
         WHERE id = ?`,
        [jobItemId]
      );
    }

    res.status(201).json({ message: "Job Return DC created successfully", return_dc_no: s.return_dc_no });
  } catch (error) {
    console.error("Error creating Job Return DC:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Update Job Return DC
router.put("/updatedc/:return_dc_no", async (req, res) => {
  try {
    const { return_dc_no } = req.params;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.job_dc_no || !s.customer_name) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    // 1. Get existing Return DC Entry
    const [rows] = await db.promise().query(
      "SELECT id FROM job_return_dc_entries WHERE return_dc_no = ?",
      [return_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Return DC not found" });
    }

    const returnId = rows[0].id;

    // 2. Fetch and revert quantities for old items
    const [oldItems] = await db.promise().query(
      "SELECT job_dc_item_id, quantity FROM job_return_dc_items WHERE job_return_dc_id = ?",
      [returnId]
    );

    for (const item of oldItems) {
      await db.promise().query(
        `UPDATE job_dc_items 
         SET despatch_qty = GREATEST(0, despatch_qty - ?)
         WHERE id = ?`,
        [item.quantity, item.job_dc_item_id]
      );
      await db.promise().query(
        `UPDATE job_dc_items 
         SET pending_qty = quantity - despatch_qty 
         WHERE id = ?`,
        [item.job_dc_item_id]
      );
    }

    // 3. Delete old items
    await db.promise().query(
      "DELETE FROM job_return_dc_items WHERE job_return_dc_id = ?",
      [returnId]
    );

    // 4. Update Return DC Entry
    await db.promise().query(
      `UPDATE job_return_dc_entries
       SET return_date = ?, job_dc_no = ?, customer_name = ?, despatch_through = ?, general_remarks = ?
       WHERE id = ?`,
      [
        emptyToNull(s.return_date),
        s.job_dc_no,
        s.customer_name,
        emptyToNull(s.despatch_through),
        emptyToNull(s.general_remarks),
        returnId
      ]
    );

    // 5. Insert new items and apply quantities
    for (const item of items) {
      const retQty = toNum(item.quantity, 1);
      const jobItemId = toNum(item.job_dc_item_id);

      // Insert Return DC Item
      await db.promise().query(
        `INSERT INTO job_return_dc_items
        (job_return_dc_id, job_dc_item_id, item_name, quantity, uom, remarks, client_dc_no, client_dc_date, hsn_code, serial_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          returnId,
          jobItemId,
          item.item_name,
          retQty,
          emptyToNull(item.uom),
          emptyToNull(item.remarks),
          emptyToNull(item.client_dc_no),
          emptyToNull(item.client_dc_date),
          emptyToNull(item.hsn_code),
          emptyToNull(item.serial_no)
        ]
      );

      // Update despatch_qty and pending_qty in job_dc_items
      await db.promise().query(
        `UPDATE job_dc_items 
         SET despatch_qty = despatch_qty + ? 
         WHERE id = ?`,
        [retQty, jobItemId]
      );
      await db.promise().query(
        `UPDATE job_dc_items 
         SET pending_qty = quantity - despatch_qty 
         WHERE id = ?`,
        [jobItemId]
      );
    }

    res.json({ message: "Job Return DC updated successfully" });
  } catch (error) {
    console.error("Error updating Job Return DC:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Delete Job Return DC
router.delete("/deletedc/:return_dc_no", async (req, res) => {
  try {
    const { return_dc_no } = req.params;
    const [rows] = await db.promise().query(
      "SELECT id FROM job_return_dc_entries WHERE return_dc_no = ?",
      [return_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Return DC not found" });
    }

    const returnId = rows[0].id;

    // Fetch items to revert quantities
    const [items] = await db.promise().query(
      "SELECT job_dc_item_id, quantity FROM job_return_dc_items WHERE job_return_dc_id = ?",
      [returnId]
    );

    for (const item of items) {
      // Revert despatch_qty in job_dc_items
      await db.promise().query(
        `UPDATE job_dc_items 
         SET despatch_qty = GREATEST(0, despatch_qty - ?)
         WHERE id = ?`,
        [item.quantity, item.job_dc_item_id]
      );

      // Recalculate pending_qty
      await db.promise().query(
        `UPDATE job_dc_items 
         SET pending_qty = quantity - despatch_qty 
         WHERE id = ?`,
        [item.job_dc_item_id]
      );
    }

    // Delete items
    await db.promise().query(
      "DELETE FROM job_return_dc_items WHERE job_return_dc_id = ?",
      [returnId]
    );

    // Delete return entry
    await db.promise().query(
      "DELETE FROM job_return_dc_entries WHERE id = ?",
      [returnId]
    );

    res.json({ message: "Job Return DC deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Fetch Single Return DC for Print Full
router.get("/full/:return_dc_no", async (req, res) => {
  const { return_dc_no } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM job_return_dc_entries WHERE return_dc_no = ?",
      [return_dc_no]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Return DC not found" });
    }

    const returnDc = rows[0];

    const [items] = await db.promise().query(
      "SELECT * FROM job_return_dc_items WHERE job_return_dc_id = ? ORDER BY id ASC",
      [returnDc.id]
    );

    const [jobRows] = await db.promise().query(
      "SELECT jde.*, nc.address, nc.phone, nc.email, nc.gst_number, nc.state FROM job_dc_entries jde LEFT JOIN newclient nc ON jde.customer_name = nc.customer_name WHERE jde.job_dc_no = ?",
      [returnDc.job_dc_no]
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
      ...returnDc,
      items: items || [],
      jobDetails: jobRows[0] || {},
      aggregated_client_dc_no: uniqueDcNos.join(','),
      aggregated_client_dc_date: uniqueDcDates.join(',')
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Fetch All Return DCs
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM job_return_dc_entries ORDER BY id DESC"
    );

    for (const row of rows) {
      const [items] = await db.promise().query(
        "SELECT * FROM job_return_dc_items WHERE job_return_dc_id = ? ORDER BY id ASC",
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

module.exports = router;
