const express = require('express');
const router = express.Router();
const db = require('../config/database');
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/new',upload.single('doucment'), (req, res) => {
    console.log("REQ BODY:", req.body);
    
    const {employee_name, designation,department,contact,address,pincode,identification,pannumber} 
    = req.body;

    if (!req.file) {
   return res.status(400).json({ message: "File not uploaded" });
    }
    const doucment = req.file.buffer;


    if (!employee_name || !designation || !department || !contact || !address || !pincode || !identification || !pannumber || !doucment) {
        return res.status(400).json({ message: "Required fields missing" });
    }

    const sql = `
      INSERT INTO employeedata
       (employee_name, designation, department, contact, address, pincode, identification,pannumber, doucment)
      VALUES (?,  ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.query(sql, [employee_name, designation, department, contact, address, pincode, identification, pannumber, doucment], (err, result) => {
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Insert failed" });
        }
        res.json({ success: true, id: result.insertId });;
    });
});

// Get all employees

 router.get('/all', (req, res) => {
  
    const sql = "SELECT * FROM employeedata";
    db.query(sql, (err, results) => {
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Failed to fetch employees" });
        }
        res.json({ success: true, employees: results });
    });

 });

// Search employees

router.get("/search", (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.json({ success: true, employees: [] });
  }

  const search = `%${q}%`;

  const sql = `
    SELECT * FROM employeedata
    WHERE employee_name LIKE ? 
       OR designation LIKE ? 
       OR department LIKE ?
  `;

  db.query(sql, [search, search, search], (err, results) => {
    if (err) {
      console.error("DB ERROR:", err);
      return res.status(500).json({ message: "Search failed" });
    }

    res.json({ success: true, employees: results });
  });
});

//Edit employee data

router.put("/edit/:id", upload.single('doucment'), (req, res) => {
    const {id} = req.params;
    const {employee_name, designation, department, contact, address, pincode, identification, pannumber} = req.body;
    
    let sql;
    let params;

    if (req.file) {
        const doucment = req.file.buffer;
        sql = `
        UPDATE employeedata
        SET employee_name=?, designation=?, department=?, contact=?, address=?, pincode=?, identification=?, pannumber=?, doucment=?
        WHERE id=?
        `;
        params = [employee_name, designation, department, contact, address, pincode, identification, pannumber, doucment, id];
    } else {
        sql = `
        UPDATE employeedata
        SET employee_name=?, designation=?, department=?, contact=?, address=?, pincode=?, identification=?, pannumber=?
        WHERE id=?
        `;
        params = [employee_name, designation, department, contact, address, pincode, identification, pannumber, id];
    }

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ message: "Update failed" });
        }
        res.json({success: true});
    });
});

module.exports = router;