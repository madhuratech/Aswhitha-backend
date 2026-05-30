const express = require("express");
const router = express.Router();
const db = require("../config/database");  


// Get All Clients 
router.get(`/clients`, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name AS supplier_name FROM newclient"
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search Clients
router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;

  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name AS supplier_name FROM newclient WHERE customer_name LIKE ? LIMIT 20",
      [searchTerm]
    );
    res.json(rows);
  } catch (error) {
    console.error("Error searching clients:", error);
    res.status(500).json({ message: "Client search failed" });
  }
});


// Create New Bill Wise Payment

router.post("/new", async(req,res) => {
try{

    const {entry_date, supplier_id, bank_name, reference_no, remarks, grand_total, items} = req.body;

    const safeTotal = Number(grand_total) || 0;

    const[paymententry] = await db.promise().query(
        "INSERT INTO billwise_payments (entry_date, supplier_id, bank_name, reference_no, remarks, grand_total) VALUES (?, ?, ?, ?, ?, ?)",
        [entry_date, supplier_id, bank_name, reference_no, remarks, safeTotal]
    );
    const paymentId = paymententry.insertId;

    //inside row

    for( const item of items){
        const amount = item.price * item.quantity;
        await db.promise().query(
            "INSERT INTO billwise_payment_items (payment_id, bill_no, bill_date, bill_amount, paid_amount,  balance_amount, payment_mode) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [paymentId, item.bill_no, item.bill_date, item.bill_amount, item.paid_amount, item.balance_amount, item.payment_mode]
        );
    }
   res.status(201).json({ message: "Bill Wise Payment Created Successfully" });

  }catch(error){
      console.log("Error Creating Bill Wise Payment", error);
      res.status(500).json({message: error.message});
    }
 
});

// UPDATE Bill Wise Payment

router.put("/update/:id", async(req, res) => {
    try{
        const {id} = req.params;
        const {entry_date, supplier_id, bank_name, reference_no, remarks, grand_total, items} = req.body;
       
        // Update main entry
        await db.promise().query(
            "UPDATE billwise_payments SET entry_date=?, supplier_id=?, bank_name=?, reference_no=?, remarks=?, grand_total=? WHERE id=?",
            [entry_date, supplier_id, bank_name, reference_no, remarks, grand_total, id]
        );

        // Delete existing items
        await db.promise().query(
            "DELETE FROM billwise_payment_items WHERE payment_id=?",
            [id]
        );

        // Insert updated items
        for(const item of items){
            const amount = item.price * item.quantity;
            await db.promise().query(
                "INSERT INTO billwise_payment_items (payment_id, bill_no, bill_date, bill_amount, paid_amount, balance_amount, payment_mode) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [id, item.bill_no, item.bill_date, item.bill_amount, item.paid_amount, item.balance_amount, item.payment_mode]
            );
        }

        res.json({message: "Bill Wise Payment Updated Successfully"});

    }catch(error){
        console.error("Error Updating Bill Wise Payment:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});


// Delete Bill Wise Payment
router.delete("/delete/:id", async(req, res) => {
    try{
        const {id} = req.params;

        // Delete Items
        await db.promise().query(
            "DELETE FROM billwise_payment_items WHERE payment_id=?",
            [id]
        );

        // Delete the main entry
        await db.promise().query(
            "DELETE FROM billwise_payments  WHERE id=?",
            [id]
        );

        res.json({message: "Bill Wise Payment Deleted Successfully"});
    }catch(error){
        console.error("Error Deleting Bill Wise Payment:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Get All Banks

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

// Get Bill number
router.get('/getbillno/:billNo', async (req, res) => {
  try {
    const { billNo } = req.params;

    // 1️⃣ Get items by bill_no
    const [items] = await db.promise().query(
      "SELECT * FROM billwise_payment_items WHERE bill_no = ?",
      [billNo]
    );

    if (items.length === 0) {
      return res.status(404).json({ message: "Bill not found" });
    }

    // 2️⃣ Get payment using payment_id
    const paymentId = items[0].payment_id;

   const [payments] = await db.promise().query(
  `SELECT 
     bp.*, 
     c.customer_name AS supplier_name,
     c.address,
     c.state,
     c.pincode,
     c.phone,
     c.email,
     c.gst_number
   FROM billwise_payments bp
   LEFT JOIN newclient c ON bp.supplier_id = c.id 
   WHERE bp.id = ?`,
  [paymentId]
);

    const payment = payments[0];

    // 3️⃣ Send correct response
    res.json({
      ...payment,
      items
    });

  } catch (error) {
    console.error("Error Fetching Bill No:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Get All Bill Wise Payments bill

router.get('/allbills', async (req, res) => {
    try{
        const [rows] = await db.promise().query(
            "SELECT DISTINCT bill_no  FROM billwise_payment_items ORDER BY bill_no DESC"
        );
        res.json(rows);
    }catch(error){
        console.error("Error Fetching Bills:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});


// Get All Bill Wise Payments Report
router.get('/report/filters', async (req, res) => {
    try{
        const {fromdate, todate, billno} = req.query;

        let query = `
        SELECT 
            bpi.bill_no,
            bpi.bill_date,
            bpi.bill_amount,
            bpi.paid_amount,
            bpi.balance_amount,
            bp.entry_date,
            bp.reference_no,
            bp.remarks,
            bp.grand_total,
            nc.customer_name AS supplier_name
        FROM billwise_payment_items bpi
        LEFT JOIN billwise_payments bp ON bpi.payment_id = bp.id
        LEFT JOIN newclient nc ON bp.supplier_id = nc.id
        WHERE 1=1
        `;

        const values = [];

        if(fromdate && todate){
            query += " AND bp.entry_date BETWEEN ? AND ?";
            values.push(fromdate, todate);
        }

        if(billno){
            query += " AND bpi.bill_no = ?";
            values.push(billno);
        }

        const [rows] = await db.promise().query(query, values);
        res.json(rows);

    }catch(error){
        console.error("Report Error:", error);
        res.status(500).json({message: "Report Failed"});
    }
});


module.exports = router;