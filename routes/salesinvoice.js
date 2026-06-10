const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// INVOICE GENTRATE
async function GenerateInvoiceNumber() {
    const [rows] = await db.promise().query(`
        SELECT invoice_no FROM salesinvoice
        UNION ALL
        SELECT invoice_no FROM service_invoices
        UNION ALL
        SELECT invoice_no FROM directinvoice
    `);

    let maxNumber = 0;

    rows.forEach(row => {
        if (!row.invoice_no) return;

        const match = row.invoice_no.match(/AT\/INV\/(\d+)/);

        if (match) {
            maxNumber = Math.max(
                maxNumber,
                parseInt(match[1], 10)
            );
        }
    });

    const nextNumber = maxNumber + 1;

    return `AT/INV/${String(nextNumber).padStart(3, "0")}`;
}

// Get Bill No
router.get("/next-In-billno", async (req, res) => {
    try {
        const InvoiceNumber = await GenerateInvoiceNumber();
        res.json({ invoice_no: InvoiceNumber });
    } catch (error) {
        console.error("Error Generating Invoice Number:", error);
        res.status(500).json({ message: error.message });
    }
});

// Get All Clients — only those who have a Sales DC entry
router.get("/report/customers", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT DISTINCT customer_name FROM salesinvoice ORDER BY customer_name ASC`
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching report customers:", error);
        res.status(500).json({ message: error.message });
    }
});

router.get("/clients", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT DISTINCT customer_name FROM sales_dc_entries ORDER BY customer_name ASC`
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching clients:", error);
        res.status(500).json({ message: error.message });
    }
});

// Get All clients Search — only those who have a Sales DC entry
router.get('/clients/search', async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            `SELECT DISTINCT customer_name FROM sales_dc_entries WHERE customer_name LIKE ? ORDER BY customer_name ASC`,
            [`%${q}%`]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error searching clients:", error);
        res.status(500).json({ message: "Client search failed" });
    }
});

// Sales DC Search — filtered by customer, only Service remarks, excludes already-invoiced DCs
router.get('/sales-dc/search', async (req, res) => {
    const { q, customer } = req.query;

    let query = `
        SELECT
            sde.dc_no,
            sde.payment_terms AS client_dc_no,
            sde.dc_date,
            sde.Client_dc_date,
            sde.order_no,
            sde.order_date,
            sde.despatch_through,
            sde.ordertype
        FROM sales_dc_entries sde
        WHERE
            (sde.dc_no LIKE ? OR sde.payment_terms LIKE ?)

            -- Only Service DC
            AND EXISTS (
                SELECT 1
                FROM sales_dc_items sdi
                WHERE sdi.dc_id = sde.id
                AND sdi.remarks = 'Service'
            )

            -- Hide Completed DC
            AND (sde.status IS NULL OR sde.status <> 'Completed')

            -- Hide Already Invoiced DC
            AND NOT EXISTS (
                SELECT 1
                FROM salesinvoice si
                WHERE si.dc_no = sde.dc_no
            )
    `;

    const params = [`%${q || ""}%`, `%${q || ""}%`];

    if (customer) {
        query += ` AND sde.customer_name = ? `;
        params.push(customer);
    }

    query += ` ORDER BY sde.id DESC LIMIT 50`;

    try {
        const [rows] = await db.promise().query(query, params);
        res.json(rows);
    } catch (error) {
        console.error("Sales DC Search Error:", error);
        res.status(500).json({ message: "Search Failed" });
    }
});

// Fetch Sales DC Full Data for auto-fill
router.get('/sales-dc/:dcNo', async (req, res) => {
    try {
        const dcNo = decodeURIComponent(req.params.dcNo);
        const [dcRows] = await db.promise().query(
            "SELECT * FROM sales_dc_entries WHERE dc_no = ?", [dcNo]
        );
        if (!dcRows.length) return res.status(404).json({ message: "DC Not Found" });
        const dcEntry = dcRows[0];
        const [itemRows] = await db.promise().query(`SELECT * FROM sales_dc_items
        WHERE dc_id = ? AND remarks='Service'`, [dcEntry.id]);
        res.json({ header: dcEntry, items: itemRows });
    } catch (error) {
        console.error("Sales DC Fetch Error:", error);
        res.status(500).json({ message: "Server Error" });
    }
});

