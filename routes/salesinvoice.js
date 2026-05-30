const express = require("express");
const router = express.Router();
const db = require("../config/database");

// INVOICE GENTRATE
async function InvoiceGentrate(){
const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM salesinvoice"
);
let lastId = rows[0].lastId || 0;
let nextId = lastId + 1;   
return `AT/SINV-${nextId.toString().padStart(3,'0')}`; 
}

// Get Bill No
router.get("/next-In-billno", async (req,res) =>{
    try{
        const InvoiceNumber = await InvoiceGentrate();
        res.json({invoice_no : InvoiceNumber}); 
    }catch(error){
        console.error("Error Generating Invoice Number:", error);
        res.status(500).json({message: error.message});
    }
});

// Get All Clients
router.get("/clients", async (req, res) => {
    try{
        const [rows] = await db.promise().query("SELECT id, customer_name FROM newclient");
        res.json(rows);
    }catch(error){
        console.error("Error fetching clients:", error);
        res.status(500).json({message: error.message});
    }
});

// Get All clients Search
router.get('/clients/search', async(req,res) =>{
    const {q} = req.query;
    try{
        const [rows] = await db.promise().query(
            "SELECT id, customer_name FROM newclient WHERE customer_name LIKE ?",
            [`%${q}%`]
        );
        res.json(rows);
    }catch(error){
        console.error("Error searching clients:", error);
        res.status(500).json({message: "Client search failed"});
    }
});

