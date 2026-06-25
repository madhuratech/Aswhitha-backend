const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { generateNextPI2InvoiceNo } = require("../helpers/pi2InvoiceNumber");



// -- GET next PI2 invoice number --
router.get("/next-In-billno", async (req, res) => {
    try {
        const invoice_no = await generateNextPI2InvoiceNo();
        res.json({ invoice_no });
    } catch (error) {
        console.error("Error generating PI2 invoice number:", error);
        res.status(500).json({ message: error.message });
    }
});

// -- GET all clients --
router.get("/clients", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            "SELECT id, customer_name, state, gst_number FROM newclient ORDER BY customer_name ASC"
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching clients:", error);
        res.status(500).json({ message: error.message });
    }
});

// -- GET clients search --
router.get("/clients/search", async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            "SELECT id, customer_name, state, gst_number FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
            ["%" + (q || "") + "%"]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error searching clients:", error);
        res.status(500).json({ message: "Client search failed" });
    }
});

// -- GET items by type (service/spare/purchase_item) --
router.get("/items/:type", async (req, res) => {
    const type = req.params.type.toLowerCase();
    let query = "";
    if (type === "service") {
        query = "SELECT service_name AS item_name, hsn_number FROM servicesdata";
    } else if (type === "spare") {
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata";
    } else if (type === "purchase_item") {
        query = "SELECT item_name, hsn_number FROM purchaseitems";
    } else {
        return res.status(400).json({ error: "Invalid type parameter" });
    }
    try {
        const [rows] = await db.promise().query(query);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching items:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// -- GET items search --
router.get("/items/search", async (req, res) => {
    const { q, type } = req.query;
    let query = "";
    const values = ["%" + (q || "") + "%"];
    if (type === "service") {
        query = "SELECT service_name AS item_name, hsn_number FROM servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    } else if (type === "spare") {
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    } else if (type === "purchase_item") {
        query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    } else {
        return res.status(400).json({ message: "Invalid item type" });
    }
    try {
        const [rows] = await db.promise().query(query, [...values, ...values]);
        res.json(rows);
    } catch (error) {
        console.error("Error searching items:", error);
        res.status(500).json({ message: "Item search failed" });
    }
});

// -- POST create new Performance Invoice 2 --
router.post("/new", async (req, res) => {
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
            dispatch_through,
            discount,
            transport,
            subtotal,
            cgst,
            sgst,
            igst,
            round_off,
            grandtotal,
            ordertype,
            gst_rate,
        } = req.body;

        const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
        if (!dispatch_through?.trim() || !ALLOWED_DESPATCH.includes(dispatch_through.trim())) {
            return res.status(400).json({ message: "Despatch Through is required." });
        }

        try {
            const [result] = await db.promise().query(
                "INSERT INTO performance_invoice2_header (customer_name, invoice_no, invoice_date, dc_no, dc_date, order_no, order_date, dispatch_through, discount, transport, subtotal, ordertype, cgst, sgst, igst, round_off, grandtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    customer_name,
                    invoice_no,
                    invoice_date,
                    dc_no || null,
                    dc_date || null,
                    order_no || null,
                    order_date || null,
                    dispatch_through || null,
                    discount || 0,
                    transport || 0,
                    subtotal || 0,
                    ordertype || null,
                    cgst || 0,
                    sgst || 0,
                    igst || 0,
                    round_off || 0,
                    grandtotal || 0,
                ]
            );

            const invoiceId = result.insertId;

            for (const item of items) {
                const amount = Number(item.price) * Number(item.quantity);
                await db.promise().query(
                    "INSERT INTO performance_invoice2_items (invoice_id, item_name, serial_no, quantity, price, uom, hsn_number, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        invoiceId,
                        item.item_name,
                        item.serial_no || null,
                        item.quantity,
                        item.price,
                        item.uom || null,
                        item.hsn_number || null,
                        amount,
                    ]
                );
            }

            return res.json({ message: "Performance Invoice 2 Created", invoiceId, invoice_no });
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY" && attempts < MAX_ATTEMPTS) {
                req.body.invoice_no = await generateNextPI2InvoiceNo();
                continue;
            }
            console.error("Error creating Performance Invoice 2:", error);
            return res.status(500).json({ message: "Internal Server Error" });
        }
    }
    res.status(500).json({ message: "Failed to create invoice after multiple attempts" });
});

