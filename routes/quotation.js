const express = require("express");
const router = express.Router();
const db = require("../config/database");
const axios = require("axios");
const ExcelJS = require("exceljs");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Self-migration: ensure serial_no column exists in quotation_items
(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE quotation_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});
    console.log("quotation_items table migrated successfully");
  } catch (err) {
    console.error("Error migrating quotation_items table:", err.message);
  }
})();

// Auto Generate Quotation Number (AT/QTN/xxxx)
async function generateQuotationNumber () {
    const [rows] = await db.promise().query(
        "SELECT quotation_no FROM quotation"
    );
    let maxNo = 81;
    rows.forEach(({ quotation_no }) => {
        const m = String(quotation_no).match(/^AT\/QTN[\/-](\d+)$/);
        if (m) { const n = parseInt(m[1], 10); if (n > maxNo) maxNo = n; }
    });
    const nextId = maxNo + 1;
    return `AT/QTN/${nextId.toString().padStart(4, '0')}`;
}

// Get Bill No
router.get("/next-Qt-billno", async (req,res) =>{
    try{
        const quotationNumber = await generateQuotationNumber();
        res.json({quotation_no : quotationNumber});
    }catch(error){
        console.error("Error Generating Quotation Number:", error); 
        res.status(500).json({message: error.message});
    }
});

// Get All Clients
router.get("/clients", async(req, res) => {
    try{
        const[rows] = await db.promise().query(
            "SELECT id, customer_name, state, gst_number FROM newclient ORDER BY customer_name ASC "
         );
         res.json(rows);
    }catch(error){
        res.status(500).json({message: error.message});
    }
});

// All clients Search

router.get("/clients/search", async(req, res) => {
    const {q} = req.query;
    const searchTerm = `%${q || ""}%`;
    try{
      const [rows] = await db.promise().query(
        "SELECT id, customer_name, state, gst_number FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
        [searchTerm]
      );
      res.json(rows);
    } catch(error){
        console.error("Error searching clients:", error);
        res.status(500).json({message: "Client search failed"});
    }
});


// Items By search 

router.get('/items/search', async(req,res) =>{
    const {q, type} = req.query;
    let query = "";
    let values = [`%${q || ""}%`];

    if(type === "service"){
        query = "SELECT service_name AS item_name, hsn_number From servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? ORDER BY service_name ASC LIMIT 20";
    }
    else if(type === "spare"){
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? ORDER BY spare_name ASC LIMIT 20";
    } 
    else if(type === "purchase_item"){
        query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? ORDER BY item_name ASC LIMIT 20";
    }
    else{
        return res.status(400).json({message: "Invalid item Type"});
    }   

    try{
        const[rows] = await db.promise().query(query, [...values, ...values]);
        res.json(rows);
    }catch(error){
        console.log("Error Searching Items:",error);
        res.status(500).json({message: "Item Search Failed"});
    }
});

// Get Items order Type

