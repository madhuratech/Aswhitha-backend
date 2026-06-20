const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");
const { getCurrentDcNumber, getAndIncrementDcNumber } = require("../helpers/dcNumber");

// Ensure item-level party DC columns exist
(async () => {
  try {
    const [cols] = await db.promise().query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'service_dc_items'
       AND COLUMN_NAME IN ('party_dc_no', 'party_dc_date')`
    );
    const existing = cols.map(c => c.COLUMN_NAME);
    if (!existing.includes('party_dc_no')) {
      await db.promise().query('ALTER TABLE service_dc_items ADD COLUMN party_dc_no VARCHAR(100)');
    }
    if (!existing.includes('party_dc_date')) {
      await db.promise().query('ALTER TABLE service_dc_items ADD COLUMN party_dc_date VARCHAR(500)');
    }
  } catch (e) {
    console.error('Migration error (service_dc_items):', e.message);
  }
})();


// Get next DC No from shared counter
router.get("/next-dc-no", async (req, res) => {
  try {
    const dc_no = await getCurrentDcNumber();
    res.json({ dc_no });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Clients — only those who have at least one item with remaining qty > 0
router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT ie.supplier_name AS customer_name
       FROM inward_entry ie
       JOIN inward_items ii ON ii.inward_id = ie.id
       WHERE ie.dc_number IS NOT NULL AND ie.dc_number != ''
        AND (
         ii.quantity - COALESCE((
           SELECT SUM(sdi.quantity)
           FROM service_dc_items sdi
           JOIN service_dc_entries sde ON sde.id = sdi.service_dc_id
           WHERE sdi.item_name = ii.item_name
             AND sde.supplier_name = ie.supplier_name
             AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ie.dc_number, ',%')
         ), 0)
       ) > 0
       ORDER BY ie.supplier_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Client search — only customers with at least one item with remaining qty > 0
router.get("/clients/search", async (req, res) => {
  try {
    const { q } = req.query;
    const [rows] = await db.promise().query(
      `SELECT DISTINCT ie.supplier_name AS customer_name
       FROM inward_entry ie
       JOIN inward_items ii ON ii.inward_id = ie.id
       WHERE ie.supplier_name LIKE ?
       AND ie.dc_number IS NOT NULL AND ie.dc_number != ''
       AND (
         ii.quantity - COALESCE((
           SELECT SUM(sdi.quantity)
           FROM service_dc_items sdi
           JOIN service_dc_entries sde ON sde.id = sdi.service_dc_id
           WHERE sdi.item_name = ii.item_name
             AND sde.supplier_name = ie.supplier_name
             AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ie.dc_number, ',%')
         ), 0)
       ) > 0
       ORDER BY ie.supplier_name ASC LIMIT 20`,
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Client DC numbers — only those where at least one item still has remaining qty > 0
router.get("/client-dc-list", async (req, res) => {
  try {
    const { client, q } = req.query;
    let query = `SELECT ie.dc_number, ie.dc_date
    FROM inward_entry ie
    JOIN inward_items ii ON ii.inward_id = ie.id
    WHERE ie.dc_number IS NOT NULL AND ie.dc_number != ''
    AND (
      ii.quantity - COALESCE((
        SELECT SUM(sdi.quantity)
        FROM service_dc_items sdi
        JOIN service_dc_entries sde ON sde.id = sdi.service_dc_id
        WHERE sdi.item_name = ii.item_name
          AND sde.supplier_name = ie.supplier_name
          AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ie.dc_number, ',%')
      ), 0)
    ) > 0`;
    const params = [];
    if (client) { query += " AND ie.supplier_name = ?"; params.push(client); }
    if (q) { query += " AND ie.dc_number LIKE ?"; params.push(`%${q}%`); }
    query += " GROUP BY ie.dc_number, ie.dc_date, ie.id ORDER BY ie.id DESC LIMIT 20";
    const [rows] = await db.promise().query(query, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

// Search service DC entries by their auto-generated DC number
router.get("/DC/search", async (req, res) => {
  try {
    const { q } = req.query;
    const [rows] = await db.promise().query(
      "SELECT inward_dc_no AS dc_number FROM service_dc_entries WHERE inward_dc_no LIKE ? ORDER BY id DESC LIMIT 20",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Search Failed" });
  }
});


// DC Number Dropdown Search (supports supplier filter)

router.get("/IE/search", async (req, res) => {

  try {

    const { q, supplier } = req.query;
    const searchTerm = `%${q || ""}%`;
    let query = "SELECT dc_number FROM inward_entry WHERE dc_number LIKE ?";
    const params = [searchTerm];
    if (supplier) {
      query += " AND supplier_name = ?";
      params.push(supplier);
    }
    query += " ORDER BY id DESC LIMIT 20";

    const [rows] = await db.promise().query(query, params);

    res.json(rows);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message: "Search Failed"
    });

  }
});


// Get Inward Full Details (with items)

router.get("/inward/:dc_number", async (req, res) => {

  try {

    const { dc_number } = req.params;
    const { supplier } = req.query;

    const [rows] = await db.promise().query(
      `SELECT supplier_name, dc_number, dc_date
       FROM inward_entry WHERE dc_number = ? AND supplier_name = ?`,
      [dc_number, supplier]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "DC Number not found" });
    }

    const entry = rows[0];

    const [items] = await db.promise().query(
      `SELECT
         ii.item_name, ii.hsn, ii.unit, ii.pcb_sl_no, ii.problems, ii.remarks,
         (ii.quantity - COALESCE(SUM(sdi.quantity), 0)) AS quantity
       FROM inward_items ii
       JOIN inward_entry ie ON ie.id = ii.inward_id AND ie.dc_number = ? AND ie.supplier_name = ?
       LEFT JOIN service_dc_items sdi
         ON sdi.item_name = ii.item_name
         AND sdi.service_dc_id IN (
           SELECT sde.id FROM service_dc_entries sde
           WHERE sde.supplier_name = ie.supplier_name
             AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ie.dc_number, ',%')
         )
       GROUP BY ii.id, ii.item_name, ii.hsn, ii.unit, ii.pcb_sl_no, ii.problems, ii.remarks
       HAVING quantity > 0`,
      [dc_number, supplier]
    );

    res.json({
      header: {
        ...entry,
        inward_date: entry.dc_date
      },
      items: items || []
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message: "Server Error"
    });

  }
});


//Create new Dc Entry

router.post("/createdc", async (req, res) => {
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.despatch_through?.trim()) {
      return res.status(400).json({ message: "Despatch Through cannot be null." });
    }

    const conn = await db.promise().getConnection();
    try {
      await conn.beginTransaction();

      // Atomically get & increment the shared counter inside the transaction
      const dcNo = await getAndIncrementDcNumber(conn);

      const [result] = await conn.query(
        `INSERT INTO service_dc_entries
        (supplier_name, inward_dc_no, dc_date, party_dc_no, party_dc_date, payment_terms, despatch_through)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          s.supplier_name,
          dcNo,
          emptyToNull(s.dc_date),
          emptyToNull(s.party_dc_no),
          emptyToNull(s.party_dc_date),
          s.payment_terms || "",
          emptyToNull(s.despatch_through)
        ]
      );

      const newDcEntryId = result.insertId;

      for (const item of items) {
        const itemPartyDcNo = item.party_dc_no || s.party_dc_no || "";
        const itemPartyDcDate = item.party_dc_date || s.party_dc_date || "";
        await conn.query(
          `INSERT INTO service_dc_items
          (service_dc_id, item_name, quantity, serial_no, uom, hsn, remarks, party_dc_no, party_dc_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newDcEntryId,
            emptyToNull(item.item_name),
            toNum(item.quantity, null),
            emptyToNull(item.serial_no),
            emptyToNull(item.uom),
            emptyToNull(item.hsn),
            emptyToNull(item.remarks),
            emptyToNull(itemPartyDcNo),
            emptyToNull(itemPartyDcDate)
          ]
        );
      }

      await conn.commit();

      // Best-effort status updates (outside transaction — failure won't roll back DC creation)
      try {
        const uniquePartyDcNos = [...new Set(items.map(i => i.party_dc_no).filter(Boolean))];
        if (!uniquePartyDcNos.length && s.party_dc_no) uniquePartyDcNos.push(s.party_dc_no);
        for (const pdcNo of uniquePartyDcNos) {
          await db.promise().query(
            `UPDATE inward_entry SET status = 'DC Created' WHERE dc_number = ?`,
            [pdcNo]
          );
        }
      } catch (_) {}

      // Only mark order as Completed when all inward qty has been serviced (pending qty = 0)
      try {
        const uniquePartyDcNos = [...new Set(items.map(i => i.party_dc_no).filter(Boolean))];
        if (!uniquePartyDcNos.length && s.party_dc_no) uniquePartyDcNos.push(s.party_dc_no);
        for (const pdcNo of uniquePartyDcNos) {
          const [[inwardRow]] = await db.promise().query(
            `SELECT COALESCE(SUM(ii.quantity), 0) AS total_qty
             FROM inward_entry ie
             JOIN inward_items ii ON ii.inward_id = ie.id
             WHERE ie.dc_number = ? AND ie.supplier_name = ?`,
            [pdcNo, s.supplier_name]
          );
          const [[servicedRow]] = await db.promise().query(
            `SELECT COALESCE(SUM(sdi.quantity), 0) AS total_qty
             FROM service_dc_items sdi
             JOIN service_dc_entries sde ON sde.id = sdi.service_dc_id
             WHERE sde.supplier_name = ?
               AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ?, ',%')`,
            [s.supplier_name, pdcNo]
          );
          const inwardQty = Number(inwardRow?.total_qty || 0);
          const servicedQty = Number(servicedRow?.total_qty || 0);
          if (inwardQty > 0 && servicedQty >= inwardQty) {
            await db.promise().query(
              `INSERT INTO order_status (customer_name, order_no, dc_type, status)
               VALUES (?, ?, 'Service', 'Completed')
               ON DUPLICATE KEY UPDATE status = 'Completed'`,
              [s.supplier_name, pdcNo]
            );
          }
        }
      } catch (_) {}

      res.status(201).json({ message: "DC Entry created successfully", dc_no: dcNo });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Error creating DC Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});


// Update Edit

router.put("/updatedc/:id", async (req, res) => {
  try {
    const dcId = req.params.id;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.despatch_through?.trim()) {
      return res.status(400).json({ message: "Despatch Through cannot be null." });
    }

    const conn = await db.promise().getConnection();
    try {
      await conn.beginTransaction();

      // Update the main entry
      await conn.query(
        `UPDATE service_dc_entries
         SET supplier_name=?, inward_dc_no=?, dc_date=?, party_dc_no=?,
             party_dc_date=?, payment_terms=?, despatch_through=?
         WHERE id=?`,
        [
          s.supplier_name,
          s.inward_dc_no,
          emptyToNull(s.dc_date),
          emptyToNull(s.party_dc_no),
          emptyToNull(s.party_dc_date),
          s.payment_terms || "",
          emptyToNull(s.despatch_through),
          dcId
        ]
      );

      // Delete existing items
      await conn.query("DELETE FROM service_dc_items WHERE service_dc_id=?", [dcId]);

      // Insert updated items
      for (const item of items) {
        const itemPartyDcNo = item.party_dc_no || s.party_dc_no || "";
        const itemPartyDcDate = item.party_dc_date || s.party_dc_date || "";
        await conn.query(
          "INSERT INTO service_dc_items (service_dc_id, item_name, quantity, serial_no, uom, hsn, remarks, party_dc_no, party_dc_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [dcId, emptyToNull(item.item_name), toNum(item.quantity, null), emptyToNull(item.serial_no), emptyToNull(item.uom), emptyToNull(item.hsn), emptyToNull(item.remarks), emptyToNull(itemPartyDcNo), emptyToNull(itemPartyDcDate)]
        );
      }

      await conn.commit();

      // Best-effort status updates (outside transaction)
      try {
        const uniquePartyDcNos = [...new Set(items.map(i => i.party_dc_no).filter(Boolean))];
        if (!uniquePartyDcNos.length && s.party_dc_no) uniquePartyDcNos.push(s.party_dc_no);
        for (const pdcNo of uniquePartyDcNos) {
          await db.promise().query(`UPDATE inward_entry SET status = 'DC Created' WHERE dc_number = ?`, [pdcNo]);
        }
      } catch (_) {}

      // Only mark order as Completed when all inward qty has been serviced (pending qty = 0)
      try {
        const uniquePartyDcNos = [...new Set(items.map(i => i.party_dc_no).filter(Boolean))];
        if (!uniquePartyDcNos.length && s.party_dc_no) uniquePartyDcNos.push(s.party_dc_no);
        for (const pdcNo of uniquePartyDcNos) {
          const [[inwardRow]] = await db.promise().query(
            `SELECT COALESCE(SUM(ii.quantity), 0) AS total_qty
             FROM inward_entry ie
             JOIN inward_items ii ON ii.inward_id = ie.id
             WHERE ie.dc_number = ? AND ie.supplier_name = ?`,
            [pdcNo, s.supplier_name]
          );
          const [[servicedRow]] = await db.promise().query(
            `SELECT COALESCE(SUM(sdi.quantity), 0) AS total_qty
             FROM service_dc_items sdi
             JOIN service_dc_entries sde ON sde.id = sdi.service_dc_id
             WHERE sde.supplier_name = ?
               AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ?, ',%')`,
            [s.supplier_name, pdcNo]
          );
          const inwardQty = Number(inwardRow?.total_qty || 0);
          const servicedQty = Number(servicedRow?.total_qty || 0);
          if (inwardQty > 0 && servicedQty >= inwardQty) {
            await db.promise().query(
              `INSERT INTO order_status (customer_name, order_no, dc_type, status)
               VALUES (?, ?, 'Service', 'Completed')
               ON DUPLICATE KEY UPDATE status = 'Completed'`,
              [s.supplier_name, pdcNo]
            );
          } else {
            // Pending qty still remains — remove any stale Completed status
            await db.promise().query(
              `DELETE FROM order_status
               WHERE customer_name = ? AND order_no = ? AND dc_type = 'Service'`,
              [s.supplier_name, pdcNo]
            );
          }
        }
      } catch (_) {}

      res.json({ message: "DC Entry updated successfully" });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Error updating DC Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});


// Search Stored Items

router.get("/items/search", async (req, res) => {

  try {

    const { q } = req.query;

    const searchTerm = `%${q || ""}%`;

    const [rows] = await db.promise().query(

      `SELECT DISTINCT item_name
       FROM service_dc_items
       WHERE item_name LIKE ?
       ORDER BY item_name ASC
       LIMIT 20`,

      [searchTerm]

    );

    res.json(rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});

router.get("/editdc/:dc_number", async (req, res) => {

  try {

    const { dc_number } = req.params;

    const [rows] = await db.promise().query(
      "SELECT * FROM service_dc_entries WHERE inward_dc_no = ?",
      [dc_number]
    );

    if (!rows.length) {

      return res.status(404).json({
        message: "DC not found"
      });

    }

    const dcEntry = rows[0];

    const [items] = await db.promise().query(
      "SELECT * FROM service_dc_items WHERE service_dc_id = ?",
      [dcEntry.id]
    );

    res.json({
      header: dcEntry,
      items
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }
});



// Get All Data
router.get("/full/:dc_number", async (req, res) => {

  const { dc_number } = req.params;

  try {

    // MAIN ENTRY
    const [dcRows] = await db.promise().query(

      `SELECT *
       FROM service_dc_entries
       WHERE inward_dc_no = ?`,

      [dc_number]

    );

    if (dcRows.length === 0) {

      return res.status(404).json({
        message: "DC not found"
      });

    }

    const dcEntry = dcRows[0];

    // ITEMS
    const [items] = await db.promise().query(

      `SELECT
        item_name,
        quantity,
        hsn,
        serial_no AS sl_no,
        uom,
        remarks,
        party_dc_no,
        party_dc_date
       FROM service_dc_items
       WHERE service_dc_id = ?`,

      [dcEntry.id]

    );

    // Aggregate unique party DC nos and dates from item level
    const uniqueDcNos = [...new Set(items.map(i => i.party_dc_no).filter(Boolean))];
    const uniqueDcDates = [...new Set(items.map(i => i.party_dc_date).filter(Boolean))];
    const aggregatedDcNo = uniqueDcNos.length > 0 ? uniqueDcNos.join(',') : (dcEntry.party_dc_no || '');
    const aggregatedDcDate = uniqueDcDates.length > 0 ? uniqueDcDates.join(',') : (dcEntry.party_dc_date || '');

    // CLIENT
    const [clientRows] = await db.promise().query(

      `SELECT *
       FROM newclient
       WHERE customer_name = ?`,

      [dcEntry.supplier_name]

    );

    res.json({

      ...dcEntry,
      party_dc_no: aggregatedDcNo,
      party_dc_date: aggregatedDcDate,

      items: items || [],

      client: clientRows[0] || {}

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});




// Delete Existing 
router.delete("/deletedc/:inward_dc_no", async (req, res) => {

  try {

    const { inward_dc_no } = req.params;

    const [rows] = await db.promise().query(
      "SELECT id, supplier_name, party_dc_no FROM service_dc_entries WHERE inward_dc_no = ?",
      [inward_dc_no]
    );

    if (!rows.length) {

      return res.status(404).json({
        message: "DC not found"
      });

    }

    const dcEntry = rows[0];
    const dcEntryId = dcEntry.id;

    // Delete items
    await db.promise().query(
      "DELETE FROM service_dc_items WHERE service_dc_id = ?",
      [dcEntryId]
    );

    // Delete the main entry
    await db.promise().query(
      "DELETE FROM service_dc_entries WHERE id = ?",
      [dcEntryId]
    );

    // Clean up order_status: recalculate pending qty for each affected order
    try {
      const orderNos = (dcEntry.party_dc_no || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const orderNo of orderNos) {
        const [[inwardRow]] = await db.promise().query(
          `SELECT COALESCE(SUM(ii.quantity), 0) AS total_qty
           FROM inward_entry ie
           JOIN inward_items ii ON ii.inward_id = ie.id
           WHERE ie.dc_number = ? AND ie.supplier_name = ?`,
          [orderNo, dcEntry.supplier_name]
        );
        const [[servicedRow]] = await db.promise().query(
          `SELECT COALESCE(SUM(sdi.quantity), 0) AS total_qty
           FROM service_dc_items sdi
           JOIN service_dc_entries sde ON sde.id = sdi.service_dc_id
           WHERE sde.supplier_name = ?
             AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ?, ',%')`,
          [dcEntry.supplier_name, orderNo]
        );
        const inwardQty = Number(inwardRow?.total_qty || 0);
        const servicedQty = Number(servicedRow?.total_qty || 0);
        if (inwardQty > 0 && servicedQty >= inwardQty) {
          await db.promise().query(
            `INSERT INTO order_status (customer_name, order_no, dc_type, status)
             VALUES (?, ?, 'Service', 'Completed')
             ON DUPLICATE KEY UPDATE status = 'Completed'`,
            [dcEntry.supplier_name, orderNo]
          );
        } else {
          await db.promise().query(
            `DELETE FROM order_status
             WHERE customer_name = ? AND order_no = ? AND dc_type = 'Service'`,
            [dcEntry.supplier_name, orderNo]
          );
        }
      }
    } catch (_) {}

    res.json({
      message: "DC Entry deleted successfully"
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});

// Fetch All Dc Data

router.get("/all", async (req, res) => {

  try {

    // Main Entries

    const [rows] = await db.promise().query(

      `SELECT
        id,
        inward_dc_no,
        dc_date,
        supplier_name,
        party_dc_no,
        party_dc_date,
        payment_terms,
        despatch_through
      FROM service_dc_entries
      ORDER BY id DESC`

    );

    // Attach Items For Each Entry

    for (const row of rows) {

      const [items] = await db.promise().query(

        `SELECT
          id,
          item_name,
          quantity,
          serial_no,
          uom,
          hsn,
          remarks
        FROM service_dc_items
        WHERE service_dc_id = ?`,

        [row.id]

      );

      row.items = items;

    }

    res.json(rows);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});


// get filter data and all data show generate report;
router.get("/report/filters", async (req, res) => {
  try {
    const { fromDate, toDate, clientName, dcNumber } = req.query;

    let query = `
      SELECT 
        de.inward_dc_no as dc_number,
        de.dc_date,
        de.supplier_name as client_name,
        de.party_dc_no,
        de.party_dc_date,
        di.item_name,
        di.quantity,
        di.remarks
      FROM service_dc_entries de
      LEFT JOIN service_dc_items di 
        ON de.id = di.service_dc_id
      WHERE 1=1
    `;

    let values = [];

    if (fromDate && toDate) {
      query += " AND de.dc_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (dcNumber) {
      query += " AND de.inward_dc_no = ?";
      values.push(dcNumber);
    }

    if (clientName) {
      query += " AND de.supplier_name = ?";
      values.push(clientName);
    }

    query += " ORDER BY de.id DESC";

    const [rows] = await db.promise().query(query, values);
    res.json(rows);

  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});

// Excel Export
router.get("/report/excel", async (req, res) => {
  try {
    const { fromDate, toDate, clientName, dcNumber } = req.query;

    let query = `
      SELECT 
        de.inward_dc_no as dc_number,
        de.dc_date,
        de.supplier_name as client_name,
        de.party_dc_no,
        de.party_dc_date,
        di.item_name,
        di.quantity,
        di.remarks
      FROM service_dc_entries de
      LEFT JOIN service_dc_items di 
        ON de.id = di.service_dc_id
      WHERE 1=1
    `;

    let values = [];

    if (fromDate && toDate) {
      query += " AND de.dc_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (dcNumber) {
      query += " AND de.inward_dc_no = ?";
      values.push(dcNumber);
    }

    if (clientName) {
      query += " AND de.supplier_name = ?";
      values.push(clientName);
    }

    const [rows] = await db.promise().query(query, values);

    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("DC Report");

    worksheet.columns = [
      { header: "SNO", key: "sno", width: 8 },
      { header: "DC Number", key: "dc_number", width: 18 },
      { header: "Date", key: "dc_date", width: 15 },
      { header: "Client Name", key: "client_name", width: 25 },
      { header: "Party DC No", key: "party_dc_no", width: 18 },
      { header: "Item Name", key: "item_name", width: 25 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Remarks", key: "remarks", width: 25 },
    ];

    rows.forEach((row, index) => {
      worksheet.addRow({
        sno: index + 1,
        ...row,
        dc_date: row.dc_date ? new Date(row.dc_date).toLocaleDateString('en-GB') : ""
      });
    });

    worksheet.getRow(1).font = { bold: true };

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=DC_Report.xlsx");

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("Excel Export Error:", error);
    res.status(500).json({ message: "Excel export failed" });
  }
});

module.exports = router;