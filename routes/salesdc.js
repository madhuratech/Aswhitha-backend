const express = require("express");
const router = express.Router();
const db = require("../config/database");

async function DCGenerate() {
    const [rows] = await db.promise().query(
        "SELECT MAX(id) AS lastId FROM sales_dc_entries"
    );
    const nextId = (rows[0].lastId || 0) + 1;
    return `AT/SDC-${nextId.toString().padStart(3, "0")}`;
}

// Get next Admin DC No
router.get("/next-dc-no", async (req, res) => {
    try {
        const dc_no = await DCGenerate();
        res.json({ dc_no });
    } catch (error) {
        console.error("Error generating DC No:", error);
        res.status(500).json({ message: error.message });
    }
});

// Search customers
router.get("/clients/search", async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            "SELECT id, customer_name FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name LIMIT 20",
            [`%${q || ""}%`]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error searching clients:", error);
        res.status(500).json({ message: "Client search failed" });
    }
});




// Item search (for manual product entry when no client DC)
router.get("/items/search", async (req, res) => {
    const { q, type } = req.query;
    let query = "";
    const values = [`%${q || ""}%`];

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

// Create new Sales DC
router.post("/new", async (req, res) => {
    const {
        customer_name,
        dc_no,
        dc_date,
        order_no,
        order_date,
        payment_terms,
        Client_dc_date,
        despatch_through,
        status,
        ordertype,
        items
    } = req.body;

    if (!customer_name || !dc_no || !payment_terms || !items || !items.length) {
        return res.status(400).json({ message: "Customer, Admin DC No, Client DC No and at least one item are required" });
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.query(
            `INSERT INTO sales_dc_entries
             (customer_name, dc_no, dc_date, order_no, order_date, payment_terms, Client_dc_date, despatch_through, status, ordertype)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                customer_name,
                dc_no,
                dc_date || null,
                order_no || null,
                order_date || null,
                payment_terms || null,
                Client_dc_date || null,
                despatch_through || null,
                status || "To Sell",
                ordertype || null
            ]
        );

        const dcId = result.insertId;
        const itemSql = `INSERT INTO sales_dc_items (dc_id, item_name, quantity, price, sl_no, hsn, uom) VALUES (?, ?, ?, ?, ?, ?, ?)`;

        for (const item of items) {
            await conn.query(itemSql, [
                dcId,
                item.item_name,
                item.quantity,
                item.price || 0,
                item.sl_no || null,
                item.hsn || null,
                item.uom || null
            ]);
        }

        await conn.commit();
        res.json({ message: "Sales DC created successfully", dcId, dc_no });
    } catch (error) {
        await conn.rollback();
        console.error("Error creating Sales DC:", error);
        res.status(500).json({ message: "Internal Server Error" });
    } finally {
        conn.release();
    }
});

// Update Sales DC
router.put("/update/:dc_no", async (req, res) => {
    const dcNo = decodeURIComponent(req.params.dc_no);
    const {
        customer_name,
        dc_no,
        dc_date,
        order_no,
        order_date,
        payment_terms,
        Client_dc_date,
        despatch_through,
        status,
        ordertype,
        items
    } = req.body;

    if (!customer_name || !dc_no || !payment_terms || !items || !items.length) {
        return res.status(400).json({ message: "Customer, Admin DC No, Client DC No and at least one item are required" });
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        const [dcRows] = await conn.query(
            "SELECT id FROM sales_dc_entries WHERE dc_no = ?",
            [dcNo]
        );
        if (!dcRows.length) {
            await conn.rollback();
            return res.status(404).json({ message: "DC Not Found" });
        }

        const dcId = dcRows[0].id;
        await conn.query(
            `UPDATE sales_dc_entries
             SET customer_name=?, dc_no=?, dc_date=?, order_no=?, order_date=?,
                 payment_terms=?, Client_dc_date=?, despatch_through=?, status=?, ordertype=?
             WHERE id=?`,
            [
                customer_name,
                dc_no,
                dc_date || null,
                order_no || null,
                order_date || null,
                payment_terms || null,
                Client_dc_date || null,
                despatch_through || null,
                status,
                ordertype,
                dcId
            ]
        );

        await conn.query("DELETE FROM sales_dc_items WHERE dc_id=?", [dcId]);

        for (const item of items) {
            await conn.query(
                "INSERT INTO sales_dc_items (dc_id, item_name, quantity, price, sl_no, hsn, uom) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [dcId, item.item_name, item.quantity, item.price || 0, item.sl_no || null, item.hsn || null, item.uom || null]
            );
        }

        await conn.commit();
        res.json({ message: "Sales DC updated successfully" });
    } catch (error) {
        await conn.rollback();
        console.error("Error updating Sales DC:", error);
        res.status(500).json({ message: "Internal Server Error" });
    } finally {
        conn.release();
    }
});

// Delete Sales DC
router.delete("/delete/:dc_no", async (req, res) => {
    try {
        const dcNo = decodeURIComponent(req.params.dc_no);
        const [dcRows] = await db.promise().query(
            "SELECT id FROM sales_dc_entries WHERE dc_no = ?",
            [dcNo]
        );
        if (!dcRows.length) return res.status(404).json({ message: "DC Not Found" });
        const dcId = dcRows[0].id;

        await db.promise().query("DELETE FROM sales_dc_items WHERE dc_id=?", [dcId]);
        await db.promise().query("DELETE FROM sales_dc_entries WHERE id=?", [dcId]);

        res.json({ message: "Sales DC deleted successfully" });
    } catch (error) {
        console.error("Error deleting Sales DC:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Get DC for editing
router.get("/edit/:dc_no", async (req, res) => {
    try {
        const dcNo = decodeURIComponent(req.params.dc_no);
        const [dcRows] = await db.promise().query(
            "SELECT * FROM sales_dc_entries WHERE dc_no = ?",
            [dcNo]
        );
        if (!dcRows.length) return res.status(404).json({ message: "Sales DC Not Found" });
        const dcEntry = dcRows[0];
        const [itemRows] = await db.promise().query(
            "SELECT * FROM sales_dc_items WHERE dc_id = ?",
            [dcEntry.id]
        );
        res.json({ header: dcEntry, items: itemRows });
    } catch (error) {
        console.error("Error fetching Sales DC:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Full DC with client info
router.get("/full/:dc_no", async (req, res) => {
    try {
        const dcNo = decodeURIComponent(req.params.dc_no);
        const [dcRows] = await db.promise().query(
            "SELECT * FROM sales_dc_entries WHERE dc_no = ?",
            [dcNo]
        );
        if (!dcRows.length) return res.status(404).json({ message: "Sales DC Not Found" });
        const dcEntry = dcRows[0];
        const [itemRows] = await db.promise().query(
            "SELECT * FROM sales_dc_items WHERE dc_id = ?",
            [dcEntry.id]
        );
        const [clientRows] = await db.promise().query(
            "SELECT * FROM newclient WHERE customer_name = ?",
            [dcEntry.customer_name]
        );
        res.json({ ...dcEntry, items: itemRows, client: clientRows[0] || {} });
    } catch (error) {
        console.error("Error fetching full Sales DC:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Search DC numbers
router.get("/DC/search", async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            "SELECT dc_no FROM sales_dc_entries WHERE dc_no LIKE ? ORDER BY id DESC LIMIT 20",
            [`%${q || ""}%`]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error searching Sales DC:", error);
        res.status(500).json({ message: "Search failed" });
    }
});

// Report with filters
router.get("/report/filters", async (req, res) => {
    try {
        const { fromDate, toDate, dcNo, clientName } = req.query;
        let query = `
            SELECT s.dc_no, s.dc_date, s.customer_name, s.status, s.ordertype,
                   si.item_name, si.quantity, si.price
            FROM sales_dc_entries s
            LEFT JOIN sales_dc_items si ON s.id = si.dc_id
            WHERE 1=1
        `;
        const values = [];
        if (fromDate && toDate) { query += " AND s.dc_date BETWEEN ? AND ?"; values.push(fromDate, toDate); }
        if (dcNo) { query += " AND s.dc_no = ?"; values.push(dcNo); }
        if (clientName) { query += " AND s.customer_name = ?"; values.push(clientName); }
        query += " ORDER BY s.id DESC";
        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    } catch (error) {
        console.error("Report error:", error);
        res.status(500).json({ message: "Report failed" });
    }
});

// Excel export
router.get("/report/excel", async (req, res) => {
    try {
        const { fromDate, toDate, dcNo, clientName } = req.query;
        let query = `
            SELECT s.dc_no, s.dc_date, s.customer_name, s.status, s.ordertype,
                   si.item_name, si.quantity, si.price
            FROM sales_dc_entries s
            LEFT JOIN sales_dc_items si ON s.id = si.dc_id
            WHERE 1=1
        `;
        const values = [];
        if (fromDate && toDate) { query += " AND s.dc_date BETWEEN ? AND ?"; values.push(fromDate, toDate); }
        if (dcNo) { query += " AND s.dc_no = ?"; values.push(dcNo); }
        if (clientName) { query += " AND s.customer_name = ?"; values.push(clientName); }

        const [rows] = await db.promise().query(query, values);
        const ExcelJS = require("exceljs");
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Sales DC Report");

        worksheet.columns = [
            { header: "SNO", key: "sno", width: 8 },
            { header: "DC No", key: "dc_no", width: 20 },
            { header: "Date", key: "dc_date", width: 15 },
            { header: "Client Name", key: "customer_name", width: 25 },
            { header: "Status", key: "status", width: 15 },
            { header: "Order Type", key: "ordertype", width: 15 },
            { header: "Item Name", key: "item_name", width: 25 },
            { header: "Quantity", key: "quantity", width: 12 },
            { header: "Price", key: "price", width: 12 }
        ];

        rows.forEach((row, index) => worksheet.addRow({ sno: index + 1, ...row }));
        worksheet.getRow(1).font = { bold: true };

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=Sales_DC_Report.xlsx");
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Excel export error:", error);
        res.status(500).json({ message: "Excel export failed" });
    }
});

module.exports = router;
