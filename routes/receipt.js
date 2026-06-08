const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Auto-generate Receipt Number
async function generateReceiptNo() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM receipts"
  );
  const nextId = (rows[0].lastId || 0) + 1;
  return `AT/REC-${nextId.toString().padStart(3, "0")}`;
}

router.get("/next-receipt-no", async (req, res) => {
  try {
    const receipt_no = await generateReceiptNo();
    res.json({ receipt_no });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to generate receipt number" });
  }
});

// Get Clients — only customers who have at least one invoice
router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT customer_name
       FROM salesinvoice
       ORDER BY customer_name ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search Clients — only customers who have at least one invoice
router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT customer_name
       FROM salesinvoice
       WHERE customer_name LIKE ?
       ORDER BY customer_name ASC
       LIMIT 20`,
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Client search failed" });
  }
});

// Get Customer Pending Bills (from sales invoices)
router.get("/customer-bills/:customerName", async (req, res) => {
  try {
    const customerName = decodeURIComponent(req.params.customerName);
    const [rows] = await db.promise().query(
      `SELECT invoice_no AS bill_no, invoice_date AS bill_date, grandtotal  AS bill_amount
       FROM salesinvoice
       WHERE customer_name = ?
       ORDER BY id ASC`,
      [customerName]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch bills" });
  }
});

// Create Receipt
router.post("/new", async (req, res) => {
  try {
    const {
      receipt_no, receipt_date, customer_name,
      payment_mode, bank_name, cheque_no, cheque_date,
      total, force_amount, other_deductions, grand_total, remarks,
      items
    } = req.body;

    const [result] = await db.promise().query(
      `INSERT INTO receipts
       (receipt_no, receipt_date, customer_name, payment_mode, bank_name, cheque_no, cheque_date,
        total, force_amount, other_deductions, grand_total, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [receipt_no, receipt_date, customer_name, payment_mode, bank_name,
       cheque_no || null, cheque_date || null,
       total || 0, force_amount || 0, other_deductions || 0, grand_total || 0, remarks || ""]
    );

    const receiptId = result.insertId;

    for (const item of items) {
      await db.promise().query(
        `INSERT INTO receipt_items (receipt_id, bill_no, bill_date, bill_amount, paid_amount, balance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [receiptId, item.bill_no, item.bill_date, item.bill_amount, item.paid_amount, item.balance]
      );
    }

    res.status(201).json({ message: "Receipt saved successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to save receipt" });
  }
});

// Update Receipt
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      receipt_date, customer_name, payment_mode, bank_name,
      cheque_no, cheque_date, total, force_amount, other_deductions,
      grand_total, remarks, items
    } = req.body;

    await db.promise().query(
      `UPDATE receipts SET
       receipt_date=?, customer_name=?, payment_mode=?, bank_name=?,
       cheque_no=?, cheque_date=?, total=?, force_amount=?, other_deductions=?,
       grand_total=?, remarks=?
       WHERE id=?`,
      [receipt_date, customer_name, payment_mode, bank_name,
       cheque_no || null, cheque_date || null,
       total || 0, force_amount || 0, other_deductions || 0,
       grand_total || 0, remarks || "", id]
    );

    await db.promise().query("DELETE FROM receipt_items WHERE receipt_id=?", [id]);

    for (const item of items) {
      await db.promise().query(
        `INSERT INTO receipt_items (receipt_id, bill_no, bill_date, bill_amount, paid_amount, balance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, item.bill_no, item.bill_date, item.bill_amount, item.paid_amount, item.balance]
      );
    }

    res.json({ message: "Receipt updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update receipt" });
  }
});

// Delete Receipt
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.promise().query("DELETE FROM receipt_items WHERE receipt_id=?", [id]);
    await db.promise().query("DELETE FROM receipts WHERE id=?", [id]);
    res.json({ message: "Receipt deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete receipt" });
  }
});

// Generate Advance Receipt Number
async function generateAdvanceNo() {
  const [rows] = await db.promise().query("SELECT MAX(id) AS lastId FROM receipts");
  const nextId = (rows[0].lastId || 0) + 1;
  return `AT/ADV-${nextId.toString().padStart(3, "0")}`;
}

