const express = require("express");
const router = express.Router();
const db = require("../config/database");

router.post("/new", (req, res) => {
  console.log("REQ BODY:", req.body); 

  const {
    customer_type,
    customer_name,
    phone,
    email,
    address,
    gst_number,
    state,
    pincode,
    contact_person, 
  } = req.body;

  if (!customer_type || !customer_name || !phone || !email || !address || !pincode || !contact_person) {
    return res.status(400).json({ message: "Required fields missing" });
  }

  const sql = `
    INSERT INTO newclient
    (customer_type, customer_name, phone, email, address, gst_number, state, pincode, contact_person)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    sql,
    [customer_type, customer_name, phone, email, address, gst_number, state, pincode, contact_person],
    (err, result) => {
      if (err) {
        console.error("DB ERROR:", err);
        return res.status(500).json({ message: "Insert failed" });
      }
      res.json({ success: true, id: result.insertId });
    }
  );
});

// Search 

router.get("/search", (req,res)=>{
  const {q} = req.query;
  if(!q){
    return res.json([]);
  }
  const search = `%${q}%`;

  const sql = `
   SELECT id, customer_name, phone, email, address, gst_number, state, pincode, contact_person FROM newclient
   WHERE customer_name Like ?
   OR phone Like ? OR gst_number Like ?
    ORDER BY customer_name ASC 
    LIMIT 20`;

    db.query(sql,[search,search,search],(err,results) =>{
      if(err){ 
        console.log("Search Error", err);
        return res.status(500).json({message: "Search Failed"});
      }
      res.json(results);
    });
});


// Get ALL customers
router.get("/all", (req, res) => {
  const sql = `
    SELECT 
      id,
      customer_type,
      customer_name,
      phone,
      email,
      address,
      gst_number,
      state,
      pincode,
      contact_person
    FROM newclient
    ORDER BY id DESC
  `;

  db.query(sql, (err, result) => {
    if (err) {
      console.error("Fetch Error:", err);
      return res.status(500).json({ message: "Fetch Failed" });
    }
    res.json(result);
  });
});


// Update 

router.put("/update/:id", (req,res) =>{
  const {id} = req.params;
  const { customer_name, phone, email, address, gst_number, state, pincode, contact_person } = req.body;

   const sql = `update newclient SET customer_name=?, phone=?, email=?, address=?, gst_number=?, state=?, pincode=?, contact_person=? WHERE id=?`;
   
   db.query(
    sql,
    [customer_name,phone,email,address,gst_number,state,pincode,contact_person,id],
    (err) =>{
      if(err){
        console.log(err);
        return res.status(500).json({message:"Update Failed"})
      }
      res.json({success:"True"});
    }
   );
  
  });

  // DELETE

  router.delete("/delete/:id", (req,res)=>{
    const {id} = req.params;
    db.query("DELETE FROM newclient WHERE id=?", [id], (err) =>{
      if(err){
        console.error(err);
        return res.status(500).json({message:"Delete Failed"});
      }
      res.json({success:true});
    });
  });

module.exports = router;
