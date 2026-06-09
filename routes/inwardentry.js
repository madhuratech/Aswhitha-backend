const express = require("express");
const router = express.Router();
const db = require("../config/database");
const axios = require("axios");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");


router.get("/clients", async (req, res) => {

    try{
        const [rows] = await db.promise().query("SELECT id, customer_name FROM newclient ORDER BY customer_name ASC ");
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server Error" });
    }

});

// All Clients Search

router.get("/clients/search", async (req, res) => {
  const { q } = req.query;
  const searchTerm = `%${q || ""}%`;
   try{
    const [rows] = await db.promise().query(
        "SELECT id, customer_name FROM newclient WHERE customer_name LIKE  ? ORDER BY customer_name ASC LIMIT 20",
        [searchTerm]
    );
    res.json(rows);
   }catch(error){
    console.error(error);
    res.status(500).json({ message: "Server Error" });
   }
});

// Get All items
router.get("/items/:type", async (req, res) => {
 const { type } = req.params;
 let query = "";
 if(type === "service"){
    query = "SELECT service_name AS item_name, hsn_number FROM servicesdata";
 }
 else if(type === "spare"){
   query = "SELECT spare_name AS item_name, hsn_number FROM sparedata";
 }
 else if(type === "purchase_item"){
    query = "SELECT item_name, hsn_number FROM purchaseitems";
 }
 try{
    const [rows] = await db.promise().query(query);
    res.json(rows);
 }catch(error){
    console.error(error);
    res.status(500).json({ message: "Server Error" });
 }
});

// Get All items Search

router.get("/items/:search", async (req, res) => {
    const { search } = req.params;
    const { q } = req.query;
    const searchTerm = `%${q || ""}%`;
    let query = "";
    if(search === "service"){
       query = "SELECT service_name AS item_name, hsn_number FROM servicedata WHERE service_name LIKE ?";
    }
    else if(search === "spares"){
      query = "SELECT spare_name AS item_name, hsn_number FROM sparedata WHERE spare_name LIKE ?";
    }
    else if(search === "purchase_item"){
       query = "SELECT item_name, hsn_number FROM purchaseitems WHERE item_name LIKE ?";
    }
    try{
       const [rows] = await db.promise().query(query,[searchTerm]);
       res.json(rows);
    }catch(error){
       console.error(error);
       res.status(500).json({ message: "Server Error" });
    }
});

// Create Inward Entry

router.post("/new", async (req, res) => {
    try {
     const s = sanitizeBody(req.body);
     const items = Array.isArray(req.body.items) ? req.body.items : [];

     const [result] = await db.promise().query(
        "INSERT INTO inward_entry (supplier_name, sl_no, entry_date, dc_number, dc_date, transport, description_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [s.supplier_name, emptyToNull(s.sl_no), emptyToNull(s.entry_date), s.dc_number, emptyToNull(s.dc_date), emptyToNull(s.transport), emptyToNull(s.description_type)]
     );
     const newInwardEntryId = result.insertId;

    // Insert items into inward_items table
    for (const item of items) {
     await db.promise().query(
        "INSERT INTO inward_items (inward_id, item_name, hsn, quantity, unit, pcb_sl_no, problems, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [newInwardEntryId, emptyToNull(item.item_name), emptyToNull(item.hsn), toNum(item.quantity, null), emptyToNull(item.unit), emptyToNull(item.pcb_sl_no), item.problems || '', emptyToNull(item.remarks)]
     );
    }
    res.status(201).json({ message: "Inward Entry created successfully" });
} catch(error) {
    console.error("Error creating Inward Entry:", error);
    res.status(500).json({ message: "Internal Server Error" });
}
});


// Update Inward Entry

