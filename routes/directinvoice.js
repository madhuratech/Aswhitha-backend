const express = require("express");
const router = express.Router();
const db = require("../config/database");
const axios = require("axios");



// Self-migration: ensure serial_no column exists in invoice_items
(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE invoice_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});
    console.log("invoice_items table migrated successfully");
  } catch (err) {
    console.error("Error migrating invoice_items table:", err.message);
  }
})();

const { generateNextInvoiceNo } = require("../helpers/invoiceNumber");

// Get Bill No
router.get("/next-In-billno", async (req, res) => {
    try {
        const invoice_no = await generateNextInvoiceNo();
        res.json({ invoice_no });
    } catch (error) {
        console.error("Error Generating Invoice Number:", error);
        res.status(500).json({ message: error.message });
    }
});

// Get All Clients

router.get("/clients", async (req, res) => {
    try{
        const [rows] = await db.promise().query("SELECT id, customer_name, state, gst_number FROM newclient ORDER BY customer_name ASC");
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
            "SELECT id, customer_name, state, gst_number FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
            ["%" + q + "%"]
        );
        res.json(rows);
    }catch(error){
        console.error("Error searching clients:", error);
        res.status(500).json({message: "Client search failed"});
    }
});

//   Item By Search

router.get('/items/search', async(req,res) =>{
    const {q, type} = req.query;
    let query = "";
    let values = ["%" + (q || "") + "%"];

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


//   Create New invoice

router.post('/new', async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
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
            gst_rate,
        } = req.body;

        const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
        if (!dispatch_through?.trim() || !ALLOWED_DESPATCH.includes(dispatch_through.trim())) {
            return res.status(400).json({ message: "Despatch Through cannot be null." });
        }

        try {
            const [result] = await db.promise().query(
                "INSERT INTO directinvoice (customer_name, invoice_no, invoice_date, dc_no, dc_date, order_no, order_date, payment_terms, dispatch_through, discount, transport, subtotal, cgst, sgst, igst, round_off, grandtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                ]
            );

            const invoiceId = result.insertId;

            for (const item of items) {
                const amount = item.price * item.quantity;
                await db.promise().query(
                    "INSERT INTO invoice_items (invoice_id, item_name, price, quantity, uom, hsn_number, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        invoiceId,
                        item.item_name,
                        item.price,
                        item.quantity,
                        item.uom,
                        item.hsn_number,
                        amount,
                        item.serial_no || null
                    ]
                );
            }

            // Mark DC numbers as completed in dc_status
            if (dc_no) {
                const dcNos = (dc_no || "").split(",").map(d => d.trim()).filter(Boolean);
                for (const dcNo of dcNos) {
                    await db.promise().query(
                        "INSERT INTO dc_status (dc_number, dc_type, status, invoice_type) VALUES (?, 'DirectDC', 'Completed', 'DirectInvoice') ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'DirectInvoice'",
                        [dcNo]
                    );
                }
            }

            return res.json({ message: "Invoice Created Successfully", invoiceId, invoice_no: invoice_no });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY' && attempts < MAX_ATTEMPTS) {
                const newNo = await GenerateInvoiceNumber();
                req.body.invoice_no = newNo;
                continue;
            }
            console.error("Error Creating Invoice:", error);
            return res.status(500).json({ message: "Internal Server Error" });
        }
    }
    res.status(500).json({ message: "Failed to create invoice after multiple attempts" });
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
            gst_rate,
        } = req.body;

        const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
        if (!dispatch_through?.trim() || !ALLOWED_DESPATCH.includes(dispatch_through.trim())) {
            return res.status(400).json({ message: "Despatch Through cannot be null." });
        }

        // Get the Invoice ID
        const [invoiceRows] = await db.promise().query(
            "SELECT id FROM directinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );
        const invoiceId = invoiceRows[0].id;

        // Update the main Invoice
        await db.promise().query(
            "UPDATE directinvoice SET customer_name=?, invoice_no=?, invoice_date=?, dc_no=?, dc_date=?, order_no=?, order_date=?, payment_terms=?, dispatch_through=?, discount=?, transport=?, subtotal=?, cgst=?, sgst=?, igst=?, round_off=?, grandtotal=? WHERE id=?",
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
                invoiceId
            ]
        );

        // Delete existing items
        await db.promise().query(
            "DELETE FROM invoice_items WHERE invoice_id=?",
            [invoiceId]
        );

        // Insert updated items
        for(const item of items){
            const amount = item.price * item.quantity;
            await db.promise().query(
                "INSERT INTO invoice_items (invoice_id, item_name, price, quantity, uom, hsn_number, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    invoiceId,
                    item.item_name,
                    item.price,
                    item.quantity,
                    item.uom,
                    item.hsn_number,
                    amount,
                    item.serial_no || null
                ]
            );
        }

        // Mark DC numbers as completed in dc_status
        if (dc_no) {
            const dcNos = (dc_no || "").split(",").map(d => d.trim()).filter(Boolean);
            for (const dcNo of dcNos) {
                await db.promise().query(
                    "INSERT INTO dc_status (dc_number, dc_type, status, invoice_type) VALUES (?, 'DirectDC', 'Completed', 'DirectInvoice') ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'DirectInvoice'",
                    [dcNo]
                );
            }
        }

        res.json({message: "Invoice Updated Successfully"});
    }catch(error){
        console.error("Error Updating Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Invoice Delete
router.delete('/delete/:invoiceNo', async(req, res) => {
    try{
        const {invoiceNo} = req.params;

        // Get Invoice ID
        const [invoiceRows] = await db.promise().query(
            "SELECT id FROM directinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );
        const invoiceId = invoiceRows[0].id;

        // Delete Items
        await db.promise().query(
            "DELETE FROM invoice_items WHERE invoice_id=?",
            [invoiceId]
        );

        // Delete Invoice
        await db.promise().query(
            "DELETE FROM directinvoice WHERE id=?",
            [invoiceId]
        );

        res.json({message: "Invoice Deleted Successfully"});
    }catch(error){
        console.error("Error Deleting Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});


// Get Existing invoice

router.get('/edit/:invoiceNo', async (req, res) => {
    try{
        const invoiceNo = decodeURIComponent(req.params.invoiceNo);

        // Fetch Invoice Header
        const [invoiceRows] = await db.promise().query(
            "SELECT * FROM directinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );

        if(!invoiceRows || invoiceRows.length === 0){
            return res.status(404).json({message: "Invoice Not Found"});
        }
        const invoice = invoiceRows[0];

        // Fetch Invoice Items
        const [itemRows] = await db.promise().query(
            "SELECT * FROM invoice_items WHERE invoice_id = ?",
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
        console.error("Error Fetching Invoice:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Get all direct invoices for report
router.get('/report/all', async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            "SELECT d.*, COUNT(i.id) AS item_count FROM directinvoice d LEFT JOIN invoice_items i ON d.id = i.invoice_id GROUP BY d.id ORDER BY d.invoice_date DESC, d.id DESC"
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching Direct Invoice report:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// invoicenumber search
router.get('/INV/search', async(req,res) =>{
    const {q} = req.query;
    const searchTerm = "%" + (q || "") + "%";
    try{
        const [rows] = await db.promise().query(
            "SELECT invoice_no FROM directinvoice WHERE invoice_no LIKE ? ORDER BY id DESC",
            [searchTerm]
        );
        res.json(rows);
    }catch(error){
        console.error("Error Searching Invoice:", error);
        res.status(500).json({message: "Invoice search failed"});
    }
});

module.exports = router;
