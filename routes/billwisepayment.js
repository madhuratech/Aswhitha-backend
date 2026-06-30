const express = require("express");
const router  = express.Router();
const db      = require("../config/database");

// ── DB migration: add tds_amount & delivery_charge if not present ──────────
(async () => {
  const cols = ["tds_amount", "delivery_charge"];
  for (const col of cols) {
    try {
      await db.promise().query(
        `ALTER TABLE billwise_payment_items ADD COLUMN ${col} DECIMAL(10,2) DEFAULT 0`
      );
    } catch (e) {
      // Column already exists — ignore
    }
  }

  // Also add bank_name and reference_number / reference_no if missing
  const extraCols = [
    { table: "billwise_payments", col: "bank_name", type: "VARCHAR(100)" },
    { table: "billwise_payments", col: "reference_no", type: "VARCHAR(100)" },
    { table: "billwise_payments", col: "reference_number", type: "VARCHAR(100)" },
    { table: "billwise_payments", col: "receipt_no", type: "VARCHAR(100)" },
    { table: "billwise_payment_items", col: "bank_name", type: "VARCHAR(100)" },
    { table: "billwise_payment_items", col: "reference_number", type: "VARCHAR(100)" },
    { table: "billwise_payment_items", col: "reference_no", type: "VARCHAR(100)" }
  ];
  for (const item of extraCols) {
    try {
      await db.promise().query(
        `ALTER TABLE ${item.table} ADD COLUMN ${item.col} ${item.type} DEFAULT NULL`
      );
    } catch (e) {}
  }
})();

