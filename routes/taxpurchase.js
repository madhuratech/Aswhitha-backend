const express = require("express");
const router = express.Router();
const db = require("../config/database");
const axios = require("axios");

// Self-migration: ensure serial_no column exists in purchase_entry_items
(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE purchase_entry_items ADD COLUMN serial_no VARCHAR(255) NULL"
    ).catch(() => {});
    console.log("purchase_entry_items table migrated successfully");
  } catch (err) {
    console.error("Error migrating purchase_entry_items table:", err.message);
  }
})();

// Auto Gentrate Bill No

async function generateBillNo(){
    const [rows] = await db.promise().query(
        "SELECT MAX(id) AS lastId FROM purchase_entry"
    );
    const nextId = (rows[0].lastId || 0) + 1;
    return `BILL-${String(nextId).padStart(3,"0")}`;
}

// Get Bill No
router.get("/nextbillno", async(req,res) => {
 try{
    const billNo = await generateBillNo();
    res.json({bill_no: billNo});
 }catch(error){
    console.log("ERROR Generating Bill No:",error);
    res.status(500).json({message: error.message});
 }
})


// Bill No Search:

router.get("/billno/search", async(req,res) => {
    const{ q } = req.query;
    const searchTerm = `%${q || ""}%`;
    try{
        const[rows] = await db.promise().query(
            "SELECT bill_no FROM purchase_entry WHERE bill_no LIKE ?",
            [searchTerm]
        );
        res.json(rows);
    }catch(err){
        console.log("Error Fetching ",err);
        res.status(500).json({message: "Error Fetching Bill No"});
    }
});



// Get all clients
router.get(`/clients`, async(req,res) =>{

    try{
        const[rows] = await db.promise().query(
            "SELECT id, customer_name FROM newclient ORDER BY customer_name ASC" 
         );
         res.json(rows);
    }catch(error){
        res.status(500).json({message: error.message});
    }
});

// Get all Clients Search;

router.get("/clients/search", async(req, res) => {
    const {q} = req.query;
    const searchTerm = `%${q || ""}%`;
    try{
      const [rows] = await db.promise().query(
        "SELECT id, customer_name, state, gst_number FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
        [searchTerm]
      );
      res.json(rows);
    } catch(error){
        console.error("Error searching clients:", error);
        res.status(500).json({message: "Client search failed"});
    }
});

//  search Items By Name

