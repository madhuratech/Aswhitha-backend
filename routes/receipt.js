const express = require("express");
const router = express.Router();
const db = require("../config/database");

// ── DB migration: add bank_name & reference_number if not present ──────────
(async () => {
  const tables = ["receipts", "receipt_items"];
  const cols = ["bank_name", "reference_number"];
  for (const table of tables) {
    for (const col of cols) {
      try {
        await db.promise().query(
          `ALTER TABLE ${table} ADD COLUMN ${col} VARCHAR(100) DEFAULT NULL`
        );
      } catch (e) {
        // Ignore column already exists errors
      }
    }
  }
  const receiptItemsExtra = [
    { name: "payment_mode", type: "VARCHAR(100)" },
    { name: "remarks", type: "VARCHAR(255)" },
    { name: "tds_amt", type: "DECIMAL(15,2) DEFAULT 0.00" },
    { name: "advance_paid", type: "DECIMAL(15,2) DEFAULT 0.00" }
  ];
  for (const col of receiptItemsExtra) {
    try {
      await db.promise().query(
        `ALTER TABLE receipt_items ADD COLUMN ${col.name} ${col.type} DEFAULT NULL`
      );
    } catch (e) { }
  }
})();

// Auto-generate Receipt Number (plain, starting from 930)
// Atomic get-and-increment via receipt_running_number counter
async function getAndIncrementReceiptNo(conn) {
  const runner = conn || db.promise();
  const ownsConn = !conn;
  try {
    if (ownsConn) await runner.beginTransaction();
    const [rows] = await runner.query(
      "SELECT current_number FROM receipt_running_number WHERE id = 1 FOR UPDATE"
    );
    const current = rows[0].current_number;
    await runner.query(
      "UPDATE receipt_running_number SET current_number = current_number + 1 WHERE id = 1"
    );
    if (ownsConn) await runner.commit();
    return String(current);
  } catch (err) {
    if (ownsConn) await runner.rollback();
    throw err;
  } finally {
    if (ownsConn && runner.release) runner.release();
  }
}

// Preview current receipt number (read-only, no increment)
async function getCurrentReceiptNo() {
  const [rows] = await db.promise().query(
    "SELECT current_number FROM receipt_running_number WHERE id = 1"
  );
  return String(rows[0].current_number);
}

async function generateReceiptNo() {
  return getAndIncrementReceiptNo();
}

router.get("/next-receipt-no", async (req, res) => {
  try {
    const receipt_no = await getCurrentReceiptNo();
    res.json({ receipt_no });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to generate receipt number" });
  }
});

// Get Clients — customers who have at least one invoice across all invoice types
router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT customer_name
       FROM (
         SELECT customer_name FROM salesinvoice
         UNION
         SELECT customer_name FROM service_invoices
         UNION
         SELECT customer_name FROM directinvoice
       ) AS all_customers
       ORDER BY customer_name ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search Clients — customers across all invoice types
router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  const like = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      `SELECT DISTINCT customer_name
       FROM (
         SELECT customer_name FROM salesinvoice WHERE customer_name LIKE ?
         UNION
         SELECT customer_name FROM service_invoices WHERE customer_name LIKE ?
         UNION
         SELECT customer_name FROM directinvoice WHERE customer_name LIKE ?
       ) AS all_customers
       ORDER BY customer_name ASC
       LIMIT 20`,
      [like, like, like]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Client search failed" });
  }
});

