const express = require ("express");
const router = express.Router();
const db = require("../config/database");   

router.post("/new",(req,res)=> {
    console.log(req.body);
    const{component_name, quantity}=req.body;
   
    if(!component_name || !quantity){
        return res.status(400).json({error:"All fields are required"});
    }      
   const sql = `INSERT INTO componentdata(component_name,quantity) VALUES(?,?)`;
   db.query(sql,[component_name, quantity], 
    (err, result)=>{
    if(err){
        console.error("DB error:", err);
        return res.status(500).json({error:"Insertion failed"});
    }
    res.json({success:true , id:result.insertId});
   });
});

// Get All 

router.get("/all", (req, res)=>{
    const sql ="SELECT * FROM componentdata";
    db.query(sql, (err, results)=>{
        if(err){
            console.error("DB error:", err);
            return res.status(500).json({error:"Failed to fetch data"});
        }
        res.json(results);
    });
}); 

// Update ;

router.put("/updateqty/:id", (req, res)=>{

 const {id} = req.params;
 const {quantity} = req.body;

 const sql = "UPDATE componentdata SET quantity=? WHERE id=?";

 db.query(sql,[quantity, id], (err)=>{

  if(err){
   console.error("DB ERROR:", err);
   return res.status(500).json({message:"Update failed"});
  }

  res.json({success:true});

 });

});

//search;
router.get("/search/:componentname", (req, res) => {

  const { componentname } = req.params;

  const sql = "SELECT * FROM componentdata WHERE component_name LIKE ?";

  db.query(sql, [`%${componentname}%`], (err, results) => {

    if (err) {
      console.error("DB error:", err);
      return res.status(500).json({ message: "Search failed" });
    }

    res.json(results);

  });

});


module.exports = router;

