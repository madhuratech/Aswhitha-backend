const express = require("express");
const router = express.Router();
const db = require("../config/database");


router.post("/new", (req, res) => {
  const expenses = req.body;

  console.log("REQ BODY:", expenses); 

  
  if (!Array.isArray(expenses) || expenses.length === 0) {
    return res.status(400).json({ message: "Invalid data" });
  }

  const values = [];

  for (let exp of expenses) {
    
    if (
      !exp.expense_date ||
      !exp.category ||
      !exp.amount ||
      !exp.expense_description
    ) {
      return res.status(400).json({ message: "required fields missing" });
    }

    const amount = parseFloat(exp.amount);

    if (isNaN(amount)) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    values.push([
      exp.expense_date,
      exp.category,
      amount,
      exp.expense_description
    ]);
  }

  const sql = `
    INSERT INTO expenses
    (expense_date, category, amount, expense_description)
    VALUES ?
  `;

  db.query(sql, [values], (err, result) => {
    if (err) {
      console.error("DB ERROR FULL:", err); 
      return res.status(500).json({
        message: "database error",
        error: err.sqlMessage 
      });
    }

    res.json({
      success: true,
      inserted: result.affectedRows
    });
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



module.exports = router;