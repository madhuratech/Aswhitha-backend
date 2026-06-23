const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull } = require("../helpers/sanitize");


router.post("/new", (req, res) => {
  const expenses = req.body;

  if (!Array.isArray(expenses) || expenses.length === 0) {
    return res.status(400).json({ message: "Invalid data" });
  }

  const values = [];

  for (let exp of expenses) {

    console.log("Received expense:", exp);

    if (!exp.expense_date || !exp.category || !exp.amount) {
      return res.status(400).json({
        message: "Date, category and amount are required"
      });
    }

    values.push([
      exp.expense_date,
      exp.category,
      parseFloat(exp.amount),
      emptyToNull(exp.expense_description),
      emptyToNull(exp.employee_name),
      exp.employee_id ? parseInt(exp.employee_id) : null
    ]);
  }

  const sql = `
    INSERT INTO expenses
    (
      expense_date,
      category,
      amount,
      expense_description,
      employee_name,
      employee_id
    )
    VALUES ?
  `;

  db.query(sql, [values], (err, result) => {
    if (err) {
      console.log(err);
      return res.status(500).json({
        message: err.sqlMessage
      });
    }

    res.json({
      success: true,
      inserted: result.affectedRows
    });
  });
});
router.get("/summary", (req, res) => {
  const sql = `
    SELECT category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM expenses
    GROUP BY category
    ORDER BY total DESC
  `;
  db.query(sql, (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ message: "Summary failed" });
    }
    const totalAmount = results.reduce((s, r) => s + Number(r.total), 0);
    const totalCount = results.reduce((s, r) => s + r.count, 0);
    res.json({ totalAmount, totalCount, byCategory: results });
  });
});

//Get all expense details

router.get("/all", (req, res) => {

    const sql = "SELECT * FROM expenses";

    db.query(sql, (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Retrieval failed" });
      }
      res.json(results);
    });

  });



// Employee list for expense report dropdown — returns id so form can store employee_id FK
router.get("/expense-employees", async (req, res) => {
  const { q } = req.query;
  try {
    const [rows] = await db.promise().query(
      `SELECT id, employee_name FROM employeedata
       WHERE employee_name LIKE ?
       ORDER BY employee_name ASC LIMIT 200`,
      [`%${q || ""}%`]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch employees" });
  }
});

// Employee-wise expense report (mirrors customer-ledger pattern)
router.get("/employee-expenses", async (req, res) => {
  try {
    const { employee_name, fromDate, toDate } = req.query;

    const conditions = [];
    const params = [];

    if (employee_name) {
      conditions.push("(COALESCE(ed.employee_name, e.employee_name) = ?)");
      params.push(employee_name);
    }

    if (fromDate && toDate) {
      conditions.push("e.expense_date BETWEEN ? AND ?");
      params.push(fromDate, toDate);
    }

    const whereClause =
      conditions.length > 0
        ? "WHERE " + conditions.join(" AND ")
        : "";

    const [rows] = await db.promise().query(
      `
      SELECT
        e.id,
        e.expense_date,
        e.category,
        e.amount,
        e.expense_description,
        CASE
          WHEN e.employee_name IS NOT NULL
               AND e.employee_name <> ''
               AND e.employee_name <> '-'
          THEN e.employee_name
          ELSE ed.employee_name
        END AS employee_name
      FROM expenses e
      LEFT JOIN employeedata ed
      ON e.employee_id = ed.id
      ${whereClause}
      ORDER BY e.expense_date ASC, e.id ASC
      `,
      params
    );

    const entries = rows.map((row, index) => ({
      sno: index + 1,
      expense_no: `EXP${String(row.id).padStart(4, "0")}`,
      date: row.expense_date,
      employee_name: row.employee_name || "",
      category: row.category,
      remarks: row.expense_description || "",
      amount: parseFloat(row.amount) || 0,
    }));

    const total_amount = entries.reduce(
      (sum, row) => sum + row.amount,
      0
    );

    res.json({
      entries,
      total_amount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch expense report" });
  }
});

module.exports = router;