// Get Customer Pending Bills — all invoice types, deducts receipt + billwise payments, only unpaid
router.get("/customer-bills/:customerName", async (req, res) => {
  try {
    const customerName = decodeURIComponent(req.params.customerName);
    const [rows] = await db.promise().query(
      `SELECT bill_no, bill_date, bill_amount, already_paid, pending_balance
       FROM (
         SELECT
           si.invoice_no AS bill_no,
           si.invoice_date AS bill_date,
           si.grandtotal AS bill_amount,
           (
             COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = si.invoice_no), 0)
             + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = si.invoice_no), 0)
           ) AS already_paid,
           (si.grandtotal
             - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = si.invoice_no), 0)
             - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = si.invoice_no), 0)
           ) AS pending_balance
         FROM salesinvoice si
         WHERE si.customer_name = ?

         UNION ALL

         SELECT
           sv.invoice_no AS bill_no,
           sv.invoice_date AS bill_date,
           sv.grand_total AS bill_amount,
           (
             COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0)
             + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0)
           ) AS already_paid,
           (sv.grand_total
             - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0)
             - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0)
           ) AS pending_balance
         FROM service_invoices sv
         WHERE sv.customer_name = ?

         UNION ALL

         SELECT
           d.invoice_no AS bill_no,
           d.invoice_date AS bill_date,
           d.grandtotal AS bill_amount,
           (
             COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0)
             + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0)
           ) AS already_paid,
           (d.grandtotal
             - COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0)
             - COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0)
           ) AS pending_balance
         FROM directinvoice d
         WHERE d.customer_name = ?
       ) combined
       WHERE pending_balance > 0
       ORDER BY bill_date ASC`,
      [customerName, customerName, customerName]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to fetch bills" });
  }
});

// Create Receipt
router.post("/new", async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Atomically generate receipt number
    const receipt_no = await getAndIncrementReceiptNo(conn);

    const {
      receipt_date, customer_name,
      payment_mode, bank_name, cheque_no, cheque_date,
      total, force_amount, other_deductions, grand_total, remarks,
      items, reference_number
    } = req.body;

    const header_payment_mode = payment_mode || (items && items[0]?.payment_mode) || "";
    const header_bank_name = bank_name || (items && items[0]?.bank_name) || "";
    const header_reference_number = reference_number || cheque_no || (items && items[0]?.reference_number) || "";

    const [result] = await conn.query(
      `INSERT INTO receipts
       (receipt_no, receipt_date, customer_name, payment_mode, bank_name, cheque_no, cheque_date,
        total, force_amount, other_deductions, grand_total, remarks, reference_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [receipt_no, receipt_date, customer_name, header_payment_mode, header_bank_name,
        cheque_no || '', cheque_date || null,
        total || 0, force_amount || 0, other_deductions || 0, grand_total || 0, remarks || "", header_reference_number]
    );

    const receiptId = result.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO receipt_items (receipt_id, bill_no, bill_date, bill_amount, paid_amount, balance, payment_mode, bank_name, reference_number, remarks, tds_amt, advance_paid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptId, item.bill_no, item.bill_date, item.bill_amount, item.paid_amount, item.balance,
          item.payment_mode || header_payment_mode, item.bank_name || header_bank_name, item.reference_number || header_reference_number, item.remarks || remarks || '',
          item.tds_amt || 0, item.advance_paid || 0]
      );
    }

    await conn.commit();
    res.status(201).json({ message: "Receipt saved successfully", receipt_no });
  } catch (error) {
    await conn.rollback();
    console.error(error);
    res.status(500).json({ message: "Failed to save receipt" });
  } finally {
    conn.release();
  }
});

// Update Receipt
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      receipt_date, customer_name, payment_mode, bank_name,
      cheque_no, cheque_date, total, force_amount, other_deductions,
      grand_total, remarks, items, reference_number
    } = req.body;

    const header_payment_mode = payment_mode || (items && items[0]?.payment_mode) || "";
    const header_bank_name = bank_name || (items && items[0]?.bank_name) || "";
    const header_reference_number = reference_number || cheque_no || (items && items[0]?.reference_number) || "";

    await db.promise().query(
      `UPDATE receipts SET
       receipt_date=?, customer_name=?, payment_mode=?, bank_name=?,
       cheque_no=?, cheque_date=?, total=?, force_amount=?, other_deductions=?,
       grand_total=?, remarks=?, reference_number=?
       WHERE id=?`,
      [receipt_date, customer_name, header_payment_mode, header_bank_name,
        cheque_no || '', cheque_date || null,
        total || 0, force_amount || 0, other_deductions || 0,
        grand_total || 0, remarks || "", header_reference_number, id]
    );

    await db.promise().query("DELETE FROM receipt_items WHERE receipt_id=?", [id]);

    for (const item of items) {
      await db.promise().query(
        `INSERT INTO receipt_items (receipt_id, bill_no, bill_date, bill_amount, paid_amount, balance, payment_mode, bank_name, reference_number, remarks, tds_amt, advance_paid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, item.bill_no, item.bill_date, item.bill_amount, item.paid_amount, item.balance,
          item.payment_mode || header_payment_mode, item.bank_name || header_bank_name, item.reference_number || header_reference_number, item.remarks || remarks || '',
          item.tds_amt || 0, item.advance_paid || 0]
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

// Generate Advance Receipt Number (plain, shared counter with receipts)
async function generateAdvanceNo() {
  return getAndIncrementReceiptNo();
}

router.get("/next-advance-no", async (req, res) => {
  try {
    const receipt_no = await getCurrentReceiptNo();
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

// Receipt Report — receipt numbers dropdown
router.get("/report/receipt-nos", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT r.receipt_no
       FROM receipts r
       WHERE EXISTS (SELECT 1 FROM receipt_items ri WHERE ri.receipt_id = r.id)
       ORDER BY r.id DESC`
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
        r.reference_number,
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
               r.payment_mode, r.bank_name, r.reference_number, r.total, r.grand_total, r.remarks
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
      `SELECT DISTINCT customer_name FROM (
         SELECT customer_name FROM salesinvoice
         UNION
         SELECT customer_name FROM service_invoices
         UNION
         SELECT customer_name FROM directinvoice
         UNION
         SELECT supplier_name AS customer_name FROM purchase_entry
       ) AS all_customers
       WHERE customer_name LIKE ?
       ORDER BY customer_name ASC LIMIT 200`,
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

    // Outstanding: invoices that still have unpaid balance
    if (type === "outstanding") {
      const conditions = [];
      const params = [];
      if (customer_name) {
        conditions.push("customer_name = ?");
        params.push(customer_name);
      }
      const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

      const [outstanding] = await db.promise().query(
        `SELECT
          customer_name,
          bill_no,
          date,
          bill_amount,
          receipt_paid,
          billwise_paid,
          (receipt_paid + billwise_paid) AS paid_amount,
          (bill_amount - receipt_paid - billwise_paid) AS balance
        FROM (
          SELECT
            si.invoice_no AS bill_no,
            si.invoice_date AS date,
            si.grandtotal AS bill_amount,
            si.customer_name,
            COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = si.invoice_no), 0) AS receipt_paid,
            COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = si.invoice_no), 0) AS billwise_paid
          FROM salesinvoice si

          UNION ALL

          SELECT
            sv.invoice_no AS bill_no,
            sv.invoice_date AS date,
            sv.grand_total AS bill_amount,
            sv.customer_name,
            COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = sv.invoice_no), 0) AS receipt_paid,
            COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = sv.invoice_no), 0) AS billwise_paid
          FROM service_invoices sv

          UNION ALL

          SELECT
            d.invoice_no AS bill_no,
            d.invoice_date AS date,
            d.grandtotal AS bill_amount,
            d.customer_name,
            COALESCE((SELECT SUM(ri.paid_amount) FROM receipt_items ri WHERE ri.bill_no = d.invoice_no), 0) AS receipt_paid,
            COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = d.invoice_no), 0) AS billwise_paid
          FROM directinvoice d

          UNION ALL

          SELECT
            pe.bill_no,
            pe.bill_date AS date,
            pe.grand_total AS bill_amount,
            pe.supplier_name AS customer_name,
            0 AS receipt_paid,
            COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = pe.bill_no), 0) AS billwise_paid
          FROM purchase_entry pe
        ) AS inner_invoices
        ${whereClause}
        ORDER BY date ASC`,
        params
      );

      return res.json({
        customer_name: customer_name || "ALL",
        type: "outstanding",
        outstanding: outstanding.map(row => ({
          ...row,
          bill_amount: parseFloat(row.bill_amount),
          paid_amount: parseFloat(row.paid_amount),
          balance: parseFloat(parseFloat(row.balance).toFixed(2))
        }))
      });
    }

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

    const [invoices] = await db.promise().query(
      `SELECT inv.invoice_no AS bill_no, inv.invoice_date AS date,
          inv.grandtotal AS debit,
          0 AS credit,
          '' AS receipt_no,
          '' AS paid_date,
          '' AS payment_mode,
          '' AS bank_name,
          '' AS reference_number,
          IFNULL(inv.payment_terms,'') AS notes, 'invoice' AS entry_type
        FROM (
          SELECT invoice_no, invoice_date, grandtotal, '' AS payment_terms, customer_name FROM salesinvoice
          UNION ALL
          SELECT invoice_no, invoice_date, grand_total AS grandtotal, '' AS payment_terms, customer_name FROM service_invoices
          UNION ALL
          SELECT invoice_no, invoice_date, grandtotal, payment_terms, customer_name FROM directinvoice
        ) inv
        ${invoiceWhere}`,
      invoiceParams
    );

    // Build receipt query
    const rConditions = [];
    const receiptParams = [];
    if (customer_name) {
      rConditions.push("r.customer_name = ?");
      receiptParams.push(customer_name);
    }
    if (fromDate && toDate) {
      rConditions.push("r.receipt_date BETWEEN ? AND ?");
      receiptParams.push(fromDate, toDate);
    }
    const receiptWhere = rConditions.length ? "WHERE " + rConditions.join(" AND ") : "";

    const [receipts] = await db.promise().query(
      `SELECT ri.bill_no AS bill_no, r.receipt_date AS date,
          0 AS debit,
          ri.paid_amount AS credit,
          r.receipt_no AS receipt_no,
          r.receipt_date AS paid_date,
          IFNULL(NULLIF(TRIM(CONCAT_WS(' ', r.bank_name, r.remarks)),''), r.payment_mode) AS payment_mode,
          IFNULL(r.bank_name, '') AS bank_name,
          IFNULL(r.reference_number, '') AS reference_number,
          IFNULL(r.remarks, '') AS notes, 'receipt' AS entry_type
        FROM receipt_items ri
        INNER JOIN receipts r ON r.id = ri.receipt_id
        ${receiptWhere}`,
      receiptParams
    );

    // Build tax purchase entry query (credit)
    const tpConditions = [];
    const tpParams = [];
    if (customer_name) {
      tpConditions.push("pe.supplier_name = ?");
      tpParams.push(customer_name);
    }
    if (fromDate && toDate) {
      tpConditions.push("pe.bill_date BETWEEN ? AND ?");
      tpParams.push(fromDate, toDate);
    }
    const tpWhere = tpConditions.length ? "WHERE " + tpConditions.join(" AND ") : "";

    const [taxPurchases] = await db.promise().query(
      `SELECT
         pe.bill_no          AS bill_no,
         pe.bill_date        AS date,
         0                   AS debit,
         pe.grand_total      AS credit,
         ''                  AS receipt_no,
         pe.bill_date        AS paid_date,
         ''                  AS payment_mode,
         ''                  AS bank_name,
         ''                  AS reference_number,
         ''                  AS notes,
         'tax_purchase_entry' AS entry_type
       FROM purchase_entry pe
       ${tpWhere}`,
      tpParams
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
      `SELECT
      bpi.bill_no        AS bill_no,
      bpi.bill_date      AS bill_date,
      bp.entry_date      AS date,
      bpi.paid_amount    AS debit,
      0                  AS credit,
      IFNULL(bp.receipt_no, '')          AS receipt_no,
      bp.entry_date      AS paid_date,
      IFNULL(bpi.payment_mode, '')       AS payment_mode,
      IFNULL(bp.bank_name, '')           AS bank_name,
      IFNULL(bp.reference_no, '')        AS reference_number,
      nc.customer_name   AS customer_name,
      IFNULL(bp.remarks, '')             AS notes,
      'bill_wise_payment' AS entry_type
   FROM billwise_payment_items bpi
   INNER JOIN billwise_payments bp
      ON bpi.payment_id = bp.id
   INNER JOIN newclient nc
      ON bp.supplier_id = nc.id
   ${paymentWhere}`,
      paymentParams
    );

    // Sort by date ascending. If same date, sort by business flow: invoice → receipt → tax_purchase_entry → bill_wise_payment.
    const combined = [...invoices, ...receipts, ...taxPurchases, ...payments].sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      if (dateA - dateB !== 0) {
        return dateA - dateB;
      }
      const orderMap = { invoice: 1, receipt: 2, tax_purchase_entry: 3, bill_wise_payment: 4 };
      const orderA = orderMap[a.entry_type] || 99;
      const orderB = orderMap[b.entry_type] || 99;
      if (orderA !== orderB) return orderA - orderB;
      return (a.bill_no || '').localeCompare(b.bill_no || '') || (a.receipt_no || '').localeCompare(b.receipt_no || '');
    });

    let balance = 0;
    const entries = combined.map((row, idx) => {
      balance += (Number(row.debit) || 0) - (Number(row.credit) || 0);
      return { ...row, sno: idx + 1, balance: parseFloat(balance.toFixed(2)) };
    });

    const totalDebit = entries.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = entries.reduce((s, r) => s + Number(r.credit), 0);

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
    const { fromDate, toDate, customerName, receiptNo } = req.query;

    let query = `
      SELECT
        r.id, r.receipt_no, r.receipt_date, r.customer_name,
        r.payment_mode, r.bank_name, r.reference_number, r.total, r.grand_total,
        r.other_deductions, r.force_amount, r.remarks,
        nc.address, nc.gst_number, nc.phone, nc.state, nc.pincode,
        ri.id AS item_id, ri.bill_no,
        COALESCE(
          ri.bill_date,
          (SELECT invoice_date FROM salesinvoice WHERE invoice_no = ri.bill_no LIMIT 1),
          (SELECT invoice_date FROM service_invoices WHERE invoice_no = ri.bill_no LIMIT 1),
          (SELECT invoice_date FROM directinvoice WHERE invoice_no = ri.bill_no LIMIT 1)
        ) AS bill_date,
        ri.bill_amount, ri.paid_amount, ri.balance, ri.tds_amt, ri.advance_paid,
        ri.payment_mode AS item_payment_mode, ri.bank_name AS item_bank_name, ri.reference_number AS item_reference_number, ri.remarks AS item_remarks
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
    if (receiptNo) {
      query += " AND r.receipt_no = ?";
      values.push(receiptNo);
    }

    const hasFilters = (fromDate && toDate) || customerName || receiptNo;
    if (!hasFilters) {
      const [latestRows] = await db.promise().query(
        "SELECT id FROM receipts ORDER BY id DESC LIMIT 1"
      );
      if (latestRows.length) {
        query += " AND r.id = ?";
        values.push(latestRows[0].id);
      } else {
        query += " AND 1=0";
      }
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
          reference_number: row.reference_number,
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
        tds_amt: row.tds_amt,
        advance_paid: row.advance_paid,
        payment_mode: row.item_payment_mode,
        bank_name: row.item_bank_name,
        reference_number: row.item_reference_number,
        remarks: row.item_remarks
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
      `SELECT r.*, nc.address, nc.gst_number, nc.phone
       FROM receipts r
       LEFT JOIN newclient nc ON nc.customer_name = r.customer_name
       WHERE r.receipt_no = ?`, [receipt_no]
    );
    if (!rows.length) return res.status(404).json({ message: "Receipt not found" });
    const receipt = rows[0];
    const [items] = await db.promise().query(
      `SELECT ri.id, ri.receipt_id, ri.bill_no,
        COALESCE(
          ri.bill_date,
          (SELECT invoice_date FROM salesinvoice WHERE invoice_no = ri.bill_no LIMIT 1),
          (SELECT invoice_date FROM service_invoices WHERE invoice_no = ri.bill_no LIMIT 1),
          (SELECT invoice_date FROM directinvoice WHERE invoice_no = ri.bill_no LIMIT 1)
        ) AS bill_date,
        ri.bill_amount, ri.paid_amount, ri.balance, ri.payment_mode, ri.bank_name, ri.reference_number, ri.remarks, ri.tds_amt, ri.advance_paid,
        (
          COALESCE((SELECT SUM(ri2.paid_amount) FROM receipt_items ri2 WHERE ri2.bill_no = ri.bill_no AND ri2.receipt_id != ri.receipt_id), 0)
          + COALESCE((SELECT SUM(bpi.paid_amount) FROM billwise_payment_items bpi WHERE bpi.bill_no = ri.bill_no), 0)
        ) AS already_paid
       FROM receipt_items ri
       WHERE ri.receipt_id = ?`, [receipt.id]
    );
    res.json({ header: receipt, items });
  } catch (error) {
    res.status(500).json({ message: "Failed to load receipt" });
  }
});

module.exports = router;