router.get("/next-advance-no", async (req, res) => {
  try {
    const receipt_no = await generateAdvanceNo();
    res.json({ receipt_no });
  } catch (error) {
    res.status(500).json({ message: "Failed to generate advance receipt number" });
  }
});

// Receipt Report — customers dropdown (only customers who have bill-wise receipts)
router.get("/report/customers", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT r.customer_name
       FROM receipts r
       INNER JOIN receipt_items ri ON r.id = ri.receipt_id
       ORDER BY r.customer_name ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Receipt Report — filtered data (bill-wise receipts only)
router.get("/report/filters", async (req, res) => {
  try {
    const { fromDate, toDate, customerName, receiptNo } = req.query;

    let query = `
      SELECT
        r.id,
        r.receipt_no,
        r.receipt_date,
        r.customer_name,
        r.payment_mode,
        r.bank_name,
        r.total,
        r.grand_total,
        r.remarks,
        GROUP_CONCAT(ri.bill_no ORDER BY ri.id SEPARATOR ', ') AS bill_nos,
        SUM(ri.paid_amount) AS total_paid
      FROM receipts r
      INNER JOIN receipt_items ri ON r.id = ri.receipt_id
      WHERE 1=1
    `;
    const values = [];

    if (fromDate && toDate) {
      query += " AND r.receipt_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }
    if (customerName) {
      query += " AND r.customer_name = ?";
      values.push(customerName);
    }
    if (receiptNo) {
      query += " AND r.receipt_no = ?";
      values.push(receiptNo);
    }

    query += ` GROUP BY r.id, r.receipt_no, r.receipt_date, r.customer_name,
               r.payment_mode, r.bank_name, r.total, r.grand_total, r.remarks
               ORDER BY r.receipt_date DESC, r.id DESC`;

    const [rows] = await db.promise().query(query, values);
    res.json(rows);
  } catch (error) {
    console.error("Receipt Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});

// Advance Report — customers dropdown (customers with advance receipts = no items)
router.get("/advance/customers", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT customer_name
       FROM receipts r
       WHERE NOT EXISTS (SELECT 1 FROM receipt_items ri WHERE ri.receipt_id = r.id)
       ORDER BY customer_name ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Advance Report — filtered data (advance receipts = no bill items)
router.get("/advance/filters", async (req, res) => {
  try {
    const { fromDate, toDate, customerName, receiptNo } = req.query;

    let query = `
      SELECT
        r.id,
        r.receipt_no,
        r.receipt_date,
        r.customer_name,
        r.payment_mode,
        r.bank_name,
        r.total AS received_amount,
        r.other_deductions AS tds_amount,
        r.force_amount AS other_amount,
        r.grand_total,
        r.remarks
      FROM receipts r
      WHERE NOT EXISTS (SELECT 1 FROM receipt_items ri WHERE ri.receipt_id = r.id)
    `;
    const values = [];

    if (fromDate && toDate) {
      query += " AND r.receipt_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }
    if (customerName) {
      query += " AND r.customer_name = ?";
      values.push(customerName);
    }
    if (receiptNo) {
      query += " AND r.receipt_no = ?";
      values.push(receiptNo);
    }

    query += " ORDER BY r.receipt_date DESC, r.id DESC";

    const [rows] = await db.promise().query(query, values);
    res.json(rows);
  } catch (error) {
    console.error("Advance Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});

// Search Receipts (for load/edit)
router.get("/search", async (req, res) => {
  const { q } = req.query;
  try {
    const [rows] = await db.promise().query(
      "SELECT id, receipt_no FROM receipts WHERE receipt_no LIKE ? ORDER BY id DESC LIMIT 20",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Search failed" });
  }
});

// Customer name list for ledger dropdown  — MUST be before /:receipt_no
router.get("/ledger-customers", async (req, res) => {
  const { q } = req.query;
  try {
    const [rows] = await db.promise().query(
      "SELECT DISTINCT customer_name FROM salesinvoice WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 200",
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch customers" });
  }
});

// Customer Ledger - bill to bill view  — MUST be before /:receipt_no
router.get("/customer-ledger", async (req, res) => {
  try {
    const { customer_name, fromDate, toDate, type } = req.query;

    // Build invoice query — customer_name is optional (empty = all customers)
    const iConditions = [];
    const invoiceParams = [];
    if (customer_name) {
      iConditions.push("inv.customer_name = ?");
      invoiceParams.push(customer_name);
    }
    if (fromDate && toDate) {
      iConditions.push("inv.invoice_date BETWEEN ? AND ?");
      invoiceParams.push(fromDate, toDate);
    }
    const invoiceWhere = iConditions.length ? "WHERE " + iConditions.join(" AND ") : "";

    // Join invoices with their payments so credit shows in the same row (no separate receipt rows)
    const [invoices] = await db.promise().query(
      `SELECT inv.invoice_no AS bill_no, inv.invoice_date AS date,
          inv.grandtotal AS debit,
          IFNULL(SUM(ri.paid_amount), 0) AS credit,
          IFNULL(GROUP_CONCAT(DISTINCT r.receipt_no ORDER BY r.receipt_date SEPARATOR ', '), '') AS receipt_no,
          IFNULL(GROUP_CONCAT(DISTINCT r.receipt_date ORDER BY r.receipt_date SEPARATOR ', '), '') AS paid_date,
          IFNULL(GROUP_CONCAT(DISTINCT NULLIF(TRIM(CONCAT_WS(' ', r.bank_name, r.remarks)),'') ORDER BY r.receipt_date SEPARATOR ', '), '') AS payment_mode,
          IFNULL(inv.payment_terms,'') AS notes, 'invoice' AS entry_type
        FROM salesinvoice inv
        LEFT JOIN receipt_items ri ON ri.bill_no = inv.invoice_no
        LEFT JOIN receipts r ON r.id = ri.receipt_id
        ${invoiceWhere}
        GROUP BY inv.invoice_no, inv.invoice_date, inv.grandtotal, inv.payment_terms`,
      invoiceParams
    );

    // Build bill wise payments query
    const pConditions = [];
    const paymentParams = [];
    if (customer_name) {
      pConditions.push("nc.customer_name = ?");
      paymentParams.push(customer_name);
    }
    if (fromDate && toDate) {
      pConditions.push("bp.entry_date BETWEEN ? AND ?");
      paymentParams.push(fromDate, toDate);
    }
    const paymentWhere = pConditions.length ? "WHERE " + pConditions.join(" AND ") : "";

    const [payments] = await db.promise().query(
      `SELECT bpi.bill_no AS bill_no, bp.entry_date AS date,
          0 AS debit,
          bpi.paid_amount AS credit,
          bp.reference_no AS receipt_no,
          bp.entry_date AS paid_date,
          CONCAT('Bill Wise Payment', IF(bp.remarks IS NOT NULL AND TRIM(bp.remarks) != '', CONCAT(' (', bp.remarks, ')'), '')) AS payment_mode,
          '' AS notes, 'bill_wise_payment' AS entry_type
        FROM billwise_payment_items bpi
        INNER JOIN billwise_payments bp ON bpi.payment_id = bp.id
        INNER JOIN newclient nc ON bp.supplier_id = nc.id
        ${paymentWhere}`,
      paymentParams
    );

    // Sort by date ascending
    const combined = [...invoices, ...payments].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    let balance = 0;
    const entries = combined.map((row, idx) => {
      balance += (Number(row.debit) || 0) - (Number(row.credit) || 0);
      return { ...row, sno: idx + 1, balance: parseFloat(balance.toFixed(2)) };
    });

    const totalDebit = entries.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = entries.reduce((s, r) => s + Number(r.credit), 0);

    // Outstanding: invoices that still have unpaid balance
    if (type === "outstanding") {
      const paidWhere = customer_name ? "WHERE r.customer_name = ?" : "";
      const paidParams = customer_name ? [customer_name] : [];
      const [paidRows] = await db.promise().query(
        `SELECT bill_no, SUM(paid_amount) AS paid
         FROM receipt_items ri
         JOIN receipts r ON r.id = ri.receipt_id
         ${paidWhere}
         GROUP BY bill_no`,
        paidParams
      );
      const paidMap = {};
      paidRows.forEach((r) => { paidMap[r.bill_no] = Number(r.paid); });

      const invWhere = customer_name ? "WHERE customer_name = ?" : "";
      const invParams = customer_name ? [customer_name] : [];
      const [allInvoices] = await db.promise().query(
        `SELECT invoice_no AS bill_no, invoice_date AS date, grandtotal AS bill_amount
         FROM salesinvoice ${invWhere}`,
        invParams
      );

      const outstanding = allInvoices
        .map((inv) => {
          const paid = paidMap[inv.bill_no] || 0;
          const bal = Number(inv.bill_amount) - paid;
          return { bill_no: inv.bill_no, date: inv.date, bill_amount: Number(inv.bill_amount), paid_amount: paid, balance: bal };
        })
        .filter((inv) => inv.balance > 0);

      return res.json({ customer_name: customer_name || "ALL", type: "outstanding", outstanding });
    }

    res.json({
      customer_name: customer_name || "ALL",
      fromDate: fromDate || null,
      toDate: toDate || null,
      type: "ledger",
      entries,
      total_debit: parseFloat(totalDebit.toFixed(2)),
      total_credit: parseFloat(totalCredit.toFixed(2)),
      closing_balance: parseFloat((totalDebit - totalCredit).toFixed(2)),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch customer ledger" });
  }
});

// Receipt Voucher Report — receipts WITH their bill items (for voucher display)
router.get("/report/vouchers", async (req, res) => {
  try {
    const { fromDate, toDate, customerName } = req.query;

    let query = `
      SELECT
        r.id, r.receipt_no, r.receipt_date, r.customer_name,
        r.payment_mode, r.bank_name, r.total, r.grand_total,
        r.other_deductions, r.force_amount, r.remarks,
        nc.address, nc.gst_number, nc.phone,
        ri.id AS item_id, ri.bill_no, ri.bill_date,
        ri.bill_amount, ri.paid_amount, ri.balance
      FROM receipts r
      INNER JOIN receipt_items ri ON r.id = ri.receipt_id
      LEFT JOIN newclient nc ON nc.customer_name = r.customer_name
      WHERE 1=1
    `;
    const values = [];

    if (fromDate && toDate) {
      query += " AND r.receipt_date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }
    if (customerName) {
      query += " AND r.customer_name = ?";
      values.push(customerName);
    }

    query += " ORDER BY r.receipt_date DESC, r.id DESC, ri.id ASC";

    const [rows] = await db.promise().query(query, values);

    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          receipt_no: row.receipt_no,
          receipt_date: row.receipt_date,
          customer_name: row.customer_name,
          payment_mode: row.payment_mode,
          bank_name: row.bank_name,
          total: row.total,
          grand_total: row.grand_total,
          other_deductions: row.other_deductions,
          force_amount: row.force_amount,
          remarks: row.remarks,
          address: row.address,
          gst_number: row.gst_number,
          phone: row.phone,
          items: [],
        });
      }
      map.get(row.id).items.push({
        item_id: row.item_id,
        bill_no: row.bill_no,
        bill_date: row.bill_date,
        bill_amount: row.bill_amount,
        paid_amount: row.paid_amount,
        balance: row.balance,
      });
    }

    res.json(Array.from(map.values()));
  } catch (error) {
    console.error("Voucher Report Error:", error);
    res.status(500).json({ message: "Report failed" });
  }
});

// Load Receipt by receipt_no  — generic param route must stay LAST
router.get("/:receipt_no", async (req, res) => {
  try {
    const receipt_no = decodeURIComponent(req.params.receipt_no);
    const [rows] = await db.promise().query(
      "SELECT * FROM receipts WHERE receipt_no = ?", [receipt_no]
    );
    if (!rows.length) return res.status(404).json({ message: "Receipt not found" });
    const receipt = rows[0];
    const [items] = await db.promise().query(
      "SELECT * FROM receipt_items WHERE receipt_id = ?", [receipt.id]
    );
    res.json({ header: receipt, items });
  } catch (error) {
    res.status(500).json({ message: "Failed to load receipt" });
  }
});

module.exports = router;
