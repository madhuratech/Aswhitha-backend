const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Recipt Auto Gentrate
 async function generateSupplierNumber() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM supplier_advance"
  );

  const nextId = (rows[0].lastId || 0) + 1;
  const year = new Date().getFullYear();

  return `SUP-${year}-${String(nextId).padStart(3, "0")}`;
}

// Get supplier receipt No;
router.get('/getrecipt', async(req,res) =>{
    try{
        const supplierNo = await generateSupplierNumber();
        res.json({receiptNo: supplierNo});
    }catch(error){
        console.log("Error generating Supplier Recipt no", error)
        res.status(500).json({message: "Error generating supplier recipt no"})
    }
});

// Get all suppliers
router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query("SELECT * FROM newclient ORDER BY customer_name ASC");
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// get all client search;

router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC",
      [`%${q}%`]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create supplier advance:

router.post("/create", async (req, res) => {
  try{
  const s = sanitizeBody(req.body);
  const receipt_no = await generateSupplierNumber();

  // Calculate
  const paid  = toNum(s.paid_amount);
  const tds   = toNum(s.tds);
  const others = toNum(s.others);
  const net_amount     = paid - tds - others;
  const balance_amount = net_amount;

  const [result] = await db.promise().query(
    "INSERT INTO supplier_advance (receipt_no, date, payment_mode, supplier_name, bank_name, ref_no, paid_amount, tds, others, net_amount, balance_amount, remarks, received_by, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [receipt_no, emptyToNull(s.date), emptyToNull(s.payment_mode), s.supplier_name, emptyToNull(s.bank_name), emptyToNull(s.ref_no), paid, tds, others, net_amount, balance_amount, emptyToNull(s.remarks), emptyToNull(s.received_by), emptyToNull(s.payment_status)]
  );

  res.status(200).json({message: "Supplier advance created successfully", id: result.insertId});
  } catch(error){
    console.log("Create Error",error);
    res.status(500).json({message: error.message});
  }
});

// search recipt no edit;
 router.get("/search/:receipt_no", async (req, res) => {
  try {
    const { receipt_no } = req.params;
    const [rows] = await db.promise().query(
      "SELECT * FROM supplier_advance WHERE receipt_no = ?",
      [receipt_no]
    );

    if (rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.status(404).json({ message: "Receipt not found" });
    }
  } catch (error) {
    console.log("Error fetching receipt", error);
    res.status(500).json({ message: error.message });
  }
});

// Get recipt no order by;

router.get(`/receipt_no`, async(req, res) => {
  try{
    const [rows] = await db.promise().query(
      "SELECT receipt_no FROM supplier_advance ORDER BY id DESC LIMIT 1"
    );
    res.json(rows);
  }catch(error){
     console.log("EROR",error)
    res.status(500).json({message: error.message});
  }
});

// Report gentrate;

router.get("/report", async (req, res) => {
  try {
    const { fromDate, toDate, receipt_no, supplier_name } = req.query;

    let sql = `
      SELECT 
        sa.id,
        sa.receipt_no,
        sa.date,
        sa.supplier_name,  
        sa.bank_name,
        sa.ref_no,
        sa.paid_amount,
        sa.tds,
        sa.others,
        sa.net_amount,
        sa.balance_amount,
        sa.remarks,
        sa.received_by,
        sa.payment_status,
        sa.payment_mode
      FROM supplier_advance sa
      WHERE 1=1
    `;

    let values = [];

    if (fromDate && toDate) {
      sql += " AND sa.date BETWEEN ? AND ?";
      values.push(fromDate, toDate);
    }

    if (receipt_no) {
      sql += " AND sa.receipt_no = ?";
      values.push(receipt_no);
    }

    if (supplier_name) {
     sql += " AND LOWER(sa.supplier_name) LIKE LOWER(?)";
  values.push(`%${supplier_name}%`);

}
    sql += " ORDER BY sa.id DESC";

    const [rows] = await db.promise().query(sql, values);

    res.json(rows);

  } catch (error) {
    console.log("Report Error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Edit forms;

router.put('/update/:receipt_no', async (req, res) => {
  try {
    const { receipt_no } = req.params;
    const s = sanitizeBody(req.body);

    const paid    = toNum(s.paid_amount);
    const tds     = toNum(s.tds);
    const others  = toNum(s.others);
    const net_amount     = paid - tds - others;
    const balance_amount = net_amount;

    const sql = `
      UPDATE supplier_advance SET
        date = ?,
        supplier_name = ?,
        bank_name = ?,
        ref_no = ?,
        paid_amount = ?,
        tds = ?,
        others = ?,
        net_amount = ?,
        payment_mode = ?,
        balance_amount = ?,
        remarks = ?,
        received_by = ?,
        payment_status = ?
      WHERE receipt_no = ?
    `;

    await db.promise().query(sql, [
      emptyToNull(s.date),
      s.supplier_name,
      emptyToNull(s.bank_name),
      emptyToNull(s.ref_no),
      paid,
      tds,
      others,
      net_amount,
      emptyToNull(s.payment_mode),
      balance_amount,
      emptyToNull(s.remarks),
      emptyToNull(s.received_by),
      emptyToNull(s.payment_status),
      receipt_no
    ]);

    res.json({ message: "Updated successfully" });

  } catch (error) {
    console.log("Update Error", error);
    res.status(500).json({ message: error.message });
  }
});
 




// Delete receipt no:
router.delete('/delete/:receipt_no', async(req, res) => {
  try{
    const {receipt_no} = req.params;
    const [result] = await db.promise().query(
      'DELETE FROM supplier_advance WHERE receipt_no = ?',
      [receipt_no]
    );
    if(result.affectedRows > 0){
      res.json({message: 'Receipt deleted successfully'});
    }else{
      res.status(404).json({message: 'Receipt not found'});
    }
  }catch(error){
    console.log("Delete Error", error);
    res.status(500).json({message: error.message});
  }
});


// Get Banks;
router.get('/banks',async(req,res) =>{
  try{
      const response = await fetch("https://findmebank.com/api/v1/banks");
      const data = await response.json();
      res.json(data);
  }catch(error){
    console.log("Bank Error", error);
    res.status(500).json({message: error.message})
  }
});

// Get Po Client name;
router.get("/purchase/:name", async(req,res) => {
  try{
    const {name} = req.params;

    const[rows] = await db.promise().query(
       `SELECT * FROM purchase_orders 
       WHERE client_name = ? 
       ORDER BY id DESC LIMIT 1`,
      [name]
    );

    if(rows.length === 0){
      return res.json({grandTotal: 0})
    }
    res.json(rows[0]);  
  }catch(error){
    console.log("Error fetching po", error);
    res.status(500).json({message: error.message})
  }
});

module.exports = router;   