router.get("/items/search", async(req,res) => {
    const {q, type} = req.query;
    let query = "";
    let values = [`%${q || ""}%`];

    if(type === "service"){
       query = "SELECT service_name AS item_name, hsn_number FROM servicesdata  WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20 ";
    }
    else if(type === "spare"){
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else if(type === "purchase_item"){
        query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else{
        return res.status(400).json({message: "Invalid Item Type"});
    }
    try{
        const [rows] = await db.promise().query(
          query,
          [...values, ...values]
        )
        res.json(rows);
    }catch(error){
        console.error("Error Searching Items:", error);
        res.status(500).json({message: "Item Search Failed"});
    }
});


// Get items by type

router.get("/items/:type", async(req,res) =>{
    const {type} = req.params;
    let query = "SELECT * FROM items WHERE type = ?";

    if(type === "service"){
        query = "SELECT service_name AS item_name, hsn_number FROM servicesdata";
    }
    else if(type === "spare"){
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata";
    }
    else if(type == "purchase_item"){
        query = "SELECT item_name, hsn_number FROM purchaseitems";
    }
    else{
        return res.status(400).json({message: "Invalid item type"});
    }
    try{
        let rows;
        if(type === "service" || type === "spare" || type === "purchase_item"){
            [rows] = await db.promise().query(query);
        }else{
            [rows] = await db.promise().query(query, [type]);
        }
        res.json(rows);
    }catch(error){
        console.error("Error Fetching Items:", error);
        res.status(500).json({message: "Internal Server Error"});
    }

});

//  search Items By Name

router.get("/items/search", async(req,res) => {
    const {q, type} = req.query;
    let query = "";
    let values = [`%${q || ""}%`];

    if(type === "service"){
       query = "SELECT service_name AS item_name, hsn_number FROM servicesdata  WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20 ";
    }
    else if(type === "spare"){
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else if(type === "purchase_item"){
        query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20";
    }
    else{
        return res.status(400).json({message: "Invalid Item Type"});
    }
    try{
        const [rows] = await db.promise().query(
          query,
          [...values, ...values]
        )
        res.json(rows);
    }catch(error){
        console.error("Error Searching Items:", error);
        res.status(500).json({message: "Item Search Failed"});
    }
});

// Creat New Purchase_entry

router.post("/new", async(req,res) =>{
   try{
    const {supplier_name, bill_no, bill_date, order_no, order_date, other_name , despatch, due_date, order_type, discount, other_charges,subtotal, cgst, sgst, igst, round_off, grand_total, items} = req.body;
     const billNumber = await generateBillNo();
     const [result] = await db.promise().query(
        "INSERT INTO purchase_entry (supplier_name, bill_no, bill_date, order_no, order_date, other_name, despatch, due_date, order_type, discount, other_charges, subtotal, cgst, sgst, igst, round_off, grand_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [supplier_name, bill_no, bill_date, order_no, order_date, other_name,  despatch, due_date, order_type, discount, other_charges, subtotal, cgst, sgst, igst, round_off, grand_total]
    );
    const purchaseId = result.insertId;

    // insert items
    for(const item of items){
        const amount = item.price * item.quantity;
        await db.promise().query(
            "INSERT INTO purchase_entry_items (purchase_id, item_name, price, quantity, hsn, uom, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [purchaseId, item.item_name, item.price, item.quantity, item.hsn, item.uom, amount, item.serial_no || null]
        );
    }
    res.status(201).json({message: "Purchase Entry Created Successfully", bill_no: billNumber});
    }catch(error){
    console.error("Error Creating Purchase Entry:", error);
    res.status(500).json({message: "Internal Server Error"})
     }
   });

// Update Purchase Entry

router.put("/update/:billNo", async(req, res) => {
    try{
        const {billNo} = req.params;
        const {supplier_name, bill_no, bill_date, order_no, order_date, despatch, due_date, order_type, discount, other_charges, subtotal, cgst, sgst, igst, round_off, grand_total, items} = req.body;

        // Get the purchase entry ID
        const [purchaseRows] = await db.promise().query(
            "SELECT id FROM purchase_entry WHERE bill_no = ?",
            [billNo]
        );
        const purchaseId = purchaseRows[0].id;

        // Update the main purchase entry
        await db.promise().query(
            "UPDATE purchase_entry SET supplier_name=?, bill_no=?, bill_date=?, order_no=?, order_date=?, despatch=?, due_date=?, order_type=?, discount=?, other_charges=?, subtotal=?, cgst=?, sgst=?, igst=?, round_off=?, grand_total=? WHERE id=?",
            [supplier_name, bill_no, bill_date, order_no, order_date, despatch, due_date, order_type, discount, other_charges, subtotal, cgst, sgst, igst, round_off, grand_total, purchaseId]
        );

        // Delete existing items
        await db.promise().query(
            "DELETE FROM purchase_entry_items WHERE purchase_id=?",
            [purchaseId]
        );

        // Insert updated items
        for(const item of items){
            const amount = item.price * item.quantity;
            await db.promise().query(
                "INSERT INTO purchase_entry_items (purchase_id, item_name, price, quantity, hsn, uom, amount, serial_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [purchaseId, item.item_name, item.price, item.quantity, item.hsn, item.uom, amount, item.serial_no || null]
            );
        }
        res.json({message: "Purchase Entry Updated Successfully"});
    }catch(error){
        console.error("Error Updating Purchase Entry:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});


// Delete  bill no

router.delete("/delete/:billNo", async(req, res) => {
    try{
        const {billNo} = req.params;

        // Get the purchase entry ID
        const [purchaseRows] = await db.promise().query(
            "SELECT id FROM purchase_entry WHERE bill_no = ?",
            [billNo]
        );
        const purchaseId = purchaseRows[0].id;

        // Delete items
        await db.promise().query(
            "DELETE FROM purchase_entry_items WHERE purchase_id = ?",
            [purchaseId]
        );

        // Delete the main entry
        await db.promise().query(
            "DELETE FROM purchase_entry WHERE id = ?",
            [purchaseId]
        );

        res.json({message: "Bill Deleted Successfully"});
    }catch(error){
        console.error("Error Deleting Bill:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Suppliers list for filter dropdown
router.get("/suppliers", async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            "SELECT DISTINCT supplier_name FROM purchase_entry ORDER BY supplier_name ASC"
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching suppliers:", error);
        res.status(500).json({ message: error.message });
    }
});

// Purchase View Report — product-wise rows
router.get("/view-report", async (req, res) => {
    try {
        const { fromDate, toDate, supplier_name, bill_no, item_name } = req.query;

        let query = `
            SELECT
                pe.bill_no, pe.bill_date, pe.supplier_name,
                pei.item_name, NULL AS serial_number,
                pei.hsn AS hsn_number,
                pei.quantity, pei.price,
                (pei.quantity * pei.price) AS amount
            FROM purchase_entry pe
            JOIN purchase_entry_items pei ON pe.id = pei.purchase_id
            WHERE 1=1
        `;
        const values = [];

        if (fromDate && toDate) { query += " AND pe.bill_date BETWEEN ? AND ?"; values.push(fromDate, toDate); }
        if (supplier_name) { query += " AND pe.supplier_name = ?"; values.push(supplier_name); }
        if (bill_no) { query += " AND pe.bill_no = ?"; values.push(bill_no); }
        if (item_name) { query += " AND pei.item_name LIKE ?"; values.push(`%${item_name}%`); }

        query += " ORDER BY pe.bill_date ASC, pe.bill_no ASC";

        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    } catch (error) {
        console.error("Purchase View Report Error:", error);
        res.status(500).json({ message: "Purchase View Report Failed" });
    }
});

// Report Genration
router.get("/report", async(req, res) => {
    try{
        const {fromdate, todate, billno, suppliername} = req.query;

        let query = `
        SELECT 
         pe.bill_no,
         pe.bill_date,
         pe.order_no,
         pe.supplier_name,
         pe.subtotal,
         pe.cgst,
         pe.sgst,
         pe.other_charges,
         pe.discount,
         pe.grand_total,
         pei.item_name,
         pei.quantity,
         pei.price,
         pei.uom,
         pei.hsn
        FROM purchase_entry pe
        LEFT JOIN purchase_entry_items pei ON pe.id = pei.purchase_id
        WHERE 1=1
        `;
        let values = [];

        if(fromdate && todate){
            query += " AND pe.bill_date BETWEEN ? AND ?";
            values.push(fromdate, todate);
        }
        if(billno){
            query += " AND pe.bill_no = ?";
            values.push(billno);
        }
        if(suppliername){
            query += " AND pe.supplier_name = ?";
            values.push(suppliername);
        }
        const [rows] = await db.promise().query(query, values);
        res.json(rows);
    }catch(error){
        console.error("Report Error:", error);
        res.status(500).json({message: "Report Failed"});
    }
});


// GET SINGLE BILL (FOR EDIT AUTO-FILL)
router.get("/:billno", async (req, res) => {
  try {
    const { billno } = req.params;

    // Get main purchase entry
    const [rows] = await db.promise().query(
      "SELECT * FROM purchase_entry WHERE bill_no = ?",
      [billno]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Bill not found" });
    }

    const purchase = rows[0];

    // Get items
    const [items] = await db.promise().query(
      "SELECT item_name, price, quantity, hsn, uom, serial_no FROM purchase_entry_items WHERE purchase_id = ?",
      [purchase.id]
    );

    res.json({
      ...purchase,
      items
    });

  } catch (error) {
    console.error("Error fetching bill:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Supplier Search
router.get("/supplier/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;

  try {
    const [rows] = await db.promise().query(
      "SELECT DISTINCT supplier_name FROM purchase_entry WHERE supplier_name LIKE ?",
      [searchTerm]
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching suppliers:", err);
    res.status(500).json({ message: "Supplier fetch failed" });
  }
});


module.exports = router;
