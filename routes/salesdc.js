const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");
const { getCurrentDcNumber, getAndIncrementDcNumber } = require("../helpers/dcNumber");

// Get next DC No from shared counter
router.get("/next-dc-no", async (req, res) => {
    try {
        const dc_no = await getCurrentDcNumber();
        res.json({ dc_no });
    } catch (error) {
        console.error("Error reading DC counter:", error);
        res.status(500).json({ message: error.message });
    }
});

// Search customers
router.get("/clients/search", async (req, res) => {
    const { q } = req.query;
    try {
        const [rows] = await db.promise().query(
            "SELECT id, customer_name FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
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
        query = "SELECT service_name AS item_name, hsn_number FROM servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20 ";
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
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.customer_name || !s.order_no || !items.length) {
        return res.status(400).json({ message: "Customer, Client DC No and at least one item are required" });
    }
    const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
    if (!s.despatch_through?.trim() || !ALLOWED_DESPATCH.includes(s.despatch_through.trim())) {
        return res.status(400).json({ message: "Despatch Through cannot be null." });
    }

    const conn = await db.promise().getConnection();
    try {
        await conn.beginTransaction();

        // Atomically get & increment the shared counter inside the transaction
        s.dc_no = await getAndIncrementDcNumber(conn);

        const [result] = await conn.query(
            `INSERT INTO sales_dc_entries
             (customer_name, dc_no, dc_date, order_no, order_date, despatch_through, ordertype)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                s.customer_name,
                s.dc_no,
                emptyToNull(s.dc_date),
                emptyToNull(s.order_no),
                emptyToNull(s.order_date),
                emptyToNull(s.despatch_through),
                emptyToNull(s.ordertype)
            ]
        );

        const dcId = result.insertId;
        const itemSql = `INSERT INTO sales_dc_items (dc_id, item_name, quantity, sl_no, hsn, uom, remarks, order_no, order_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        for (const item of items) {
            await conn.query(itemSql, [
                dcId,
                emptyToNull(item.item_name),
                toNum(item.quantity),
                emptyToNull(item.sl_no),
                emptyToNull(item.hsn),
                emptyToNull(item.uom),
                emptyToNull(item.remarks),
                emptyToNull(item.order_no) || emptyToNull(s.order_no),
                emptyToNull(item.order_date) || emptyToNull(s.order_date)
            ]);
        }

        await conn.commit();
        res.json({ message: "Sales DC created successfully", dcId, dc_no: s.dc_no });
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
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!s.customer_name || !s.dc_no || !s.payment_terms || !items.length) {
        return res.status(400).json({ message: "Customer, Admin DC No, Client DC No and at least one item are required" });
    }
    const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
    if (!s.despatch_through?.trim() || !ALLOWED_DESPATCH.includes(s.despatch_through.trim())) {
        return res.status(400).json({ message: "Despatch Through cannot be null." });
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
              despatch_through=?, ordertype=?
             WHERE id=?`,
            [
                s.customer_name,
                s.dc_no,
                emptyToNull(s.dc_date),
                emptyToNull(s.order_no),
                emptyToNull(s.order_date),
                emptyToNull(s.despatch_through),
                emptyToNull(s.ordertype),
                dcId
            ]
        );

        await conn.query("DELETE FROM sales_dc_items WHERE dc_id=?", [dcId]);

        for (const item of items) {
            await conn.query(
                "INSERT INTO sales_dc_items (dc_id, item_name, quantity, sl_no, hsn, uom, remarks, order_no, order_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [dcId, emptyToNull(item.item_name), toNum(item.quantity), emptyToNull(item.sl_no), emptyToNull(item.hsn), emptyToNull(item.uom), emptyToNull(item.remarks),
                 emptyToNull(item.order_no) || emptyToNull(s.order_no),
                 emptyToNull(item.order_date) || emptyToNull(s.order_date)]
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

        if (!dcRows.length) {
            return res.status(404).json({ message: "Sales DC Not Found" });
        }

        const dcEntry = dcRows[0];

        const [itemRows] = await db.promise().query(
            "SELECT * FROM sales_dc_items WHERE dc_id = ?",
            [dcEntry.id]
        );

        const [clientRows] = await db.promise().query(
            "SELECT * FROM newclient WHERE customer_name = ?",
            [dcEntry.customer_name]
        );

      const allDcNos = itemRows
  .map(item => item.order_no)
  .filter(Boolean);

const allDcDates = itemRows
  .map(item => item.order_date)
  .filter(Boolean);

      res.json({
  ...dcEntry,
  items: itemRows,
  client: clientRows[0] || {},

  aggregated_order_no:
    allDcNos.length
      ? allDcNos.join(", ")
      : (dcEntry.order_no || ""),

  aggregated_order_date:
    allDcDates.length
      ? allDcDates.join(", ")
      : (dcEntry.order_date || "")
});

    } catch (error) {
        console.error("Error fetching full Sales DC:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

// Fetch order date for a given order number (from inward_entry or existing sales_dc_entries)
router.get("/order-date", async (req, res) => {
    const { order_no } = req.query;
    if (!order_no) return res.status(400).json({ message: "order_no is required" });
    try {
        // Try inward_entry first
        const [inwardRows] = await db.promise().query(
            "SELECT dc_date FROM inward_entry WHERE dc_number = ? ORDER BY id DESC LIMIT 1",
            [order_no]
        );
        if (inwardRows.length) {
            return res.json({ order_date: inwardRows[0].dc_date || "" });
        }
        // Fallback to sales_dc_entries
        const [dcRows] = await db.promise().query(
            "SELECT order_date FROM sales_dc_entries WHERE order_no LIKE ? ORDER BY id DESC LIMIT 1",
            [`%${order_no}%`]
        );
        if (dcRows.length) {
            return res.json({ order_date: dcRows[0].order_date || "" });
        }
        res.json({ order_date: "" });
    } catch (error) {
        console.error("Error fetching order date:", error);
        res.status(500).json({ message: "Server Error" });
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
            SELECT s.dc_no, s.dc_date, s.customer_name, s.ordertype,
                   si.item_name, si.quantity, si.remarks
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
            SELECT s.dc_no, s.dc_date, s.customer_name, s.ordertype,
                   si.item_name, si.quantity, si.remarks
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
            { header: "Order Type", key: "ordertype", width: 15 },
            { header: "Item Name", key: "item_name", width: 25 },
            { header: "Quantity", key: "quantity", width: 12 },
            { header: "Remarks", key: "remarks", width: 25 }
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
