const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");


// Auto-generate next Service DC number
router.get("/next-dc-no", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT MAX(id) AS lastId FROM service_dc_entries");
    const nextId = (rows[0].lastId || 0) + 1;
    res.json({ dc_no: `AT/SRDC-${nextId.toString().padStart(3, "0")}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Clients — only those who have inward entries
router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT DISTINCT supplier_name AS customer_name FROM inward_entry ORDER BY supplier_name ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Client search — only inward entry customers
router.get("/clients/search", async (req, res) => {
  try {
    const { q } = req.query;
    const [rows] = await db.promise().query(
      "SELECT DISTINCT supplier_name AS customer_name FROM inward_entry WHERE supplier_name LIKE ? ORDER BY supplier_name ASC LIMIT 20",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Client DC numbers from inward_entry filtered by client name
router.get("/client-dc-list", async (req, res) => {
  try {
    const { client, q } = req.query;
    let query = "SELECT dc_number, dc_date FROM inward_entry WHERE 1=1";
    const params = [];
    if (client) { query += " AND supplier_name = ?"; params.push(client); }
    if (q) { query += " AND dc_number LIKE ?"; params.push(`%${q}%`); }
    query += " ORDER BY id DESC LIMIT 20";
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

    const [rows] = await db.promise().query(
      `SELECT supplier_name, dc_number, dc_date
       FROM inward_entry WHERE dc_number = ?`,
      [dc_number]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "DC Number not found" });
    }

    const entry = rows[0];

    const [items] = await db.promise().query(
      `SELECT item_name, hsn, quantity, unit, pcb_sl_no, problems, remarks
       FROM inward_items
       WHERE inward_id = (SELECT id FROM inward_entry WHERE dc_number = ?)`,
      [dc_number]
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

    const [result] = await db.promise().query(
      `INSERT INTO service_dc_entries
      (supplier_name, inward_dc_no, dc_date, party_dc_no, party_dc_date, payment_terms, despatch_through, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.supplier_name,
        s.inward_dc_no,
        emptyToNull(s.dc_date),
        emptyToNull(s.party_dc_no),
        emptyToNull(s.party_dc_date),
        s.payment_terms || "",
        emptyToNull(s.despatch_through),
        emptyToNull(s.status)
      ]
    );

    const newDcEntryId = result.insertId;

    for (const item of items) {
      await db.promise().query(
        `INSERT INTO service_dc_items
        (service_dc_id, item_name, quantity, serial_no, received_qty, uom, hsn, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newDcEntryId,
          emptyToNull(item.item_name),
          toNum(item.quantity, null),
          emptyToNull(item.serial_no),
          toNum(item.received_qty),
          emptyToNull(item.uom),
          emptyToNull(item.hsn),
          emptyToNull(item.remarks)
        ]
      );
    }

    res.status(201).json({ message: "DC Entry created successfully" });

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

    // Update the main entry
    await db.promise().query(
      `UPDATE service_dc_entries
       SET supplier_name=?, inward_dc_no=?, dc_date=?, party_dc_no=?,
           party_dc_date=?, payment_terms=?, despatch_through=?, status=?
       WHERE id=?`,
      [
        s.supplier_name,
        s.inward_dc_no,
        emptyToNull(s.dc_date),
        emptyToNull(s.party_dc_no),
        emptyToNull(s.party_dc_date),
        s.payment_terms || "",
        emptyToNull(s.despatch_through),
        emptyToNull(s.status),
        dcId
      ]
    );

    // Delete existing items
    await db.promise().query("DELETE FROM service_dc_items WHERE service_dc_id=?", [dcId]);

    // Insert updated items
    for (const item of items) {
      await db.promise().query(
        "INSERT INTO service_dc_items (service_dc_id, item_name, quantity, serial_no, received_qty, uom, hsn, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [dcId, emptyToNull(item.item_name), toNum(item.quantity, null), emptyToNull(item.serial_no), toNum(item.received_qty), emptyToNull(item.uom), emptyToNull(item.hsn), emptyToNull(item.remarks)]
      );
    }

    res.json({ message: "DC Entry updated successfully" });
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
        remarks
       FROM service_dc_items
       WHERE service_dc_id = ?`,

      [dcEntry.id]

    );

    // CLIENT
    const [clientRows] = await db.promise().query(

      `SELECT *
       FROM newclient
       WHERE customer_name = ?`,

      [dcEntry.supplier_name]

    );

    res.json({

      ...dcEntry,

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
      "SELECT id FROM service_dc_entries WHERE inward_dc_no = ?",
      [inward_dc_no]
    );

    if (!rows.length) {

      return res.status(404).json({
        message: "DC not found"
      });

    }

    const dcEntryId = rows[0].id;

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
        despatch_through,
        status
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
          received_qty,
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