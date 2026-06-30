const express = require("express");
const router = express.Router();
const db = require("../config/database");
const ExcelJS = require("exceljs");

(async () => {
  try {
    await db.promise().query(
      "ALTER TABLE credit_notes ADD COLUMN delivery_charge DECIMAL(10,2) DEFAULT 0"
    );
  } catch (e) {
    // Column already exists — ignore
  }
})();


// Auto Generate CN Number (plain 3-digit, starting from 015)
async function generateCNNumber(conn) {
  const runner = conn || db.promise();
  const [rows] = await runner.query("SELECT cn_number FROM credit_notes");
  let maxNo = 14;
  rows.forEach(({ cn_number }) => {
    const s = String(cn_number);
    const m = s.match(/^(\d+)$/) || s.match(/^CN-\d+-(\d+)$/i);
    if (m) { const n = parseInt(m[1], 10); if (n > maxNo) maxNo = n; }
  });
  return String(maxNo + 1).padStart(3, "0");
}

// Get Credit Note number

router.get("/getcnnumber", async (req, res) => {
  try {
    const cnNumber = await generateCNNumber();
    res.json({ cnNumber });
  } catch (error) {
    console.error("Error generating CN number:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// get all clients search

router.get("/clients/search",async(req,res) =>{
    const { q } = req.query;
    const searchTerm = `%${q || ""}%`;
    try{
        const[rows] = await db.promise().query(
            "SELECT id, customer_name, state, gst_number FROM newclient WHERE customer_name LIKE ? ORDER BY customer_name ASC LIMIT 20",
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
      "SELECT id, customer_name, state, gst_number FROM newclient ORDER BY customer_name ASC"
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

// Create new CN order

router.post('/new', async (req, res) => {
  const conn = await db.promise().getConnection();
  try {
    await conn.beginTransaction();

    const { client_name, cn_date, bill_number, bill_date, order_type, remarks, subtotal, cgst, sgst, igst, grandTotal, roundOff, delivery_charge, items } = req.body;

    // Atomically generate CN number
    const cnNumber = await generateCNNumber(conn);

    // Convert empty strings to NULL for date/string fields
    const parsedCnDate = cn_date === '' ? null : cn_date;
    const parsedBillDate = bill_date === '' ? null : bill_date;
    const parsedBillNumber = bill_number === '' ? null : bill_number;

    const grandTotalValue = grandTotal !== undefined ? grandTotal : req.body.grand_total;
    const remarksValue = remarks !== undefined ? remarks : req.body.narration;
    const roundOffValue = roundOff !== undefined ? roundOff : req.body.round_off;

    const [cnResult] = await conn.query(
      'INSERT INTO credit_notes(cn_number, client_name, cn_date, bill_number, bill_date, order_type, remarks, subtotal, cgst, sgst, igst, grandTotal, roundOff, delivery_charge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [cnNumber, client_name, parsedCnDate, parsedBillNumber, parsedBillDate, order_type, remarksValue, subtotal, cgst, sgst, igst, grandTotalValue, roundOffValue || 0, delivery_charge || 0]
    );
    const cnID = cnResult.insertId;

    for (const item of items) {
      const amount = item.price * item.quantity;
      const net = amount - (item.discount || 0);

      await conn.query(
        `INSERT INTO credit_note_items(cn_id, item_name, hsn_code, quantity, price, amount, discount, part_no, unit, net_amount) 
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cnID, item.item_name, item.hsn_code, item.quantity, item.price, amount, item.discount || 0, item.part_no, item.unit, net]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Credit note created successfully', cnNumber });
  } catch (error) {
    await conn.rollback();
    console.log("Error Creating creditnote order", error);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    conn.release();
  }
});

// Update a Credit Note

router.put("/:cnNumber",async(req,res) => {
    const {cnNumber} = req.params;
    try{
        const{client_name, order_type, cn_date, bill_number, bill_date, items, subtotal, cgst, sgst, igst, roundOff, grandTotal, delivery_charge, remarks}=req.body;
        
        // Convert empty strings to NULL for date/string fields
        const parsedCnDate = cn_date === '' ? null : cn_date;
        const parsedBillDate = bill_date === '' ? null : bill_date;
        const parsedBillNumber = bill_number === '' ? null : bill_number;

        // Fallbacks for frontend payload key discrepancies
        const grandTotalValue = grandTotal !== undefined ? grandTotal : req.body.grand_total;
        const remarksValue = remarks !== undefined ? remarks : req.body.narration;
        const roundOffValue = roundOff !== undefined ? roundOff : req.body.round_off;

        const[cnRows] = await db.promise().query(
            "SELECT * FROM credit_notes WHERE cn_number = ?",
            [cnNumber]
        );

        const cnID = cnRows[0].id;
        await db.promise().query(
            `UPDATE credit_notes
            SET client_name=?, order_type=?, cn_date=?, bill_number=?, bill_date=?, subtotal=?, cgst=?, sgst=?, igst=?, roundOff=?, grandTotal=?, delivery_charge=?, remarks=?
            WHERE id=?`,
            [client_name, order_type, parsedCnDate, parsedBillNumber, parsedBillDate, subtotal, cgst, sgst, igst, roundOffValue, grandTotalValue, delivery_charge || 0, remarksValue, cnID]
        );

        // Delete existing items

        await db.promise().query("DELETE FROM credit_note_items WHERE cn_id = ?",[cnID]);
        
        //  Insert Updated Items;

        for(const item of items){
            const amount = item.price * item.quantity;
            const net = amount - (item.discount || 0);

            await db.promise().query(
                `INSERT INTO credit_note_items
                (cn_id, item_name, hsn_code, quantity, price, amount, discount, part_no, unit, net_amount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [cnID, item.item_name, item.hsn_code, item.quantity, item.price, amount, item.discount || 0, item.part_no, item.unit, net]
            );
        }

        res.status(200).json({message: "Credit Note updated successfully"});

    } catch(error){
        console.log("error Updating Credit Note:", error);
        res.status(500).json({message: "Internal Server Error"});
    }
});

// Delete CN Number

router.delete(`/:cnNumber`, async(req, res) => {
  try{
    const {cnNumber} = req.params;
    const[cnRows] = await db.promise().query(
      "SELECT * FROM credit_notes WHERE cn_number = ?",
      [cnNumber]
    );
    const cnID = cnRows[0].id;

    await db.promise().query("DELETE FROM credit_note_items WHERE cn_id = ?", [cnID]);
    await db.promise().query("DELETE FROM credit_notes WHERE id = ?", [cnID]);

    res.json({message: "Deleted Successfully"});
  }catch(error){
    console.error('Error deleting credit note:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// CN Search
router.get(`/cn/search`, async(req, res) => {
  const {q} = req.query;
  const searchTerm = `%${q || ""}%`;
  try{
    const[rows] = await db.promise().query(
      "SELECT cn_number FROM credit_notes WHERE cn_number LIKE ? ORDER BY id DESC LIMIT 20",
      [searchTerm]
    );
    res.json(rows);
  }catch(error){
    console.log("Error Searching creditnotes", error);
    res.status(500).json({message: "Search Failed"});
  }
});

// Get All Credit Notes
router.get("/full/:cnNumber", async(req,res) =>{
  const{cnNumber} = req.params;
  try{
    const[cnRows] = await db.promise().query(
      "SELECT * FROM credit_notes WHERE cn_number = ?",
      [cnNumber]
    );
    if(cnRows.length === 0){
      return res.status(400).json({message:"CN Not Found"});
    }
    const cnData = cnRows[0];
  
    //  Get items

    const[items] = await db.promise().query(
      "SELECT * FROM credit_note_items WHERE cn_id = ?",
      [cnData.id]
    );

    // Get Client by name 

    const [client] = await db.promise().query(
      "SELECT * FROM newclient WHERE customer_name = ?",
      [cnData.client_name]
    );

    res.json({
      ...cnData,items,client: client[0] || {}
    });

  }catch(error){
    console.log(error);
    res.status(500).json({message: "Server Error"});
  }
});


// get filter data and all data show;
router.get("/report/filters", async (req, res) => {
  try{
    const{fromDate, toDate, cnNumber} = req.query;
    let query = `
    SELECT 
    cn.cn_number,
    cn.cn_date,
    cn.bill_date,
    cn.bill_number,
    cn.client_name,
    cn.subtotal,
    cn.cgst,
    cn.sgst,
    cn.igst,
    cn.grandTotal,
    cn.delivery_charge,
    cni.item_name,
    cni.quantity,
    cni.price,
    cni.discount
    FROM credit_notes cn
    LEFT JOIN credit_note_items cni ON cn.id = cni.cn_id
    WHERE 1=1
    `;
    let values = [];
    if (fromDate && toDate) {
    query += " AND cn.cn_date BETWEEN ? AND ?";
    values.push(fromDate, toDate);
   }

   if (cnNumber) {
    query += " AND cn.cn_number = ?";
    values.push(cnNumber);
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
    const{fromDate, toDate, cnNumber} = req.query;
    let query = `SELECT 
    cn.cn_number,
    cn.cn_date,
    cn.bill_date,
    cn.bill_number,
    cn.client_name,
    cn.subtotal,
    cn.cgst,
    cn.sgst,
    cn.igst,
    cn.grandTotal,
    cn.delivery_charge,
    cni.item_name,
    cni.quantity,
    cni.price,
    cni.discount
    FROM credit_notes cn
    LEFT JOIN credit_note_items cni ON cn.id = cni.cn_id
    WHERE 1=1`;

    let values = [];
    if (fromDate && toDate) {
    query += " AND cn.cn_date BETWEEN ? AND ?";
    values.push(fromDate, toDate);
   }

  if (cnNumber) {
   query += " AND cn.cn_number = ?";
   values.push(cnNumber);
  }
   const [rows] = await db.promise().query(query , values); 
  
   const workbook = new ExcelJS.Workbook();
   const worksheet = workbook.addWorksheet("Credit Notes Report");

  //  Header Row;
  worksheet.columns = [
    {header: "SNO", key: "sno", width: 8},
    {header: "CN Number", key: "cn_number", width: 18},
    {header: "CN Date", key: "cn_date", width: 15},
    {header: "Bill No", key: "bill_number", width: 15},
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
      "attachment; filename=Credit_Notes_Report.xlsx"
    );

     await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("Excel Export Error:", error);
    res.status(500).json({ message: "Excel export failed" });
  }
})

// Get Credit Note by cn number (MUST be last - catch-all param route)

router.get(`/:cnNumber`, async(req,res) =>{
  const {cnNumber} = req.params;
  try{
    const[rows] = await db.promise().query(
      "SELECT * FROM credit_notes WHERE cn_number = ?",
      [cnNumber]
    );
    if(rows.length === 0){
      return res.status(404).json({message: "Credit Note not found"});
    }
    const[items] = await db.promise().query(
      "SELECT * FROM credit_note_items WHERE cn_id = ?",
      [rows[0].id]
    );
    res.json({...rows[0], items})
  }catch(error){
    console.log(error);
    res.status(500).json({message: "Internal server error"});
  }
});

module.exports = router;