const express = require('express');
const router = express.Router();
const db = require('../config/database');

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 5;
const ALLOWED_MIMETYPES = [
  "application/pdf",
  "image/jpeg", "image/png", "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain"
];

function parseDocuments(docs) {
  if (!docs) return [];
  if (typeof docs === 'string') {
    try { return JSON.parse(docs); } catch { return []; }
  }
  if (Array.isArray(docs)) return docs;
  return [];
}

async function generateEmployeeId() {
  const [rows] = await db.promise().query(
    "SELECT id FROM employeedata ORDER BY id DESC LIMIT 1"
  );
  const nextId = (rows[0]?.id || 0) + 1;
  return `EMP-${String(nextId).padStart(3, "0")}`;
}

function validateDocuments(docs) {
  if (!Array.isArray(docs)) return [];
  if (docs.length > MAX_FILES) {
    throw new Error(`Too many files. Maximum is ${MAX_FILES}.`);
  }
  for (const d of docs) {
    if (!d || typeof d !== 'object') {
      throw new Error('Invalid document format');
    }
    if (!d.name || !d.mime || !d.data) {
      throw new Error('Each document must have name, mime, and data');
    }
    if (!ALLOWED_MIMETYPES.includes(d.mime)) {
      throw new Error(`File type ${d.mime} is not allowed`);
    }
    const approxSize = (d.data.length * 3) / 4;
    if (approxSize > MAX_FILE_SIZE) {
      throw new Error(`File "${d.name}" exceeds 5MB limit`);
    }
  }
  return docs;
}

router.get('/next-id', async (req, res) => {
  try {
    const empId = await generateEmployeeId();
    res.json({ empId });
  } catch (err) {
    console.error("Generate ID error:", err);
    res.status(500).json({ message: "Failed to generate ID" });
  }
});

router.post('/new', async (req, res) => {
  console.log("BODY RECEIVED:", req.body);
  try {

    const body = req.body || {};

    const {
      employee_name,
      designation,
      department,
      contact,
      address,
      pincode,
      identification,
      pannumber,
      documents
    } = body;

    if (!req.body) {
      return res.status(400).json({
        message: "Request body is undefined"
      });
    }
    
    if (!employee_name || !designation || !department) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    const docs = validateDocuments(documents || []);
    const docsJson = docs.length > 0 ? JSON.stringify(docs) : null;

    const emp_id = await generateEmployeeId();

    const sql = `
      INSERT INTO employeedata
       (emp_id, employee_name, designation, department, contact, address, pincode, identification, pannumber, documents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await db.promise().query(sql, [
        emp_id, employee_name, designation, department,
        contact || null, address || null, pincode || null,
        identification || null, pannumber || null, docsJson
    ]);

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("POST /new error:", err);
    res.status(500).json({ message: err.message || "Internal server error" });
  }
});

router.get('/all', async (req, res) => {
  try {
    const [results] = await db.promise().query(
      `SELECT id, emp_id, employee_name, designation, department, contact, address, pincode, identification, pannumber, documents, created_at FROM employeedata`
    );
    const employees = results.map(e => ({ ...e, documents: parseDocuments(e.documents) }));
    res.json({ success: true, employees });
  } catch (err) {
    console.error("DB ERROR:", err);
    res.status(500).json({ message: "Failed to fetch employees" });
  }
});

router.get("/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ success: true, employees: [] });

  const search = `%${q}%`;
  try {
    const [results] = await db.promise().query(
      `SELECT id, emp_id, employee_name, designation, department, contact, address, pincode, identification, pannumber, documents, created_at
       FROM employeedata
       WHERE employee_name LIKE ? OR designation LIKE ? OR department LIKE ?`,
      [search, search, search]
    );
    const employees = results.map(e => ({ ...e, documents: parseDocuments(e.documents) }));
    res.json({ success: true, employees });
  } catch (err) {
    console.error("DB ERROR:", err);
    res.status(500).json({ message: "Search failed" });
  }
});

router.put("/edit/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { emp_id, employee_name, designation, department, contact, address, pincode, identification, pannumber, documents } = req.body;

    if (!employee_name || !designation || !department) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    const docs = validateDocuments(documents || []);
    const docsJson = docs.length > 0 ? JSON.stringify(docs) : null;

    const sql = `
      UPDATE employeedata
      SET emp_id=?, employee_name=?, designation=?, department=?, contact=?, address=?, pincode=?, identification=?, pannumber=?, documents=?
      WHERE id=?
    `;
    await db.promise().query(sql, [
        emp_id || null, employee_name, designation, department,
        contact || null, address || null, pincode || null,
        identification || null, pannumber || null, docsJson, id
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /edit error:", err);
    res.status(500).json({ message: err.message || "Update failed" });
  }
});

router.delete("/:id/document/:index", async (req, res) => {
  try {
    const { id, index } = req.params;
    const [rows] = await db.promise().query(
      `SELECT documents FROM employeedata WHERE id = ?`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });

    const docs = parseDocuments(rows[0].documents);
    const idx = parseInt(index, 10);
    if (isNaN(idx) || idx < 0 || idx >= docs.length) {
      return res.status(400).json({ message: "Invalid document index" });
    }

    docs.splice(idx, 1);
    const newDocsJson = docs.length > 0 ? JSON.stringify(docs) : null;

    await db.promise().query(
      `UPDATE employeedata SET documents = ? WHERE id = ?`, [newDocsJson, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE document error:", err);
    res.status(500).json({ message: "Delete failed" });
  }
});

router.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.promise().query(
      `DELETE FROM employeedata WHERE id = ?`, [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Employee not found" });
    res.json({ success: true, message: "Employee deleted successfully" });
  } catch (err) {
    console.error("DB DELETE ERROR:", err);
    res.status(500).json({ message: "Failed to delete employee" });
  }
});

module.exports = router;