// -- PUT update Performance Invoice 2 --
router.put("/update/:invoiceNo", async (req, res) => {
    try {
        const { invoiceNo } = req.params;
        const {
            customer_name,
            invoice_no,
            invoice_date,
            dc_no,
            dc_date,
            order_no,
            order_date,
            dispatch_through,
            discount,
            transport,
            subtotal,
            cgst,
            sgst,
            igst,
            round_off,
            grandtotal,
            ordertype,
            items,
            gst_rate,
        } = req.body;

        const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
        if (!dispatch_through?.trim() || !ALLOWED_DESPATCH.includes(dispatch_through.trim())) {
            return res.status(400).json({ message: "Despatch Through is required." });
        }

        const [invoiceRows] = await db.promise().query(
            "SELECT id FROM performance_invoice2_header WHERE invoice_no = ?",
            [invoiceNo]
        );
        if (!invoiceRows.length) {
            return res.status(404).json({ message: "Invoice not found" });
        }
        const invoiceId = invoiceRows[0].id;

        await db.promise().query(
            "UPDATE performance_invoice2_header SET customer_name=?, invoice_no=?, invoice_date=?, dc_no=?, dc_date=?, order_no=?, order_date=?, dispatch_through=?, discount=?, transport=?, subtotal=?, ordertype=?, cgst=?, sgst=?, igst=?, round_off=?, grandtotal=? WHERE id=?",
            [
                customer_name, invoice_no, invoice_date,
                dc_no || null, dc_date || null,
                order_no || null, order_date || null,
                dispatch_through || null,
                discount || 0, transport || 0, subtotal || 0, ordertype || null,
                cgst || 0, sgst || 0, igst || 0, round_off || 0, grandtotal || 0,
                invoiceId,
            ]
        );

        await db.promise().query(
            "DELETE FROM performance_invoice2_items WHERE invoice_id=?",
            [invoiceId]
        );

        for (const item of (items || [])) {
            const amount = Number(item.price) * Number(item.quantity);
            await db.promise().query(
                "INSERT INTO performance_invoice2_items (invoice_id, item_name, serial_no, quantity, price, uom, hsn_number, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [invoiceId, item.item_name, item.serial_no || null, item.quantity, item.price,
                 item.uom || null, item.hsn_number || null, amount]
            );
        }

        res.json({ message: "Performance Invoice 2 Updated" });
    } catch (error) {
        console.error("Error updating Performance Invoice 2:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// -- DELETE Performance Invoice 2 --
router.delete("/delete/:invoiceNo", async (req, res) => {
    try {
        const { invoiceNo } = req.params;

        const [invoiceRows] = await db.promise().query(
            "SELECT id FROM performance_invoice2_header WHERE invoice_no = ?",
            [invoiceNo]
        );
        if (!invoiceRows.length) {
            return res.status(404).json({ message: "Invoice not found" });
        }
        const invoiceId = invoiceRows[0].id;

        await db.promise().query(
            "DELETE FROM performance_invoice2_items WHERE invoice_id=?",
            [invoiceId]
        );
        await db.promise().query(
            "DELETE FROM performance_invoice2_header WHERE id=?",
            [invoiceId]
        );

        res.json({ message: "Performance Invoice 2 Deleted" });
    } catch (error) {
        console.error("Error deleting Performance Invoice 2:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// -- GET invoice for edit --
router.get("/edit/:invoiceNo", async (req, res) => {
    try {
        const invoiceNo = decodeURIComponent(req.params.invoiceNo);

        const [invoiceRows] = await db.promise().query(
            "SELECT * FROM performance_invoice2_header WHERE invoice_no = ?",
            [invoiceNo]
        );
        if (!invoiceRows.length) {
            return res.status(404).json({ message: "Invoice Not Found" });
        }
        const invoice = invoiceRows[0];

        const [itemRows] = await db.promise().query(
            "SELECT * FROM performance_invoice2_items WHERE invoice_id = ?",
            [invoice.id]
        );

        const [clientRows] = await db.promise().query(
            "SELECT * FROM newclient WHERE customer_name = ?",
            [invoice.customer_name]
        );

        res.json({ header: invoice, items: itemRows, client: clientRows[0] || {} });
    } catch (error) {
        console.error("Error fetching Performance Invoice 2:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// -- GET full invoice for PDF view --
router.get("/full/:invoiceNo", async (req, res) => {
    try {
        const invoiceNo = decodeURIComponent(req.params.invoiceNo);

        const [invoiceRows] = await db.promise().query(
            "SELECT * FROM performance_invoice2_header WHERE invoice_no = ?",
            [invoiceNo]
        );
        if (!invoiceRows.length) {
            return res.status(404).json({ message: "Invoice Not Found" });
        }
        const invoice = invoiceRows[0];

        const [itemRows] = await db.promise().query(
            "SELECT * FROM performance_invoice2_items WHERE invoice_id = ?",
            [invoice.id]
        );

        const [clientRows] = await db.promise().query(
            "SELECT * FROM newclient WHERE customer_name = ?",
            [invoice.customer_name]
        );

        res.json({ header: invoice, items: itemRows, client: clientRows[0] || {} });
    } catch (error) {
        console.error("Error fetching full Performance Invoice 2:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// -- GET invoice number search --
router.get("/INV/search", async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            "SELECT invoice_no FROM performance_invoice2_header WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 20",
            ["%" + (q || "") + "%"]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error searching PI2 invoices:", error);
        res.status(500).json({ message: "Invoice search failed" });
    }
});

// -- GET all Performance Invoice 2s (for report) --
router.get("/report/all", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            "SELECT h.*, COUNT(i.id) AS item_count FROM performance_invoice2_header h LEFT JOIN performance_invoice2_items i ON h.id = i.invoice_id GROUP BY h.id ORDER BY h.id DESC"
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching PI2 report:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

module.exports = router;
