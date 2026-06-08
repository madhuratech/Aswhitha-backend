const express = require("express");
const router = express.Router();
const db = require("../config/database");
const axios = require("axios");
const ExcelJS = require("exceljs");

(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE debit_notes ADD COLUMN delivery_charge DECIMAL(10,2) DEFAULT 0"
    );
  } catch (e) {
    // Column already exists — ignore
  }
})();


// Auto Gentrate Dn Number function

async function generateDNNumber() {
  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM debit_notes"
  );

  const nextId = (rows[0].lastId || 0) + 1;
  const year = new Date().getFullYear();

  return `DN-${year}-${String(nextId).padStart(3, "0")}`;
}

// Get Debitnot number

router.get("/getdnnumber", async (req, res) => {
  try {
    const dnNumber = await generateDNNumber();
    res.json({ dnNumber });
  } catch (error) {
    console.error("Error generating DN number:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// get all clients search

router.get("/clients/search",async(req,res) =>{
    const { q } = req.query;
    const searchTerm = `%${q || ""}%`;
    try{
        const[rows] = await db.promise().query(
            "SELECT id, customer_name FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
            [searchTerm]
        );
        res.json(rows);
    }catch(error){
        console.log("Error fetching clients:", error);
        res.status(500).json({message: "Error fetching clients"});
    }
});

// Get All Clients

router.get("/clients", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT id, customer_name FROM newclient ORDER BY customer_name ASC"
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Search items by name (MUST be before /items/:type)

router.get("/items/search", async (req, res) => {
  const { q, type } = req.query;
  let query = "";
  let values = [`%${q || ""}%`];

  if (type === "service") {
    query = `SELECT service_name AS item_name, hsn_number FROM servicesdata WHERE service_name LIKE ? OR hsn_number LIKE ? LIMIT 20 `;
  }
  else if (type === "spare") {
    query = `SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ? OR hsn_number LIKE ? LIMIT 20`;
  }
  else if (type === "purchase_item") {
    query = `SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ? OR hsn_number LIKE ? LIMIT 20`;
  }
  else {
    return res.status(400).json({ message: "Invalid item type" });
  }
  try {
    const [rows] = await db.promise().query(query, [...values, ...values]);
    res.json(rows);
  } catch (error) {
    console.error("Error searching items:", error);
    res.status(500).json({ message: "Search failed" });
  }
});

// Get Item by Type
router.get("/items/type",async (req, res) => {
    const { type } = req.query;

    let query = "SELECT * FROM items WHERE type = ?";
    if (type === "service") {
        query = "SELECT service_name AS item_name, hsn_number FROM servicesdata";
    } else if (type === "spare") {
        query = "SELECT spare_name AS item_name, hsn_number FROM sparedata";
    } else if (type === "purchase_item") {
        query = "SELECT item_name, hsn_number FROM purchaseitems";
    } else {
        return res.status(400).json({ message: "Invalid item type" });
    }

    try {

        let rows;
        if (type === "service" || type === "spare" || type === "purchase_item") {
            [rows] = await db.promise().query(query);
        } else {
            [rows] = await db.promise().query(query, [type]);
        }
       
        res.json(rows);
    } catch (error) {
        console.error(`Error fetching ${type} items:`, error);
        res.status(500).json({ message: `${type} items fetch failed` });
    }
})

// Create new Dn order

router.post('/new',async(req,res)=>{
    try{
        const{dn_number, client_name, dn_date , bill_no , bill_date, order_type, remarks, subtotal, cgst, sgst, igst, grandTotal, delivery_charge, items}=req.body
        const dnNumber = await generateDNNumber();

        const[dnResult] = await db.promise().query(
            'INSERT INTO debit_notes(dn_number, client_name, dn_date, bill_no, bill_date, order_type, remarks, subtotal, cgst, sgst, igst, grandTotal, delivery_charge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [dnNumber, client_name, dn_date, bill_no, bill_date, order_type, remarks, subtotal, cgst, sgst, igst, grandTotal, delivery_charge || 0]
        );
        const dnID = dnResult.insertId;

        //Insert items into debitnote_items table

        for(const item of items){
            const amount = item.price * item.quantity;
            const net = amount -(item.discount || 0);

            await db.promise().query(
             `INSERT INTO debit_note_items(dn_id, item_name, hsn_code, quantity, price, amount, discount, part_no, unit, net_amount) 
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
             [dnID, item.item_name, item.hsn_code, item.quantity, item.price, amount, item.discount || 0, item.part_no, item.unit, net]            
  );
}
        res.status(201).json({message:'Debit note created successfully', dnNumber});
     
    } catch(error){
        console.log("Error Creating debitnote order", error);
        res.status(500).json({message:"Internal server error"});
    }
});

// Update a Purchase Orfder

router.put("/:dnNumber",async(req,res) => {
const {dnNumber} = req.params;
try{
  const{client_name, order_type, dn_date, items, subtotal, cgst, sgst, igst, roundOff, grandTotal, delivery_charge, remarks} = req.body;
   const[dnRows] = await db.promise().query(
      "SELECT * FROM debit_notes WHERE dn_number = ?",
      [dnNumber]
    );

    const dnID = dnRows[0].id;
   await db.promise().query(
  `UPDATE debit_notes 
   SET client_name=?, order_type=?, dn_date=?, subtotal=?, cgst=?, sgst=?, igst=?, roundOff=?, grandTotal=?, delivery_charge=?, remarks=? 
   WHERE id=?`,
  [client_name, order_type, dn_date, subtotal, cgst, sgst, igst, roundOff, grandTotal, delivery_charge || 0, remarks, dnID]
);

    // Delete existing items

    await db.promise().query("DELETE FROM debit_note_items WHERE dn_id = ?",[dnID]);
    
  //  Insert Updated Items;

   for(const item of items){
      const amount = item.price * item.quantity;
      const net = amount - (item.discount || 0);

      await db.promise().query(
        `INSERT INTO debit_note_items
        (dn_id, item_name, hsn_code, quantity, price, amount, discount, part_no, unit, net_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dnID, item.item_name, item.hsn_code, item.quantity, item.price, amount, item.discount || 0, item.part_no, item.unit, net]
      );
      
      res.status(500).json({message: "Internal Server Error"});
    }

} catch(error){
  console.log("error Updating purchase Order:", error);
  res.status(500).json({message: "Internal Server Error"});
}
});

// Delete Dn Number

router.delete(`/:dnNumber`, async(req, res) => {
  try{
    const {dnNumber} = req.params;
    const[dnRows] = await db.promise().query(
      "SELECT * FROM debit_notes WHERE dn_number = ?",
      [dnNumber]
    );
    const dnID = dnRows[0].id;

    await db.promise().query("DELETE FROM debit_note_items WHERE dn_id = ?", [dnID]);
    await db.promise().query("DELETE FROM debit_notes WHERE id = ?", [dnID]);

    res.json({message: "Deleted Successfully"});
  }catch(error){
    console.error('Error deleting debit note:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Dn Search
router.get(`/dn/search`, async(req, res) => {
  const {q} = req.query;
  const searchTerm = `%${q || ""}%`;
  try{
    const[rows] = await db.promise().query(
      "SELECT dn_number FROM debit_notes WHERE dn_number LIKE ? ORDER BY id DESC LIMIT 20",
      [searchTerm]
    );
    res.json(rows);
  }catch(error){
    console.log("Error Searching debitnotes", error);
    res.status(500).json({message: "Search Failed"});
  }
});

// Get All debitnotes

router.get("/full/:dnNumber", async(req,res) =>{
  const{dnNumber} = req.params;
  try{
    const[dnRows] = await db.promise().query(
      "SELECT * FROM debit_notes WHERE dn_number = ?",
      [dnNumber]
    );
    if(dnRows.length === 0){
      return res.status(400).json({message:"DN Not Found"});
    }
    const dnData = dnRows[0];
 
    //  Get items

    const[items] = await db.promise().query(
      "SELECT * FROM debit_note_items WHERE dn_id = ?",
      [dnData.id]
    );

    // Get Client by name 
    const [client] = await db.promise().query(
      "SELECT * FROM newclient WHERE customer_name = ?",
      [dnData.client_name]
    );

    res.json({
      ...dnData,items,client: client[0] || {}
    });

  }catch(error){
    console.log(error);
    res.status(500).json({message: "Server Error"});
  }
});


// Get Debit notes order by dn number

router.get(`/:dnNumber`, async(req,res) =>{
  const {dnNumber} = req.params;
  try{
    const[rows] = await db.promise().query(
      "SELECT * FROM debit_notes WHERE dn_number = ?",
      [dnNumber]
    );
    if(rows.length === 0){
      return res.status(404).json({message: "Debit Note not found"});
    }
    const[items] = await db.promise().query(
      "SELECT * FROM debit_note_items WHERE dn_id = ?",
      [rows[0].id]
    );
    res.json({...rows[0], items})
  }catch(error){
    console.log(error);
    res.status(500).json({message: "Internal server error"});
  }
});

// get filter data and all data show;
router.get("/report/filters", async (req, res) => {
  try{
    const{fromDate, toDate, dnNumber} = req.query;
    let query = `
    SELECT 
    dn.dn_number,
    dn.dn_date,
    dn.bill_date,
    dn.bill_no,
    dn.client_name,
    dn.subtotal,
    dn.cgst,
    dn.sgst,
    dn.igst,
    dn.grandTotal,
    dn.delivery_charge,
    dni.item_name,
    dni.quantity,
    dni.price,
    dni.discount
    FROM debit_notes dn
    LEFT JOIN debit_note_items dni ON dn.id = dni.dn_id
    WHERE 1=1
    `;
    let values = [];
    if (fromDate && toDate) {
    query += " AND dn.dn_date BETWEEN ? AND ?";
    values.push(fromDate, toDate);
   }

   if (dnNumber) {
    query += " AND dn.dn_number = ?";
    values.push(dnNumber);
   }
    const[rows] = await db.promise().query(query, values);
    res.json(rows);
  }catch(error){
    console.log("Report Error:",error);
    res.status(500).json({message:"Report Failed"});
  }
});

// Excel Download;

router.get("/report/excel",async(req,res) =>{
  try{
    const{fromDate, toDate, dnNumber} = req.query;
    let query = `SELECT 
    dn.dn_number,
    dn.dn_date,
    dn.bill_date,
    dn.bill_no,
    dn.client_name,
    dn.subtotal,
    dn.cgst,
    dn.sgst,
    dn.igst,
    dn.grandTotal,
    dn.delivery_charge,
    dni.item_name,
    dni.quantity,
    dni.price,
    dni.discount
    FROM debit_notes dn
    LEFT JOIN debit_note_items dni ON dn.id = dni.dn_id
    WHERE 1=1`;

    let values = [];
    if (fromDate && toDate) {
    query += " AND dn.dn_date BETWEEN ? AND ?";
    values.push(fromDate, toDate);
   }

  if (dnNumber) {
   query += " AND dn.dn_number = ?";
   values.push(dnNumber);
  }
   const [rows] = await db.promise().query(query , values); 
  
   const workbook = new ExcelJS.Workbook();
   const worksheet = workbook.addWorksheet("Debitnotes Report");

  //  Header Row;
  worksheet.columns = [
    {header: "SNO", key: "sno", width: 8},
    {header: "DN Number", key: "dn_number", width: 18},
    {header: "DN Date", key: "dn_date", width: 15},
    {header: "Bill No", key: "bill_no", width: 15},
    {header: "Bill Date", key: "bill_date", width: 15},
    {header: "Client Name", key: "client_name", width: 20},
    {header: "Subtotal", key: "subtotal", width: 15},
    {header: "CGST", key: "cgst", width: 15},
    {header: "SGST", key: "sgst", width: 15},
    {header: "IGST", key: "igst", width: 15},
    {header: "Delivery Charge", key: "delivery_charge", width: 15},
    {header: "Grand Total", key: "grandTotal", width: 15},
    {header: "Item Name", key: "item_name", width: 20},
    {header: "Quantity", key: "quantity", width: 15},
    {header: "Price", key: "price", width: 15},
    {header: "Discount", key: "discount", width: 15},
  ];
   
   rows.forEach((rows,index) => {
    worksheet.addRow({
      sno: index + 1,
      ...rows
    });
   });
    // Style header
    worksheet.getRow(1).font = { bold: true };

     //  Send file
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Purchase_Report.xlsx"
    );

     await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("Excel Export Error:", error);
    res.status(500).json({ message: "Excel export failed" });
  }
})

module.exports = router;