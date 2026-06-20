const express = require('express');
const router = express.Router();
const db = require('../config/database');
const axios = require('axios');
const ExcelJS = require("exceljs");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Self-migration: ensure serial_no column exists in purchase_order_items
(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE purchase_order_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => { });
    console.log("purchase_order_items table migrated successfully");
  } catch (err) {
    console.error("Error migrating purchase_order_items table:", err.message);
  }
})();


// generate a random PO number
async function generatePONumber() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM purchase_orders"
  );

  const nextId = (rows[0].lastId || 0) + 1;
  return `PO-${year}-${String(nextId).padStart(3, "0")}`;
}


// get po number
router.get('/next-po-number', async (req, res) => {
  try {
    const poNumber = await generatePONumber();
    res.json({ po_number: poNumber });
  } catch (error) {
    console.error('Error generating PO number:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Client Search (MUST be before /clients)
router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name, state, gst_number FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
      [searchTerm]
    );
    res.json(rows);
  } catch (error) {
    console.error("Error searching clients:", error);
    res.status(500).json({ message: "Search failed" });
  }
});

// Get All clients
router.get('/clients', async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name FROM newclient ORDER BY customer_name ASC "
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search items by name (MUST be before /items/:type)
router.get("/items/search", async (req, res) => {
  const { q, type } = req.query;
  let query = "";
  let values = [`%${q || ""}%`];

  if (type === "service") {
    query = `SELECT service_name AS item_name, hsn_number FROM servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20 `;
  }
  else if (type === "spare") {
    query = `SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20`;
  }
  else if (type === "purchase_item") {
    query = `SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20`;
  }
  else {
    return res.status(400).json({ message: "Invalid item type" });
  }
  try {
    const [rows] = await db.promise().query(query, [...values, ...values]);
    res.json(rows);
  } catch (error) {
    console.error("Error searching items:", error);
    res.status(500).json({ message: "Search failed" });
  }
});

// Get items by type
router.get('/items/:type', async (req, res) => {
  const { type } = req.params;
  let query = "SELECT * FROM items WHERE type = ?";

  if (type === 'service') {
    query = "SELECT service_name AS item_name, hsn_number FROM servicesdata";
  }
  else if (type === 'spare') {
    query = "SELECT spare_name AS item_name, hsn_number FROM sparedata";
  }
  else if (type === 'purchase_item') {
    query = "SELECT item_name, hsn_number FROM purchaseitems";
  } else {
    return res.status(400).json({ message: 'Invalid item type' });
  }
  try {
    let rows;
    if (type === 'service' || type === 'spare' || type === 'purchase_item') {
      [rows] = await db.promise().query(query);
    } else {
      [rows] = await db.promise().query(query, [type]);
    }
    res.json(rows);
  } catch (error) {
    console.error("Error fetching items:", error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Create a new purchase order
router.post('/new', async (req, res) => {
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const poNumber = await generatePONumber();

    const [poResult] = await db.promise().query(
      'INSERT INTO purchase_orders (po_number, client_name, order_type, po_date, subtotal, cgst, sgst, roundOff, grandTotal, narration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [poNumber, s.client_name, emptyToNull(s.order_type), emptyToNull(s.po_date), toNum(s.subtotal), toNum(s.cgst), toNum(s.sgst), toNum(s.roundOff), toNum(s.grandTotal), emptyToNull(s.narration)]
    );
    const poId = poResult.insertId;

    for (const item of items) {
      const amount = toNum(item.price) * toNum(item.quantity);
      await db.promise().query(
        `INSERT INTO purchase_order_items (po_id, item_name, price, quantity, hsn_code, unit, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [poId, emptyToNull(item.item_name), toNum(item.price), toNum(item.quantity), emptyToNull(item.hsn_code), emptyToNull(item.unit), amount, emptyToNull(item.serial_no)]
      );
    }
    res.status(201).json({ message: 'Purchase order created successfully', po_number: poNumber });
  } catch (error) {
    console.error('Error creating purchase order:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update a purchase order
router.put('/:poNumber', async (req, res) => {
  const { poNumber } = req.params;
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const [poRows] = await db.promise().query(
      "SELECT * FROM purchase_orders WHERE po_number = ?",
      [poNumber]
    );
    const poId = poRows[0].id;
    await db.promise().query(
      "UPDATE purchase_orders SET client_name = ?, order_type = ?, po_date = ?, subtotal = ?, cgst = ?, sgst = ?, roundOff = ?, grandTotal = ?, narration = ? WHERE id = ?",
      [s.client_name, emptyToNull(s.order_type), emptyToNull(s.po_date), toNum(s.subtotal), toNum(s.cgst), toNum(s.sgst), toNum(s.roundOff), toNum(s.grandTotal), emptyToNull(s.narration), poId]
    );

    // Delete existing items
    await db.promise().query("DELETE FROM purchase_order_items WHERE po_id = ?", [poId]);

    // Insert updated items
    for (const item of items) {
      const amount = toNum(item.price) * toNum(item.quantity);
      await db.promise().query(
        `INSERT INTO purchase_order_items (po_id, item_name, price, quantity, hsn_code, unit, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [poId, emptyToNull(item.item_name), toNum(item.price), toNum(item.quantity), emptyToNull(item.hsn_code), emptyToNull(item.unit), amount, emptyToNull(item.serial_no)]
      );
    }
    res.json({ message: "Updated successfully" });
  } catch (error) {
    console.error('Error updating purchase order:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// delete po
router.delete('/:poNumber', async (req, res) => {
  try {
    const { poNumber } = req.params;
    const [poRows] = await db.promise().query(
      "SELECT * FROM purchase_orders WHERE po_number = ?",
      [poNumber]
    );
    const poId = poRows[0].id;

    await db.promise().query(
      "DELETE FROM purchase_order_items WHERE po_id = ?", [poId]);

    await db.promise().query(
      "DELETE FROM purchase_orders WHERE id = ?", [poId]
    );
    res.json({ message: "Deleted successfully" });
  } catch (error) {
    console.error('Error deleting purchase order:', error);
    res.status(500).json({ message: 'Internal server error' });

  }

});

// Po Search

router.get("/po/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      "SELECT po_number FROM purchase_orders WHERE po_number LIKE ? ORDER BY Id DESC LIMIT 20 ",
      [searchTerm]
    );
    res.json(rows);
  } catch (error) {
    console.error("Error searching purchase orders:", error);
    res.status(500).json({ message: "Search failed" });
  }
});

// Get All Purchase Orders

router.get("/full/:poNumber", async (req, res) => {
  const { poNumber } = req.params;

  try {
    // ✅ Get PO first
    const [poRows] = await db.promise().query(
      "SELECT * FROM purchase_orders WHERE po_number = ?",
      [poNumber]
    );

    if (poRows.length === 0) {
      return res.status(404).json({ message: "PO not found" });
    }

    const poData = poRows[0];

    // Get items
    const [items] = await db.promise().query(
      "SELECT * FROM purchase_order_items WHERE po_id = ?",
      [poData.id]
    );

    //   Get client by NAME (since you stored name)
    const [client] = await db.promise().query(
      "SELECT * FROM newclient WHERE customer_name = ?",
      [poData.client_name]
    );

    res.json({
      ...poData,
      items,
      client: client[0] || {}
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});




// Get purchase order by PO number (MUST be last as it is most generic)
router.get('/:poNumber', async (req, res) => {
  const { poNumber } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM purchase_orders WHERE po_number = ?",
      [poNumber]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }
    const [items] = await db.promise().query(
      "SELECT * FROM purchase_order_items WHERE po_id = ?",
      [rows[0].id]
    );
    res.json({ ...rows[0], items });
  } catch (error) {
    console.error('Error fetching purchase order:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// get filter data and all data show genrate report;
router.get("/report/filters", async (req, res) => {
  try {
    const { fromDate, toDate, poNumber, clientName } = req.query;

    let query = `
      SELECT 
        po.po_number,
        po.po_date,
        po.client_name,
        po.subtotal,
        po.cgst,
        po.sgst,
        po.grandTotal,
        poi.item_name,
        poi.quantity,
        poi.price
      FROM purchase_orders po
      LEFT JOIN purchase_order_items poi 
        ON po.id = poi.po_id
      WHERE 1=1
    `;

    let values = [];

    if (fromDate && toDate) {
      query += " AND po.po_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (poNumber) {
      query += " AND po.po_number = ?";
      values.push(poNumber);
    }

    if (clientName) {
      query += " AND po.client_name = ?";
      values.push(clientName);
    }

    const [rows] = await db.promise().query(query, values);

    res.json(rows);

  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});



router.get("/report/excel", async (req, res) => {
  try {
    const { fromDate, toDate, poNumber, clientName } = req.query;

    let query = `
      SELECT 
        po.po_number,
        po.po_date,
        po.client_name,

        po.subtotal,
        po.cgst,
        po.sgst,
        po.grandTotal,

        poi.item_name,
        poi.quantity,
        poi.price

      FROM purchase_orders po
      LEFT JOIN purchase_order_items poi 
        ON po.id = poi.po_id
      WHERE 1=1
    `;

    let values = [];

    if (fromDate && toDate) {
      query += " AND po.po_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (poNumber) {
      query += " AND po.po_number = ?";
      values.push(poNumber);
    }

    if (clientName) {
      query += "AND po.client_name = ?";
      values.push(clientName);
    }

    const [rows] = await db.promise().query(query, values);

    //  Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Purchase Report");

    //  Header Row
    worksheet.columns = [
      { header: "SNO", key: "sno", width: 8 },
      { header: "PO Number", key: "po_number", width: 18 },
      { header: "Date", key: "po_date", width: 15 },
      { header: "Client Name", key: "client_name", width: 25 },
      { header: "Item Name", key: "item_name", width: 25 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Price", key: "price", width: 12 },
      { header: "Subtotal", key: "subtotal", width: 15 },
      { header: "CGST", key: "cgst", width: 10 },
      { header: "SGST", key: "sgst", width: 10 },
      { header: "Grand Total", key: "grandTotal", width: 18 },
    ];

    //  Add Data Rows
    rows.forEach((row, index) => {
      worksheet.addRow({
        sno: index + 1,
        ...row
      });
    });

    // Style header
    worksheet.getRow(1).font = { bold: true };

    //  Send file
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Purchase_Report.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("Excel Export Error:", error);
    res.status(500).json({ message: "Excel export failed" });
  }
});

module.exports = router;