// Item By Search
router.get('/items/search', async (req, res) => {
    const { q, type } = req.query;
    let query = "";
    let values = [`%${q || ""}%`];

    if (type === "service") {
        query = "SELECT service_name AS item_name, hsn_number From servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else if (type === "spare") {
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else if (type === "purchase_item") {
        query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else {
        return res.status(400).json({ message: "Invalid item Type" });
    }

    try {
        const [rows] = await db.promise().query(query, [...values, ...values]);
        res.json(rows);
    } catch (error) {
        console.log("Error Searching Items:", error);
        res.status(500).json({ message: "Item Search Failed" });
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
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.customer_name || !s.invoice_no || !s.invoice_date || !items.length) {
        return res.status(400).json({ message: "Customer, Invoice No, Invoice Date and at least one item are required" });
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.query(
            `INSERT INTO salesinvoice 
             (customer_name, invoice_no, invoice_date, dc_no, dc_date, order_no, order_date, payment_terms, dispatch_through, discount, transport, subtotal, cgst, sgst, igst, round_off, grandtotal, ordertype)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                s.customer_name,
                s.invoice_no,
                s.invoice_date,
                emptyToNull(s.dc_no),
                emptyToNull(s.dc_date),
                emptyToNull(s.order_no),
                emptyToNull(s.order_date),
                emptyToNull(s.payment_terms),
                emptyToNull(s.dispatch_through),
                toNum(s.discount),
                toNum(s.transport),
                toNum(s.subtotal),
                toNum(s.cgst),
                toNum(s.sgst),
                toNum(s.igst),
                toNum(s.round_off),
                toNum(s.grandtotal),
                emptyToNull(s.ordertype)
            ]
        );

        const invoiceId = result.insertId;
        if (s.dc_no) {await conn.query(
        `UPDATE sales_dc_entries SET status='Completed'
         WHERE dc_no=?`,
        [s.dc_no]
    );
}

        const itemSql = `INSERT INTO salesinvoice_items 
               (invoice_id, item_name, price, quantity, uom, hsn_number, amount) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`;

        for (const item of items) {
            const amount = toNum(item.price) * toNum(item.quantity);
            await conn.query(itemSql, [
                invoiceId,
                emptyToNull(item.item_name),
                toNum(item.price),
                toNum(item.quantity),
                emptyToNull(item.uom),
                emptyToNull(item.hsn_number),
                amount
            ]);
        }

        await conn.commit();
        res.json({ message: "Sales Invoice Created Successfully", invoiceId });
    } catch (error) {
        await conn.rollback();
        console.error("Error Creating Sales Invoice:", error);
        res.status(500).json({ message: "Internal Server Error" });
    } finally {
        conn.release();
    }
});

// Update Invoice
router.put('/update/:invoiceNo', async (req, res) => {
    const { invoiceNo } = req.params;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.customer_name || !s.invoice_no || !s.invoice_date || !items.length) {
        return res.status(400).json({ message: "Customer, Invoice No, Invoice Date and at least one item are required" });
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [invoiceRows] = await conn.query(
            "SELECT id FROM salesinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );
        if (!invoiceRows.length) {
            await conn.rollback();
            return res.status(404).json({ message: "Invoice not found" });
        }
        const invoiceId = invoiceRows[0].id;

        await conn.query(
            "UPDATE salesinvoice SET customer_name=?, invoice_no=?, invoice_date=?, dc_no=?, dc_date=?, order_no=?, order_date=?, payment_terms=?, dispatch_through=?, discount=?, transport=?, subtotal=?, cgst=?, sgst=?, igst=?, round_off=?, grandtotal=?, ordertype=? WHERE id=?",
            [
                s.customer_name, s.invoice_no, s.invoice_date,
                emptyToNull(s.dc_no), emptyToNull(s.dc_date),
                emptyToNull(s.order_no), emptyToNull(s.order_date),
                emptyToNull(s.payment_terms), emptyToNull(s.dispatch_through),
                toNum(s.discount), toNum(s.transport), toNum(s.subtotal),
                toNum(s.cgst), toNum(s.sgst), toNum(s.igst),
                toNum(s.round_off), toNum(s.grandtotal),
                emptyToNull(s.ordertype), invoiceId
            ]
        );

        await conn.query("DELETE FROM salesinvoice_items WHERE invoice_id=?", [invoiceId]);

        const itemSql = "INSERT INTO salesinvoice_items (invoice_id, item_name, price, quantity, uom, hsn_number, amount) VALUES (?, ?, ?, ?, ?, ?, ?)";
        for (const item of items) {
            const amount = toNum(item.price) * toNum(item.quantity);
            await conn.query(itemSql, [
                invoiceId,
                emptyToNull(item.item_name),
                toNum(item.price),
                toNum(item.quantity),
                emptyToNull(item.uom),
                emptyToNull(item.hsn_number),
                amount
            ]);
        }

        await conn.commit();
        res.json({ message: "Sales Invoice Updated Successfully" });
    } catch (error) {
        await conn.rollback();
        console.error("Error Updating Sales Invoice:", error);
        res.status(500).json({ message: "Internal Server Error" });
    } finally {
        conn.release();
    }
});

// Invoice Delete
router.delete('/delete/:invoiceNo', async (req, res) => {
    try {
        const { invoiceNo } = req.params;

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

        res.json({ message: "Sales Invoice Deleted Successfully" });
    } catch (error) {
        console.error("Error Deleting Sales Invoice:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Get Existing invoice for edit/print
router.get('/edit/:invoiceNo', async (req, res) => {
    try {
        const invoiceNo = decodeURIComponent(req.params.invoiceNo);

        // Fetch Invoice Header
        const [invoiceRows] = await db.promise().query(
            "SELECT * FROM salesinvoice WHERE invoice_no = ?",
            [invoiceNo]
        );

        if (!invoiceRows || invoiceRows.length === 0) {
            return res.status(404).json({ message: "Sales Invoice Not Found" });
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
    } catch (error) {
        console.error("Error Fetching Sales Invoice:", error);
        res.status(500).json({ message: "Internal Server Error" });
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
router.get('/INV/search', async (req, res) => {
    const { q } = req.query;
    const searchTerm = `%${q || ""}%`;
    try {
        const [rows] = await db.promise().query(
            "SELECT invoice_no FROM salesinvoice WHERE invoice_no LIKE ?",
            [searchTerm]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error Searching Sales Invoice:", error);
        res.status(500).json({ message: "Sales Invoice search failed" });
    }
});

// Pending Bills Report — invoices where balance > 0 (supports date + customer filters)
router.get("/report/pending-bills", async (req, res) => {
    try {
        const { fromDate, toDate, clientName } = req.query;

        let query = `
            SELECT
                si.customer_name,
                si.invoice_no,
                si.invoice_date,
                si.grandtotal AS bill_amount,
                COALESCE(SUM(ri.paid_amount), 0) AS paid_amount,
                (si.grandtotal - COALESCE(SUM(ri.paid_amount), 0)) AS balance_amount
            FROM salesinvoice si
            LEFT JOIN receipt_items ri ON ri.bill_no = si.invoice_no
            WHERE 1=1
        `;
        const values = [];

        if (fromDate && toDate) {
            query += " AND si.invoice_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }
        if (clientName) {
            query += " AND si.customer_name = ?";
            values.push(clientName);
        }

        query += `
            GROUP BY si.id, si.customer_name, si.invoice_no, si.invoice_date, si.grandtotal
            HAVING (si.grandtotal - COALESCE(SUM(ri.paid_amount), 0)) > 0
            ORDER BY si.invoice_no ASC
        `;

        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    } catch (error) {
        console.error("Pending Bills Error:", error);
        res.status(500).json({ message: "Failed to fetch pending bills" });
    }
});

// Gentrate Report filters
router.get("/report/filters", async (req, res) => {
    try {
        const { fromDate, toDate, invoiceNo, clientName } = req.query;

        let query = `
        SELECT
            s.invoice_no,
            s.invoice_date,
            s.customer_name,
            MAX(COALESCE(nc.gst_number, '')) AS gst_no,
            s.subtotal AS taxable_value,
            s.cgst AS cgst_amount,
            s.sgst AS sgst_amount,
            s.igst AS igst_amount,
            s.grandtotal AS total_invoice_value,
            ROUND(CASE WHEN s.subtotal > 0 THEN (s.cgst / s.subtotal) * 100 ELSE 0 END, 2) AS cgst_percent,
            ROUND(CASE WHEN s.subtotal > 0 THEN (s.sgst / s.subtotal) * 100 ELSE 0 END, 2) AS sgst_percent,
            ROUND(CASE WHEN s.subtotal > 0 THEN (s.igst / s.subtotal) * 100 ELSE 0 END, 2) AS igst_percent,
            GROUP_CONCAT(DISTINCT si.hsn_number ORDER BY si.hsn_number SEPARATOR ', ') AS hsn_sac,
            SUM(si.quantity) AS total_qty
        FROM salesinvoice s
        LEFT JOIN salesinvoice_items si ON s.id = si.invoice_id
        LEFT JOIN newclient nc ON s.customer_name = nc.customer_name
        WHERE 1=1
        `;

        let values = [];

        if (fromDate && toDate) {
            query += " AND s.invoice_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }

        if (invoiceNo) {
            query += " AND s.invoice_no = ?";
            values.push(invoiceNo);
        }

        if (clientName) {
            query += " AND s.customer_name = ?";
            values.push(clientName);
        }

        query += " GROUP BY s.id, s.invoice_no, s.invoice_date, s.customer_name, s.subtotal, s.cgst, s.sgst, s.igst, s.grandtotal ORDER BY s.invoice_date DESC, s.invoice_no DESC";

        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    } catch (error) {
        console.error("Report Error:", error);
        res.status(500).json({ message: "Report Failed" });
    }
});

// Gentrate Excel
router.get("/report/excel", async (req, res) => {
    try {
        const { fromDate, toDate, invoiceNo, clientName } = req.query;

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

        if (fromDate && toDate) {
            query += " AND s.invoice_date BETWEEN ? AND ?";
            values.push(fromDate, toDate);
        }

        if (invoiceNo) {
            query += " AND s.invoice_no = ?";
            values.push(invoiceNo);
        }

        if (clientName) {
            query += " AND s.customer_name = ?";
            values.push(clientName);
        }

        const [rows] = await db.promise().query(query, values);

        // Create Excel Workbook (Assuming exceljs is required)
        const ExcelJS = require("exceljs");
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Sales Invoice Report");

        worksheet.columns = [
            { header: "SNO", key: "sno", width: 8 },
            { header: "Invoice No", key: "invoice_no", width: 20 },
            { header: "Date", key: "invoice_date", width: 15 },
            { header: "Client Name", key: "customer_name", width: 25 },
            { header: "Item Name", key: "item_name", width: 25 },
            { header: "Quantity", key: "quantity", width: 12 },
            { header: "Price", key: "price", width: 12 },
            { header: "Subtotal", key: "subtotal", width: 15 },
            { header: "CGST", key: "cgst", width: 10 },
            { header: "SGST", key: "sgst", width: 10 },
            { header: "IGST", key: "igst", width: 10 },
            { header: "Grand Total", key: "grandtotal", width: 18 }
        ];

        rows.forEach((row, index) => {
            worksheet.addRow({
                sno: index + 1,
                ...row
            });
        });

        worksheet.getRow(1).font = { bold: true };

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=Sales_Invoice_Report.xlsx");
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Excel Export Error:", error);
        res.status(500).json({ message: "Excel Export Failed" });
    }
});

module.exports = router;