router.put("/update/:dc_number", async (req, res) => {
  try {
    const { dc_number } = req.params;
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const [rows] = await db.promise().query(
      "SELECT id FROM inward_entry WHERE dc_number = ?",
      [dc_number]
    );

    const inwardId = rows[0].id;

    await db.promise().query(
      `UPDATE inward_entry SET supplier_name=?, entry_date=?, dc_date=?, transport=?, description_type=? WHERE id=?`,
      [s.supplier_name, emptyToNull(s.entry_date), emptyToNull(s.dc_date), emptyToNull(s.transport), emptyToNull(s.description_type), inwardId]
    );

    await db.promise().query("DELETE FROM inward_items WHERE inward_id=?", [inwardId]);

    for (const item of items) {
      await db.promise().query(
        "INSERT INTO inward_items (inward_id, item_name, hsn, quantity, unit, pcb_sl_no, problems, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [inwardId, emptyToNull(item.item_name), emptyToNull(item.hsn), toNum(item.quantity, null), emptyToNull(item.unit), emptyToNull(item.pcb_sl_no), item.problems || '', emptyToNull(item.remarks)]
      );
    }

    res.json({ message: "Updated" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Update Failed" });
  }
});

// Get Next SL Number (auto-generate as SL-001, SL-002, ...)
router.get("/next-sl", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT MAX(CAST(SUBSTRING(sl_no, 4) AS UNSIGNED)) AS maxNum FROM inward_entry WHERE sl_no LIKE 'SL-%'"
    );
    const nextNum = (rows[0].maxNum || 0) + 1;
    res.json({ sl_no: "SL-" + String(nextNum).padStart(3, "0") });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Get Inward number search (supports supplier filter)
router.get("/IE/search", async (req, res) => {
  const { q, supplier } = req.query;
  const searchTerm = `%${q || ""}%`;
  let query = "SELECT dc_number FROM inward_entry WHERE dc_number LIKE ?";
  const params = [searchTerm];
  if (supplier) {
    query += " AND supplier_name = ?";
    params.push(supplier);
  }
  query += " ORDER BY id DESC LIMIT 20";
  try {
    const [rows] = await db.promise().query(query, params);
    res.json(rows);
  } catch (error) {
    console.log("Error Searching", error);
    res.status(500).json({ message: "Search Failed" });
  }
});

// Get EXisting inwardnumber to edit

router.get("/edit/:dc_number", async (req, res) => {
  try {
    const { dc_number } = req.params;

    const [rows] = await db.promise().query(
      "SELECT * FROM inward_entry WHERE dc_number = ?",
      [dc_number]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Not found" });
    }

    const entry = rows[0];

    const [items] = await db.promise().query(
      "SELECT * FROM inward_items WHERE inward_id = ?",
      [entry.id]
    );

    res.json({ header: entry, items });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error" });
  }
});


// delete
router.delete("/delete/:dc_number", async (req, res) => {
  try {
    const { dc_number } = req.params;

    const [rows] = await db.promise().query(
      "SELECT id FROM inward_entry WHERE dc_number=?",
      [dc_number]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Not found" });
    }

    const inwardId = rows[0].id;

    await db.promise().query(
      "DELETE FROM inward_items WHERE inward_id=?",
      [inwardId]
    );

    await db.promise().query(
      "DELETE FROM inward_entry WHERE id=?",
      [inwardId]
    );

    res.json({ message: "Deleted" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Delete Failed" });
  }
});
// Get All Inward Entries
router.get("/all", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT * FROM inward_entry ORDER BY id DESC"
    );
    for (const row of rows) {
      const [items] = await db.promise().query(
        "SELECT * FROM inward_items WHERE inward_id = ?",
        [row.id]
      );
      row.items = items;
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Distinct suppliers for dropdown
router.get("/report/suppliers", async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT DISTINCT supplier_name FROM inward_entry ORDER BY supplier_name ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Report with filters
router.get("/report/filters", async (req, res) => {
  const { fromDate, toDate, dcNumber, clientName } = req.query;
  let query = `
    SELECT ie.dc_number, ie.entry_date, ie.dc_date, ie.supplier_name AS client_name,
           ii.item_name, ii.quantity, ii.problems, ii.remarks
    FROM inward_entry ie
    LEFT JOIN inward_items ii ON ie.id = ii.inward_id
    WHERE 1=1
  `;
  const params = [];
  if (fromDate && toDate) {
    query += " AND ie.entry_date BETWEEN ? AND ?";
    params.push(fromDate, toDate);
  }
  if (dcNumber) {
    query += " AND ie.dc_number = ?";
    params.push(dcNumber);
  }
  if (clientName) {
    query += " AND ie.supplier_name LIKE ?";
    params.push(`%${clientName}%`);
  }
  query += " ORDER BY ie.id DESC";
  try {
    const [rows] = await db.promise().query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;