router.get('/items/:type', async (req, res) => {
  const type = req.params.type.toLowerCase();
  let query = "";

  if (type === 'service') {
    query = "SELECT service_name AS item_name, hsn_number FROM servicesdata ORDER BY service_name ASC";
  } else if (type === 'spare') {
    query = "SELECT spare_name AS item_name, hsn_number FROM sparedata ORDER BY spare_name ASC ";
  } else if (type === 'purchase_item') {
    query = "SELECT item_name, hsn_number FROM purchaseitems ORDER BY item_name ASC";
  } else {
    return res.status(400).json({ error: "Invalid type parameter" });
  }

  try {
    const [rows] = await db.promise().query(query);
    res.json(rows);
  } catch (error) {
    console.error("Error Fetching items:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Create New Quotation

router.post('/new', async (req, res) => {
  try {
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const quotationNumber = await generateQuotationNumber();

    const [result] = await db.promise().query(
      `INSERT INTO quotation 
      (customer_name, quotation_no, quotation_date, reference, discount, transport, subtotal, cgst, sgst, igst, round_off, grandTotal, tax_text, transport_terms, delivery_period, validity, payment_terms, guarantee_text, pack_frd, waranty, for_sign) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.customer_name,
        quotationNumber,
        emptyToNull(s.quotation_date),
        emptyToNull(s.reference),
        toNum(s.discount),
        toNum(s.transport),
        toNum(s.subtotal),
        toNum(s.cgst),
        toNum(s.sgst),
        toNum(s.igst),
        toNum(s.round_off),
        toNum(s.grandTotal),
        emptyToNull(s.tax_text),
        emptyToNull(s.transport_terms),
        emptyToNull(s.delivery_period),
        emptyToNull(s.validity),
        emptyToNull(s.payment_terms),
        emptyToNull(s.guarantee_text),
        emptyToNull(s.pack_frd),
        emptyToNull(s.waranty),
        emptyToNull(s.for_sign)
      ]
    );

    const quotationId = result.insertId;

    // Insert items
    for (const item of items) {
      const amount = (item.price || 0) * (item.quantity || 0);
      await db.promise().query(
        `INSERT INTO quotation_items 
        (quotation_id, item_name, price, quantity, part_no, uom, amount, serial_no) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          quotationId,
          emptyToNull(item.item_name),
          toNum(item.price),
          toNum(item.quantity),
          emptyToNull(item.part_no),
          emptyToNull(item.uom),
          amount,
          emptyToNull(item.serial_no)
        ]
      );
    }

    res.status(201).json({ message: "Quotation Created Successfully", quotation_no: quotationNumber });

  } catch (error) {
    console.error("Error Creating Quotation:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Update Quotation

router.put('/update/:quotationNo', async(req, res) => {
    try{
        const {quotationNo} = req.params;
        const s = sanitizeBody(req.body);
        const items = Array.isArray(req.body.items) ? req.body.items : [];

        // Get the quotation ID
        const [quotationRows] = await db.promise().query(
            "SELECT id FROM quotation WHERE quotation_no = ?",
            [quotationNo]
        );
        const quotationId = quotationRows[0].id;

        // Update the main quotation
        await db.promise().query(
            "UPDATE quotation SET customer_name=?, quotation_no=?, quotation_date=?, reference=?, discount=?, transport=?, subtotal=?, cgst=?, sgst=?, igst=?, round_off=?, grandTotal=?, tax_text=?, transport_terms=?, delivery_period=?, validity=?, payment_terms=?, guarantee_text=?, pack_frd=?, waranty=?, for_sign=? WHERE id=?",
            [s.customer_name, emptyToNull(s.quotation_no), emptyToNull(s.quotation_date), emptyToNull(s.reference), toNum(s.discount), toNum(s.transport), toNum(s.subtotal), toNum(s.cgst), toNum(s.sgst), toNum(s.igst), toNum(s.round_off), toNum(s.grandTotal), emptyToNull(s.tax_text), emptyToNull(s.transport_terms), emptyToNull(s.delivery_period), emptyToNull(s.validity), emptyToNull(s.payment_terms), emptyToNull(s.guarantee_text), emptyToNull(s.pack_frd), emptyToNull(s.waranty), emptyToNull(s.for_sign), quotationId]
        );

        // Delete existing items
        await db.promise().query(
            "DELETE FROM quotation_items WHERE quotation_id=?",
            [quotationId]
        );

        // Insert updated items
        for(const item of items){
            const amount = (item.price || 0) * (item.quantity || 0);
            await db.promise().query(
                "INSERT INTO quotation_items (quotation_id, item_name, price, quantity, part_no, uom, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [quotationId, emptyToNull(item.item_name), toNum(item.price), toNum(item.quantity), emptyToNull(item.part_no), emptyToNull(item.uom), amount, emptyToNull(item.serial_no)]
            );
        }
        res.json({message: "Quotation Updated Successfully"});
    }catch(error){
        console.error("Error Updating Quotation:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Get Qt Search

router.get('/QT/search', async(req, res) => {
    const {q} = req.query;
    const searchTerm = `%${q || ""}%`;

    try{
        const [rows] = await db.promise().query(
            "SELECT quotation_no FROM quotation WHERE quotation_no LIKE ? LIMIT 20",
            [searchTerm]
        );
        res.json(rows);
    }catch(error){
        console.error("Error Searching quotations:", error);
        res.status(500).json({message: "Quotation search failed"});
    }
});

// Get Existing Quotation
router.get('/edit/:quotationNo', async (req, res) => {
  try {
    const quotationNo = decodeURIComponent(req.params.quotationNo);

    // Fetch quotation header
    const [quotationRows] = await db.promise().query(
      "SELECT * FROM quotation WHERE quotation_no = ?",
      [quotationNo]
    );

    if (!quotationRows || quotationRows.length === 0) {
      return res.status(404).json({ message: "Quotation Not Found" });
    }

    const quotation = quotationRows[0];

    // Fetch quotation items
    const [itemRows] = await db.promise().query(
      "SELECT * FROM quotation_items WHERE quotation_id = ?",
      [quotation.id]
    );

    // Fetch client details for GST state detection
    const [clientRows] = await db.promise().query(
      "SELECT state, gst_number FROM newclient WHERE customer_name = ?",
      [quotation.customer_name]
    );

    res.json({
      header: quotation,
      items: itemRows,
      client: clientRows[0] || {}
    });

  } catch (error) {
    console.error("Error Fetching Quotation:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// delete existing qt

router.delete('/delete/:quotationNo', async (req, res) => {
  try {
    const quotationNo = decodeURIComponent(req.params.quotationNo);

    // Get quotation ID
    const [rows] = await db.promise().query(
      "SELECT id FROM quotation WHERE quotation_no = ?",
      [quotationNo]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "Quotation Not Found" });
    }

    const quotationId = rows[0].id;

    // Delete items first
    await db.promise().query(
      "DELETE FROM quotation_items WHERE quotation_id = ?",
      [quotationId]
    );

    // Delete main quotation
    await db.promise().query(
      "DELETE FROM quotation WHERE id = ?",
      [quotationId]
    );

    res.json({ message: "Quotation Deleted Successfully" });

  } catch (error) {
    console.error("Error Deleting Quotation:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Get All Quotations

router.get("/full/:quotationNo", async (req, res) => {
  const { quotationNo } = req.params;

  try{
    // Fetch quotation header
    const [quotationRows] = await db.promise().query(
      "SELECT * FROM quotation WHERE quotation_no = ?",
      [quotationNo]
    );

    if(!quotationRows || quotationRows.length === 0){
      return res.status(404).json({message: "Quotation Not Found"});
    }

    const quotation = quotationRows[0];

    // Fetch quotation items
    const [itemRows] = await db.promise().query(
      "SELECT * FROM quotation_items WHERE quotation_id = ?",
      [quotation.id]
    );

    // Fetch client details
    const [clientRows] = await db.promise().query(
      "SELECT * FROM newclient WHERE customer_name = ?",
      [quotation.customer_name]
    );

    res.json({
      header: quotation,
      items: itemRows,
      client: clientRows[0] || {}
    });
  }catch(error){
    console.error("Error Fetching Quotation:", error);
    res.status(500).json({message: "Internal Server Error"});
  }
});


// Gentrate Report filters

router.get("/report/filters", async (req, res) => {
    try{
        const {fromDate, toDate, quotationNo, clientName} = req.query;

        let query = `
        SELECT 
            q.quotation_no,
            q.quotation_date,
            q.customer_name,
            q.subtotal,
            q.cgst,
            q.sgst,
            q.igst,
            q.grandTotal,
            qi.item_name,
            qi.quantity,
            qi.price
        FROM quotation q
        LEFT JOIN quotation_items qi ON q.id = qi.quotation_id
        WHERE 1=1
        `;

        let values = [];

        if(fromDate && toDate){
            query += " AND q.quotation_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }

        if(quotationNo){
            query += " AND q.quotation_no = ?";
            values.push(quotationNo);
        }

        if(clientName){
            query += " AND q.customer_name = ?";
            values.push(clientName);
        }

        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    }catch(error){
        console.error("Report Error:", error);
        res.status(500).json({message: "Report Failed"});
    }
});


// Gentrate Excel

router.get("/report/excel", async (req, res) => {
    try{
        const {fromDate, toDate, quotationNo, clientName} = req.query;

        let query = `
        SELECT
            q.quotation_no,
            q.quotation_date,
            q.customer_name,
            q.subtotal,
            q.cgst,
            q.sgst,
            q.igst,
            q.grandTotal,
            qi.item_name,
            qi.quantity,
            qi.price
        FROM quotation q
        LEFT JOIN quotation_items qi ON q.id = qi.quotation_id
        WHERE 1=1
        `;

        let values = [];

        if(fromDate && toDate){
            query += " AND q.quotation_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }

        if(quotationNo){
            query += " AND q.quotation_no = ?";
            values.push(quotationNo);
        }

        if(clientName){
            query += " AND q.customer_name = ?";
            values.push(clientName);
        }

        const [rows] = await db.promise().query(query, values);

        // Create Excel Workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Quotation Report");

        // Add Header Row
        worksheet.columns = [
            {header: "SNO", key: "sno", width: 8},
            {header: "Quotation No", key: "quotation_no", width: 20},
            {header: "Date", key: "quotation_date", width: 15},
            {header: "Client Name", key: "customer_name", width: 25},
            {header: "Item Name", key: "item_name", width: 25},
            {header: "Quantity", key: "quantity", width: 12},
            {header: "Price", key: "price", width: 12},
            {header: "Subtotal", key: "subtotal", width: 15},
            {header: "CGST", key: "cgst", width: 10},
            {header: "SGST", key: "sgst", width: 10},
            {header: "IGST", key: "igst", width: 10},
            {header: "Grand Total", key: "grandTotal", width: 18}
        ];

        // add data Rows
        rows.forEach((row, index) => {
            worksheet.addRow({
                sno: index + 1,
                ...row
            });
        });

        // Style header
        worksheet.getRow(1).font = {bold: true};

        // send File
        res.setHeader(
          "content_Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "content-Disposition",
            "attachment; filename=Quotation_Report.xlsx"
        );
        await workbook.xlsx.write(res);
        res.end();

    }
    catch(error){
        console.error("Excel Export Error:", error);
        res.status(500).json({message: "Excel Export Failed"});
    }
  });

module.exports = router;