// Item By Search
router.get('/items/search', async(req,res) =>{
    const {q, type} = req.query;
    let query = "";
    let values = [`%${q || ""}%`];

    if(type === "service"){
        query = "SELECT service_name AS item_name, hsn_number From servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else if(type === "spare"){
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    } 
    else if(type === "purchase_item"){
        query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
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

// Get All By Item 
router.get('/items/:type', async (req, res) => {
    const type = req.params.type.toLowerCase();
    let query = "";
  
    if (type === 'service') {
      query = "SELECT service_name AS item_name, hsn_number FROM servicesdata";
    } else if (type === 'spare') {
      query = "SELECT spare_name AS item_name, hsn_number FROM sparedata";
    } else if (type === 'purchase_item') {
      query = "SELECT item_name, hsn_number FROM purchaseitems";
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

// Create New invoice
router.post('/new', async (req, res) => {
    try{
        const {
            customer_name,
            invoice_no,
            invoice_date,
            dc_no,
            dc_date,
            order_no,
            order_date,
            payment_terms,
            dispatch_through,
            discount,
            transport,
            subtotal,
            cgst,
            sgst,
            igst,
            round_off,
            grandtotal,
            items,
            ordertype
        } = req.body;

        const [result] = await db.promise().query(
            `INSERT INTO salesinvoice 
             (customer_name, invoice_no, invoice_date, dc_no, dc_date, order_no, order_date, payment_terms, dispatch_through, discount, transport, subtotal, cgst, sgst, igst, round_off, grandtotal, ordertype)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                customer_name,
                invoice_no,
                invoice_date,
                dc_no || null,
                dc_date || null,
                order_no || null,
                order_date || null,
                payment_terms || null,
                dispatch_through || null,
                discount || 0,
                transport || 0,
                subtotal || 0,
                cgst || 0,
                sgst || 0,
                igst || 0,
                round_off || 0,
                grandtotal || 0,
                ordertype || null
            ]
        );

        const invoiceId = result.insertId;

        // Insert Items
        for (const item of items){
            const amount = item.price * item.quantity;
            await db.promise().query(
               `INSERT INTO salesinvoice_items 
               (invoice_id, item_name, price, quantity, uom, hsn_number, amount) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    invoiceId,
                    item.item_name,
                    item.price,
                    item.quantity,
                    item.uom,
                    item.hsn_number,
                    amount
                ]
            );
        }
        res.json({message: "Sales Invoice Created Successfully", invoiceId});

    }catch(error){
        console.error("Error Creating Sales Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Update Invoice
router.put('/update/:invoiceNo', async(req, res) => {
    try{
        const {invoiceNo} = req.params;
        const {
            customer_name,
            invoice_no,
            invoice_date,
            dc_no,
            dc_date,
            order_no,
            order_date,
            payment_terms,
            dispatch_through,
            discount,
            transport,
            subtotal,
            cgst,
            sgst,
            igst,
            round_off,
            grandtotal,
            items,
            ordertype
        } = req.body;

        // Get the Invoice ID
        const [invoiceRows] = await db.promise().query(
            "SELECT id FROM salesinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );
        const invoiceId = invoiceRows[0].id;

        // Update the main Invoice
        await db.promise().query(
            "UPDATE salesinvoice SET customer_name=?, invoice_no=?, invoice_date=?, dc_no=?, dc_date=?, order_no=?, order_date=?, payment_terms=?, dispatch_through=?, discount=?, transport=?, subtotal=?, cgst=?, sgst=?, igst=?, round_off=?, grandtotal=?, ordertype=? WHERE id=?",
            [
                customer_name,
                invoice_no,
                invoice_date,
                dc_no || null,
                dc_date || null,
                order_no || null,
                order_date || null,
                payment_terms || null,
                dispatch_through || null,
                discount || 0,
                transport || 0,
                subtotal || 0,
                cgst || 0,
                sgst || 0,
                igst || 0,
                round_off || 0,
                grandtotal || 0,
                ordertype || null,
                invoiceId
            ]
        );

        // Delete existing items
        await db.promise().query(
            "DELETE FROM salesinvoice_items WHERE invoice_id=?",
            [invoiceId]
        );

        // Insert updated items
        for(const item of items){
            const amount = item.price * item.quantity;
            await db.promise().query(
                "INSERT INTO salesinvoice_items (invoice_id, item_name, price, quantity, uom, hsn_number, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    invoiceId,
                    item.item_name,
                    item.price,
                    item.quantity,
                    item.uom,
                    item.hsn_number,
                    amount
                ]
            );
        }
        res.json({message: "Sales Invoice Updated Successfully"});
    }catch(error){
        console.error("Error Updating Sales Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Invoice Delete
router.delete('/delete/:invoiceNo', async(req, res) => {
    try{
        const {invoiceNo} = req.params;

        // Get Invoice ID
        const [invoiceRows] = await db.promise().query(
            "SELECT id FROM salesinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );
        const invoiceId = invoiceRows[0].id;

        // Delete Items
        await db.promise().query(
            "DELETE FROM salesinvoice_items WHERE invoice_id=?",
            [invoiceId]
        );

        // Delete Invoice
        await db.promise().query(
            "DELETE FROM salesinvoice WHERE id=?",
            [invoiceId]
        );

        res.json({message: "Sales Invoice Deleted Successfully"});
    }catch(error){
        console.error("Error Deleting Sales Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Get Existing invoice for edit/print
router.get('/edit/:invoiceNo', async (req, res) => {
    try{
        const invoiceNo = decodeURIComponent(req.params.invoiceNo);

        // Fetch Invoice Header
        const [invoiceRows] = await db.promise().query(
            "SELECT * FROM salesinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );

        if(!invoiceRows || invoiceRows.length === 0){
            return res.status(404).json({message: "Sales Invoice Not Found"});
        }
        const invoice = invoiceRows[0];

        // Fetch Invoice Items
        const [itemRows] = await db.promise().query(
            "SELECT * FROM salesinvoice_items WHERE invoice_id = ?",
            [invoice.id]
        );

        // Fetch Client Details
        const [clientRows] = await db.promise().query(
            "SELECT * FROM newclient WHERE customer_name = ?",
            [invoice.customer_name]
        );

        res.json({
            header: invoice,
            items: itemRows,
            client: clientRows[0] || {}
        });
    }catch(error){
        console.error("Error Fetching Sales Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// FULL invoice details for view (same as edit but sometimes useful to have separate)
router.get('/full/:invoiceNo', async (req, res) => {
    try {
        const invoiceNo = decodeURIComponent(req.params.invoiceNo);
        const [invoiceRows] = await db.promise().query("SELECT * FROM salesinvoice WHERE invoice_no = ?", [invoiceNo]);
        if (!invoiceRows || invoiceRows.length === 0) return res.status(404).json({ message: "Sales Invoice Not Found" });
        const invoice = invoiceRows[0];
        const [itemRows] = await db.promise().query("SELECT * FROM salesinvoice_items WHERE invoice_id = ?", [invoice.id]);
        const [clientRows] = await db.promise().query("SELECT * FROM newclient WHERE customer_name = ?", [invoice.customer_name]);
        res.json({ header: invoice, items: itemRows, client: clientRows[0] || {} });
    } catch (error) {
        console.error("Error Fetching Full Sales Invoice:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// invoicenumber search
router.get('/INV/search', async(req,res) =>{
    const {q} = req.query;
    const searchTerm = `%${q || ""}%`;
    try{
        const [rows] = await db.promise().query(
            "SELECT invoice_no FROM salesinvoice WHERE invoice_no LIKE ?",
            [searchTerm]
        );
        res.json(rows);
    }catch(error){
        console.error("Error Searching Sales Invoice:", error);
        res.status(500).json({message: "Sales Invoice search failed"});
    }
});

// Gentrate Report filters
router.get("/report/filters", async (req, res) => {
    try{
        const {fromDate, toDate, invoiceNo, clientName} = req.query;

        let query = `
        SELECT 
            s.invoice_no,
            s.invoice_date,
            s.customer_name,
            s.subtotal,
            s.cgst,
            s.sgst,
            s.igst,
            s.grandtotal,
            si.item_name,
            si.quantity,
            si.price
        FROM salesinvoice s
        LEFT JOIN salesinvoice_items si ON s.id = si.invoice_id
        WHERE 1=1
        `;

        let values = [];

        if(fromDate && toDate){
            query += " AND s.invoice_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }

        if(invoiceNo){
            query += " AND s.invoice_no = ?";
            values.push(invoiceNo);
        }

        if(clientName){
            query += " AND s.customer_name = ?";
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
        const {fromDate, toDate, invoiceNo, clientName} = req.query;

        let query = `
        SELECT
            s.invoice_no,
            s.invoice_date,
            s.customer_name,
            s.subtotal,
            s.cgst,
            s.sgst,
            s.igst,
            s.grandtotal,
            si.item_name,
            si.quantity,
            si.price
        FROM salesinvoice s
        LEFT JOIN salesinvoice_items si ON s.id = si.invoice_id
        WHERE 1=1
        `;

        let values = [];

        if(fromDate && toDate){
            query += " AND s.invoice_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }

        if(invoiceNo){
            query += " AND s.invoice_no = ?";
            values.push(invoiceNo);
        }

        if(clientName){
            query += " AND s.customer_name = ?";
            values.push(clientName);
        }

        const [rows] = await db.promise().query(query, values);

        // Create Excel Workbook (Assuming exceljs is required)
        const ExcelJS = require("exceljs");
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Sales Invoice Report");

        worksheet.columns = [
            {header: "SNO", key: "sno", width: 8},
            {header: "Invoice No", key: "invoice_no", width: 20},
            {header: "Date", key: "invoice_date", width: 15},
            {header: "Client Name", key: "customer_name", width: 25},
            {header: "Item Name", key: "item_name", width: 25},
            {header: "Quantity", key: "quantity", width: 12},
            {header: "Price", key: "price", width: 12},
            {header: "Subtotal", key: "subtotal", width: 15},
            {header: "CGST", key: "cgst", width: 10},
            {header: "SGST", key: "sgst", width: 10},
            {header: "IGST", key: "igst", width: 10},
            {header: "Grand Total", key: "grandtotal", width: 18}
        ];

        rows.forEach((row, index) => {
            worksheet.addRow({
                sno: index + 1,
                ...row
            });
        });

        worksheet.getRow(1).font = {bold: true};

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=Sales_Invoice_Report.xlsx");
        await workbook.xlsx.write(res);
        res.end();

    } catch(error){
        console.error("Excel Export Error:", error);
        res.status(500).json({message: "Excel Export Failed"});
    }
});

module.exports = router;
