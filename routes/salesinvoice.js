const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

const { generateNextInvoiceNo } = require("../helpers/invoiceNumber");

// Self-migration: ensure serial_no column exists in salesinvoice_items
(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE salesinvoice_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});
    console.log("salesinvoice_items table migrated successfully");
  } catch (err) {
    console.error("Error migrating salesinvoice_items table:", err.message);
  }
})();

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

// Get All Clients — from all three invoice types
router.get("/report/customers", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT DISTINCT customer_name FROM (
                SELECT customer_name FROM salesinvoice
                UNION
                SELECT customer_name FROM service_invoices
                UNION
                SELECT customer_name FROM directinvoice
            ) t ORDER BY customer_name ASC`
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
            `SELECT DISTINCT sde.customer_name
             FROM sales_dc_entries sde
             WHERE EXISTS (
                 SELECT 1 FROM sales_dc_items sdi
                 WHERE sdi.dc_id = sde.id
                 AND sdi.remarks IN ('Serviced', 'For Sale')
             )
             AND NOT EXISTS (
                 SELECT 1 FROM dc_status ds
                 WHERE ds.dc_number = sde.dc_no
                 AND ds.dc_type = 'SalesDC'
                 AND ds.status = 'Completed'
             )
             ORDER BY sde.customer_name ASC`
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching clients:", error);
        res.status(500).json({ message: error.message });
    }
});

// Get All clients Search — only those who have a non-invoiced Sales DC entry
router.get('/clients/search', async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            `SELECT DISTINCT sde.customer_name, nc.state, nc.gst_number
             FROM sales_dc_entries sde
             LEFT JOIN newclient nc ON nc.customer_name = sde.customer_name
             WHERE sde.customer_name LIKE ?
             AND EXISTS (
                 SELECT 1 FROM sales_dc_items sdi
                 WHERE sdi.dc_id = sde.id
                 AND sdi.remarks IN ('Serviced', 'For Sale')
             )
             AND NOT EXISTS (
                 SELECT 1 FROM dc_status ds
                 WHERE ds.dc_number = sde.dc_no
                 AND ds.dc_type = 'SalesDC'
                 AND ds.status = 'Completed'
             )
             ORDER BY sde.customer_name ASC`,
            [`%${q}%`]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error searching clients:", error);
        res.status(500).json({ message: "Client search failed" });
    }
});

// Sales DC Search — filtered by customer, only invoice-eligible remarks, excludes already-invoiced DCs
router.get('/sales-dc/search', async (req, res) => {
    const { q, customer } = req.query;

    let query = `
        SELECT
            sde.dc_no,
            sde.customer_name,
            sde.dc_date,
            sde.order_no,
            sde.order_date,
            sde.despatch_through,
            sde.ordertype,
            (
              SELECT GROUP_CONCAT(
                  CONCAT(sdi2.item_name, ' × ', CAST(sdi2.quantity AS CHAR))
                  SEPARATOR ' | ')
              FROM sales_dc_items sdi2
              WHERE sdi2.dc_id = sde.id
              AND sdi2.remarks IN ('Serviced', 'For Sale')
            ) AS items_summary
        FROM sales_dc_entries sde
        WHERE
            (sde.dc_no LIKE ? OR sde.order_no LIKE ?)

            -- Only invoice-eligible DCs (Serviced / For Sale)
            AND EXISTS (
                SELECT 1
                FROM sales_dc_items sdi
                WHERE sdi.dc_id = sde.id
                AND sdi.remarks IN ('Serviced', 'For Sale')
            )

            -- Hide Already Invoiced DC (via dc_status)
            AND NOT EXISTS (
                SELECT 1
                FROM dc_status ds
                WHERE ds.dc_number = sde.dc_no
                AND ds.dc_type = 'SalesDC'
                AND ds.status = 'Completed'
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
        WHERE dc_id = ? AND remarks IN ('Serviced', 'For Sale')`, [dcEntry.id]);

        const allOrderNos = itemRows.map(item => item.order_no).filter(Boolean);
        const allOrderDates = itemRows.map(item => item.order_date).filter(Boolean);

        const aggregated_order_no = allOrderNos.length
            ? [...new Set(allOrderNos)].join(", ")
            : (dcEntry.order_no || "");

        const aggregated_order_date = allOrderDates.length
            ? [...new Set(allOrderDates)].join(", ")
            : (dcEntry.order_date || "");

        res.json({ header: dcEntry, items: itemRows, aggregated_order_no, aggregated_order_date });
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
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!req.body.customer_name || !req.body.invoice_no || !req.body.invoice_date || !items.length) {
        return res.status(400).json({ message: "Customer, Invoice No, Invoice Date and at least one item are required" });
    }

    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        const s = sanitizeBody(req.body);
        if (!s.dispatch_through?.trim()) {
            return res.status(400).json({ message: "Despatch Through cannot be null." });
        }
        const conn = await db.promise().getConnection();
        try {
            await conn.beginTransaction();

            const [result] = await conn.query(
                `INSERT INTO salesinvoice 
                 (customer_name, invoice_no, invoice_date, dc_no, dc_date, order_no, order_date, dispatch_through, discount, transport, subtotal, cgst, sgst, igst, round_off, grandtotal, ordertype)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    s.customer_name,
                    s.invoice_no,
                    s.invoice_date,
                    emptyToNull(s.dc_no),
                    emptyToNull(s.dc_date),
                    emptyToNull(s.order_no),
                    emptyToNull(s.order_date),
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

            const itemSql = `INSERT INTO salesinvoice_items
                   (invoice_id, item_name, price, quantity, uom, hsn_number, amount, order_no, order_date, dc_no, dc_date, serial_no)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

            for (const item of items) {
                const amount = toNum(item.price) * toNum(item.quantity);
                await conn.query(itemSql, [
                    invoiceId,
                    emptyToNull(item.item_name),
                    toNum(item.price),
                    toNum(item.quantity),
                    emptyToNull(item.uom),
                    emptyToNull(item.hsn_number),
                    amount,
                    emptyToNull(item.order_no),
                    emptyToNull(item.order_date),
                    emptyToNull(item.dc_no),
                    emptyToNull(item.dc_date),
                    emptyToNull(item.serial_no || item.sl_no)
                ]);
            }

            // Mark DC numbers as completed in dc_status
            if (s.dc_no) {
                const dcNos = (s.dc_no || "").split(",").map(d => d.trim()).filter(Boolean);
                for (const dcNo of dcNos) {
                    await conn.query(
                        `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
                         VALUES (?, 'SalesDC', 'Completed', 'SalesInvoice')
                         ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'SalesInvoice'`,
                        [dcNo]
                    );
                }
            }

            await conn.commit();
            return res.json({ message: "Sales Invoice Created Successfully", invoiceId, invoice_no: s.invoice_no });
        } catch (error) {
            await conn.rollback();
            if (error.code === 'ER_DUP_ENTRY' && attempts < MAX_ATTEMPTS) {
                const newNo = await GenerateInvoiceNumber();
                req.body.invoice_no = newNo;
                continue;
            }
            console.error("Error Creating Sales Invoice:", error);
            return res.status(500).json({ message: "Internal Server Error" });
        } finally {
            conn.release();
        }
    }
    res.status(500).json({ message: "Failed to create invoice after multiple attempts" });
});

// Update Invoice
router.put('/update/:invoiceNo', async (req, res) => {
    const { invoiceNo } = req.params;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.customer_name || !s.invoice_no || !s.invoice_date || !items.length) {
        return res.status(400).json({ message: "Customer, Invoice No, Invoice Date and at least one item are required" });
    }
    if (!s.dispatch_through?.trim()) {
        return res.status(400).json({ message: "Despatch Through cannot be null." });
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
            "UPDATE salesinvoice SET customer_name=?, invoice_no=?, invoice_date=?, dc_no=?, dc_date=?, order_no=?, order_date=?, dispatch_through=?, discount=?, transport=?, subtotal=?, cgst=?, sgst=?, igst=?, round_off=?, grandtotal=?, ordertype=? WHERE id=?",
            [
                s.customer_name, s.invoice_no, s.invoice_date,
                emptyToNull(s.dc_no), emptyToNull(s.dc_date),
                emptyToNull(s.order_no), emptyToNull(s.order_date),
                emptyToNull(s.dispatch_through),
                toNum(s.discount), toNum(s.transport), toNum(s.subtotal),
                toNum(s.cgst), toNum(s.sgst), toNum(s.igst),
                toNum(s.round_off), toNum(s.grandtotal),
                emptyToNull(s.ordertype), invoiceId
            ]
        );

        await conn.query("DELETE FROM salesinvoice_items WHERE invoice_id=?", [invoiceId]);

        const itemSql = "INSERT INTO salesinvoice_items (invoice_id, item_name, price, quantity, uom, hsn_number, amount, order_no, order_date, dc_no, dc_date, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        for (const item of items) {
            const amount = toNum(item.price) * toNum(item.quantity);
            await conn.query(itemSql, [
                invoiceId,
                emptyToNull(item.item_name),
                toNum(item.price),
                toNum(item.quantity),
                emptyToNull(item.uom),
                emptyToNull(item.hsn_number),
                amount,
                emptyToNull(item.order_no || item.client_dc_no),
                emptyToNull(item.order_date || item.client_dc_date),
                emptyToNull(item.dc_no),
                emptyToNull(item.dc_date),
                emptyToNull(item.serial_no || item.sl_no)
            ]);
        }

        // Mark DC numbers as completed in dc_status
        if (s.dc_no) {
            const dcNos = (s.dc_no || "").split(",").map(d => d.trim()).filter(Boolean);
            for (const dcNo of dcNos) {
                await conn.query(
                    `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
                     VALUES (?, 'SalesDC', 'Completed', 'SalesInvoice')
                     ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'SalesInvoice'`,
                    [dcNo]
                );
            }
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
        let [invoiceRows] = await db.promise().query("SELECT * FROM salesinvoice WHERE invoice_no = ?", [invoiceNo]);
        
        let invoice;
        let itemRows;
        let isDirect = false;

        if (!invoiceRows || invoiceRows.length === 0) {
            // Fallback to directinvoice
            const [directRows] = await db.promise().query("SELECT * FROM directinvoice WHERE invoice_no = ?", [invoiceNo]);
            if (!directRows || directRows.length === 0) {
                return res.status(404).json({ message: "Invoice Not Found" });
            }
            invoice = directRows[0];
            isDirect = true;
        } else {
            invoice = invoiceRows[0];
        }

        if (isDirect) {
            const [rows] = await db.promise().query("SELECT * FROM invoice_items WHERE invoice_id = ?", [invoice.id]);
            itemRows = rows;
        } else {
            const [rows] = await db.promise().query("SELECT * FROM salesinvoice_items WHERE invoice_id = ?", [invoice.id]);
            itemRows = rows;
        }

        const [clientRows] = await db.promise().query("SELECT * FROM newclient WHERE customer_name = ?", [invoice.customer_name]);
        res.json({ header: invoice, items: itemRows, client: clientRows[0] || {} });
    } catch (error) {
        console.error("Error Fetching Full Invoice:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// invoicenumber search
router.get('/INV/search', async (req, res) => {
    const { q } = req.query;
    const searchTerm = `%${q || ""}%`;
    try {
        const [rows] = await db.promise().query(
            "SELECT invoice_no FROM salesinvoice WHERE invoice_no LIKE ? ORDER BY id DESC",
            [searchTerm]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error Searching Sales Invoice:", error);
        res.status(500).json({ message: "Sales Invoice search failed" });
    }
});

// Pending Bills Report — invoices where balance > 0 from all three invoice types
router.get("/report/pending-bills", async (req, res) => {
    try {
        const { fromDate, toDate, clientName } = req.query;

        const filterClause = (dateCol, nameCol) => {
            const conds = [];
            if (fromDate && toDate) conds.push(`${dateCol} BETWEEN ? AND ?`);
            if (clientName) conds.push(`${nameCol} = ?`);
            return conds.length ? " AND " + conds.join(" AND ") : "";
        };

        const filterVals = (dateCol) => {
            const v = [];
            if (fromDate && toDate) v.push(fromDate, toDate);
            if (clientName) v.push(clientName);
            return v;
        };

        const siFilter = filterClause("si.invoice_date", "si.customer_name");
        const svFilter = filterClause("sv.invoice_date", "sv.customer_name");
        const diFilter = filterClause("d.invoice_date", "d.customer_name");

        const query = `
            SELECT customer_name, invoice_no, invoice_date, bill_amount, paid_amount, balance_amount
            FROM (
                SELECT
                    si.customer_name,
                    si.invoice_no,
                    si.invoice_date,
                    si.grandtotal AS bill_amount,
                    (
                      COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = si.invoice_no), 0)
                      + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = si.invoice_no), 0)
                    ) AS paid_amount,
                    (si.grandtotal
                      - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = si.invoice_no), 0)
                      - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = si.invoice_no), 0)
                    ) AS balance_amount
                FROM salesinvoice si
                WHERE 1=1 ${siFilter}

                UNION ALL

                SELECT
                    sv.customer_name,
                    sv.invoice_no,
                    sv.invoice_date,
                    sv.grand_total AS bill_amount,
                    (
                      COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0)
                      + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0)
                    ) AS paid_amount,
                    (sv.grand_total
                      - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0)
                      - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0)
                    ) AS balance_amount
                FROM service_invoices sv
                WHERE 1=1 ${svFilter}

                UNION ALL

                SELECT
                    d.customer_name,
                    d.invoice_no,
                    d.invoice_date,
                    d.grandtotal AS bill_amount,
                    (
                      COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0)
                      + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0)
                    ) AS paid_amount,
                    (d.grandtotal
                      - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0)
                      - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0)
                    ) AS balance_amount
                FROM directinvoice d
                WHERE 1=1 ${diFilter}
            ) combined
            WHERE balance_amount > 0
            ORDER BY invoice_no ASC
        `;

        const values = [...filterVals(), ...filterVals(), ...filterVals()];
        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    } catch (error) {
        console.error("Pending Bills Error:", error);
        res.status(500).json({ message: "Failed to fetch pending bills" });
    }
});

// Generate Report filters — combines Sales Invoice, Service Invoice, Direct Invoice
router.get("/report/filters", async (req, res) => {
    try {
        const { fromDate, toDate, invoiceNo, clientName } = req.query;

        const buildFilter = (dateCol, nameCol, noCol) => {
            const conds = [];
            if (fromDate && toDate) conds.push(`${dateCol} BETWEEN ? AND ?`);
            if (invoiceNo) conds.push(`${noCol} = ?`);
            if (clientName) conds.push(`${nameCol} = ?`);
            return conds.length ? " AND " + conds.join(" AND ") : "";
        };

        const filterVals = () => {
            const v = [];
            if (fromDate && toDate) v.push(fromDate, toDate);
            if (invoiceNo) v.push(invoiceNo);
            if (clientName) v.push(clientName);
            return v;
        };

        const siFilter = buildFilter("s.invoice_date", "s.customer_name", "s.invoice_no");
        const svFilter = buildFilter("sv.invoice_date", "sv.customer_name", "sv.invoice_no");
        const diFilter = buildFilter("d.invoice_date", "d.customer_name", "d.invoice_no");

        const query = `
            SELECT invoice_no, invoice_date, customer_name, gst_no, taxable_value,
                   cgst_amount, sgst_amount, igst_amount, total_invoice_value,
                   cgst_percent, sgst_percent, igst_percent, hsn_sac, total_qty, invoice_type,
                   paid_amount, balance_amount
            FROM (
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
                    SUM(si.quantity) AS total_qty,
                    'Sales Invoice' AS invoice_type,
                    (
                      COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = s.invoice_no), 0)
                      + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = s.invoice_no), 0)
                    ) AS paid_amount,
                    (s.grandtotal
                      - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = s.invoice_no), 0)
                      - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = s.invoice_no), 0)
                    ) AS balance_amount
                FROM salesinvoice s
                LEFT JOIN salesinvoice_items si ON s.id = si.invoice_id
                LEFT JOIN newclient nc ON s.customer_name = nc.customer_name
                WHERE 1=1 ${siFilter}
                GROUP BY s.id, s.invoice_no, s.invoice_date, s.customer_name, s.subtotal, s.cgst, s.sgst, s.igst, s.grandtotal

                UNION ALL

                SELECT
                    sv.invoice_no,
                    sv.invoice_date,
                    sv.customer_name,
                    MAX(COALESCE(nc.gst_number, '')) AS gst_no,
                    COALESCE(SUM(svi.amount), 0) AS taxable_value,
                    sv.cgst AS cgst_amount,
                    sv.sgst AS sgst_amount,
                    sv.igst AS igst_amount,
                    sv.grand_total AS total_invoice_value,
                    ROUND(CASE WHEN COALESCE(SUM(svi.amount), 0) > 0 THEN (sv.cgst / COALESCE(SUM(svi.amount), 0)) * 100 ELSE 0 END, 2) AS cgst_percent,
                    ROUND(CASE WHEN COALESCE(SUM(svi.amount), 0) > 0 THEN (sv.sgst / COALESCE(SUM(svi.amount), 0)) * 100 ELSE 0 END, 2) AS sgst_percent,
                    ROUND(CASE WHEN COALESCE(SUM(svi.amount), 0) > 0 THEN (sv.igst / COALESCE(SUM(svi.amount), 0)) * 100 ELSE 0 END, 2) AS igst_percent,
                    GROUP_CONCAT(DISTINCT svi.hsn_number ORDER BY svi.hsn_number SEPARATOR ', ') AS hsn_sac,
                    SUM(svi.quantity) AS total_qty,
                    'Service Invoice' AS invoice_type,
                    (
                      COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0)
                      + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0)
                    ) AS paid_amount,
                    (sv.grand_total
                      - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0)
                      - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0)
                    ) AS balance_amount
                FROM service_invoices sv
                LEFT JOIN service_invoice_items svi ON sv.id = svi.invoice_id
                LEFT JOIN newclient nc ON sv.customer_name = nc.customer_name
                WHERE 1=1 ${svFilter}
                GROUP BY sv.id, sv.invoice_no, sv.invoice_date, sv.customer_name, sv.cgst, sv.sgst, sv.igst, sv.grand_total

                UNION ALL

                SELECT
                    d.invoice_no,
                    d.invoice_date,
                    d.customer_name,
                    MAX(COALESCE(nc.gst_number, '')) AS gst_no,
                    d.subtotal AS taxable_value,
                    d.cgst AS cgst_amount,
                    d.sgst AS sgst_amount,
                    d.igst AS igst_amount,
                    d.grandtotal AS total_invoice_value,
                    ROUND(CASE WHEN d.subtotal > 0 THEN (d.cgst / d.subtotal) * 100 ELSE 0 END, 2) AS cgst_percent,
                    ROUND(CASE WHEN d.subtotal > 0 THEN (d.sgst / d.subtotal) * 100 ELSE 0 END, 2) AS sgst_percent,
                    ROUND(CASE WHEN d.subtotal > 0 THEN (d.igst / d.subtotal) * 100 ELSE 0 END, 2) AS igst_percent,
                    GROUP_CONCAT(DISTINCT ii.hsn_number ORDER BY ii.hsn_number SEPARATOR ', ') AS hsn_sac,
                    SUM(ii.quantity) AS total_qty,
                    'Direct Invoice' AS invoice_type,
                    (
                      COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0)
                      + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0)
                    ) AS paid_amount,
                    (d.grandtotal
                      - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0)
                      - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0)
                    ) AS balance_amount
                FROM directinvoice d
                LEFT JOIN invoice_items ii ON d.id = ii.invoice_id
                LEFT JOIN newclient nc ON d.customer_name = nc.customer_name
                WHERE 1=1 ${diFilter}
                GROUP BY d.id, d.invoice_no, d.invoice_date, d.customer_name, d.subtotal, d.cgst, d.sgst, d.igst, d.grandtotal
            ) combined
            ORDER BY invoice_date ASC, invoice_no ASC
        `;

        const values = [...filterVals(), ...filterVals(), ...filterVals()];
        const [rows] = await db.promise().query(query, values);

        const salesCount   = rows.filter(r => r.invoice_type === 'Sales Invoice').length;
        const serviceCount = rows.filter(r => r.invoice_type === 'Service Invoice').length;
        const directCount  = rows.filter(r => r.invoice_type === 'Direct Invoice').length;
        console.log(`[Sales Report] Sales Invoice: ${salesCount} | Service Invoice: ${serviceCount} | Direct Invoice: ${directCount} | Total: ${rows.length}`);

        res.json(rows);
    } catch (error) {
        console.error("Report Error:", error);
        res.status(500).json({ message: "Report Failed" });
    }
});

// Sales View Report — product-wise rows from all three invoice types
router.get("/view-report", async (req, res) => {
    try {
        const { fromDate, toDate, customer_name, invoice_no, item_name } = req.query;

        const buildFilter = (dateCol, nameCol, noCol, itemCol) => {
            const conds = [];
            if (fromDate && toDate) conds.push(`${dateCol} BETWEEN ? AND ?`);
            if (customer_name) conds.push(`${nameCol} = ?`);
            if (invoice_no) conds.push(`${noCol} = ?`);
            if (item_name) conds.push(`${itemCol} LIKE ?`);
            return conds.length ? " AND " + conds.join(" AND ") : "";
        };

        const filterVals = () => {
            const v = [];
            if (fromDate && toDate) v.push(fromDate, toDate);
            if (customer_name) v.push(customer_name);
            if (invoice_no) v.push(invoice_no);
            if (item_name) v.push(`%${item_name}%`);
            return v;
        };

        const siFilter = buildFilter("s.invoice_date", "s.customer_name", "s.invoice_no", "sii.item_name");
        const svFilter = buildFilter("sv.invoice_date", "sv.customer_name", "sv.invoice_no", "svi.item_name");
        const diFilter = buildFilter("d.invoice_date", "d.customer_name", "d.invoice_no", "ii.item_name");

        const query = `
            SELECT invoice_no, invoice_date, customer_name, item_name, serial_number, hsn_number, quantity, price, amount
            FROM (
                SELECT
                    s.invoice_no, s.invoice_date, s.customer_name,
                    sii.item_name, sii.serial_no AS serial_number,
                    sii.hsn_number, sii.quantity, sii.price,
                    (sii.quantity * sii.price) AS amount
                FROM salesinvoice s
                JOIN salesinvoice_items sii ON s.id = sii.invoice_id
                WHERE 1=1 ${siFilter}

                UNION ALL

                SELECT
                    sv.invoice_no, sv.invoice_date, sv.customer_name,
                    svi.item_name, svi.serial_no AS serial_number,
                    svi.hsn_number, svi.quantity, svi.price,
                    (svi.quantity * svi.price) AS amount
                FROM service_invoices sv
                JOIN service_invoice_items svi ON sv.id = svi.invoice_id
                WHERE 1=1 ${svFilter}

                UNION ALL

                SELECT
                    d.invoice_no, d.invoice_date, d.customer_name,
                    ii.item_name, NULL AS serial_number,
                    ii.hsn_number, ii.quantity, ii.price,
                    (ii.quantity * ii.price) AS amount
                FROM directinvoice d
                JOIN invoice_items ii ON d.id = ii.invoice_id
                WHERE 1=1 ${diFilter}
            ) combined
            ORDER BY invoice_date ASC, invoice_no ASC
        `;

        const values = [...filterVals(), ...filterVals(), ...filterVals()];
        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    } catch (error) {
        console.error("Sales View Report Error:", error);
        res.status(500).json({ message: "Sales View Report Failed" });
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