// Auto-generate Bill-Wise Payment Number (plain, starting from 565)
// Atomic get-and-increment via bwp_running_number counter
async function getAndIncrementBwpNo(conn) {
  const runner = conn || db.promise();
  const ownsConn = !conn;
  try {
    if (ownsConn) await runner.beginTransaction();
    const [rows] = await runner.query(
      "SELECT current_number FROM bwp_running_number WHERE id = 1 FOR UPDATE"
    );
    const current = rows[0].current_number;
    await runner.query(
      "UPDATE bwp_running_number SET current_number = current_number + 1 WHERE id = 1"
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

async function getCurrentBwpNo() {
  const [rows] = await db.promise().query(
    "SELECT current_number FROM bwp_running_number WHERE id = 1"
  );
  return String(rows[0].current_number);
}

async function generateReceiptNo() {
  return getAndIncrementBwpNo();
}

router.get("/next-receipt-no", async (req, res) => {
  try {
    const receipt_no = await getCurrentBwpNo();
    res.json({ receipt_no });
  } catch (err) {
    res.status(500).json({ message: "Failed to generate receipt number" });
  }
});

// ── GET suppliers who have Tax Purchase Entry bills ────────────────────────
router.get("/suppliers-with-bills", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT DISTINCT supplier_name FROM purchase_entry ORDER BY supplier_name"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET pending bills for a supplier from purchase_entry ───────────────────
router.get("/bills-by-supplier/:supplierName", async (req, res) => {
  const { supplierName } = req.params;
  try {
    const [rows] = await db.promise().query(
      `SELECT
         pe.bill_no,
         pe.bill_date,
         pe.grand_total AS bill_amount,
         pe.supplier_name,
         COALESCE(SUM(bpi.paid_amount), 0) AS total_paid
       FROM purchase_entry pe
       LEFT JOIN billwise_payment_items bpi ON bpi.bill_no = pe.bill_no
       WHERE pe.supplier_name = ?
       GROUP BY pe.bill_no, pe.bill_date, pe.grand_total, pe.supplier_name
       ORDER BY pe.bill_date DESC`,
      [supplierName]
    );
    res.json(rows);
  } catch (err) {
    console.error("bills-by-supplier error:", err);
    res.status(500).json({ message: err.message });
  }
});

// ── GET total previously paid for a bill ──────────────────────────────────
router.get("/previous-paid/:billNo", async (req, res) => {
  const { billNo } = req.params;
  try {
    const [rows] = await db.promise().query(
      "SELECT COALESCE(SUM(paid_amount), 0) AS total_paid FROM billwise_payment_items WHERE bill_no = ?",
      [billNo]
    );
    res.json({ total_paid: rows[0].total_paid });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET all clients (general supplier list) ────────────────────────────────
router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name AS supplier_name FROM newclient ORDER BY customer_name ASC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── SEARCH clients ─────────────────────────────────────────────────────────
router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name AS supplier_name FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
      [searchTerm]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Client search failed" });
  }
});

// ── CREATE new bill-wise payment ───────────────────────────────────────────
router.post("/new", async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Atomically generate BWP number
    const finalReceiptNo = await getAndIncrementBwpNo(conn);

    const {
      entry_date, supplier_name, bank_name, reference_no,
      remarks, grand_total, bank_date, items,
    } = req.body;

    const [result] = await conn.query(
      `INSERT INTO billwise_payments
         (entry_date, supplier_id, bank_name, reference_no, reference_number, remarks, grand_total, receipt_no)
       VALUES (?, (SELECT id FROM newclient WHERE customer_name = ? LIMIT 1), ?, ?, ?, ?, ?, ?)`,
      [entry_date, supplier_name, bank_name, reference_no || '', reference_no || '', remarks, Number(grand_total) || 0, finalReceiptNo]
    );
    const paymentId = result.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO billwise_payment_items
           (payment_id, bill_no, bill_date, bill_amount, paid_amount,
            balance_amount, payment_mode, tds_amount, delivery_charge, bank_name, reference_no, reference_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          paymentId,
          item.bill_no,
          item.bill_date,
          item.bill_amount,
          item.paid_amount,
          item.balance_amount,
          item.payment_mode,
          item.tds_amount       || 0,
          item.delivery_charge  || 0,
          bank_name || '',
          reference_no || '',
          reference_no || '',
        ]
      );
    }

    await conn.commit();
    res.status(201).json({
      message:    "Bill Wise Payment Created Successfully",
      id:         paymentId,
      receipt_no: finalReceiptNo,
      bill_no:    items[0]?.bill_no || "",
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating bill-wise payment:", err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── UPDATE bill-wise payment ───────────────────────────────────────────────
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      entry_date, supplier_name, bank_name, reference_no,
      remarks, grand_total, bank_date, items, receipt_no,
    } = req.body;

    await db.promise().query(
      `UPDATE billwise_payments
       SET entry_date=?, supplier_id=(SELECT id FROM newclient WHERE customer_name=? LIMIT 1),
           bank_name=?, reference_no=?, reference_number=?, remarks=?, grand_total=?, receipt_no=?
       WHERE id=?`,
      [entry_date, supplier_name, bank_name, reference_no || '', reference_no || '', remarks, grand_total, receipt_no, id]
    );

    await db.promise().query(
      "DELETE FROM billwise_payment_items WHERE payment_id=?", [id]
    );

    for (const item of items) {
      await db.promise().query(
        `INSERT INTO billwise_payment_items
           (payment_id, bill_no, bill_date, bill_amount, paid_amount,
            balance_amount, payment_mode, tds_amount, delivery_charge, bank_name, reference_no, reference_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          item.bill_no,
          item.bill_date,
          item.bill_amount,
          item.paid_amount,
          item.balance_amount,
          item.payment_mode,
          item.tds_amount       || 0,
          item.delivery_charge  || 0,
          bank_name || '',
          reference_no || '',
          reference_no || '',
        ]
      );
    }

    res.json({ message: "Bill Wise Payment Updated Successfully" });
  } catch (err) {
    console.error("Error updating bill-wise payment:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ── DELETE bill-wise payment ───────────────────────────────────────────────
router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.promise().query("DELETE FROM billwise_payment_items WHERE payment_id=?", [id]);
    await db.promise().query("DELETE FROM billwise_payments WHERE id=?", [id]);
    res.json({ message: "Bill Wise Payment Deleted Successfully" });
  } catch (err) {
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ── GET banks ──────────────────────────────────────────────────────────────
router.get("/banks", async (req, res) => {
  try {
    const response = await fetch("https://findmebank.com/api/v1/banks");
    const data     = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET payment by bill_no ─────────────────────────────────────────────────
router.get("/getbillno/:billNo", async (req, res) => {
  try {
    const { billNo } = req.params;

    const [items] = await db.promise().query(
      "SELECT * FROM billwise_payment_items WHERE bill_no = ?",
      [billNo]
    );

    if (items.length === 0) {
      return res.status(404).json({ message: "Bill not found" });
    }

    const paymentId = items[0].payment_id;

    const [payments] = await db.promise().query(
      `SELECT bp.*,
              c.customer_name AS supplier_name,
              c.address, c.state, c.pincode, c.phone, c.email, c.gst_number
       FROM billwise_payments bp
       LEFT JOIN newclient c ON bp.supplier_id = c.id
       WHERE bp.id = ?`,
      [paymentId]
    );

    res.json({ ...payments[0], items });
  } catch (err) {
    console.error("Error fetching bill:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ── GET all bill-wise payment bill numbers ─────────────────────────────────
router.get("/allbills", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT DISTINCT bill_no FROM billwise_payment_items ORDER BY bill_no DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ── GET payment report ─────────────────────────────────────────────────────
router.get("/report/filters", async (req, res) => {
  try {
    const { fromdate, todate, billno } = req.query;
    let query = `
      SELECT
        bpi.bill_no, bpi.bill_date, bpi.bill_amount, bpi.paid_amount,
        bpi.balance_amount, bpi.tds_amount, bpi.delivery_charge,
        bp.entry_date, bp.reference_no, bp.bank_name, bp.remarks, bp.grand_total,
        bp.receipt_no,
        nc.customer_name AS supplier_name
      FROM billwise_payment_items bpi
      LEFT JOIN billwise_payments bp ON bpi.payment_id = bp.id
      LEFT JOIN newclient nc ON bp.supplier_id = nc.id
      WHERE 1=1
    `;
    const values = [];
    if (fromdate && todate) { query += " AND bp.entry_date BETWEEN ? AND ?"; values.push(fromdate, todate); }
    if (billno)             { query += " AND bpi.bill_no = ?";               values.push(billno); }

    const [rows] = await db.promise().query(query, values);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Report Failed" });
  }
});

module.exports = router;
