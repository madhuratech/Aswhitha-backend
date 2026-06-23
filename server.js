require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./config/database");

// Migrate phone column to VARCHAR(100) for alphanumeric phone numbers
db.promise().query(
  "ALTER TABLE newclient MODIFY COLUMN phone VARCHAR(100) NULL"
).catch(() => {});

// Add employee_name to expenses if not already present
db.promise().query(
  "ALTER TABLE expenses ADD COLUMN employee_name VARCHAR(255) DEFAULT NULL"
).catch(() => {});

// Add employee_id FK to expenses for proper join-based lookup
db.promise().query(
  "ALTER TABLE expenses ADD COLUMN employee_id INT DEFAULT NULL"
).catch(() => {});

// Add client_dc_no column if not already present
db.promise().query(
  "ALTER TABLE service_invoices ADD COLUMN client_dc_no VARCHAR(100) DEFAULT ''"
).catch(() => {});

// Add remarks column to sales_dc_items if not already present
db.promise().query(
  "ALTER TABLE sales_dc_items ADD COLUMN remarks VARCHAR(100) DEFAULT NULL"
).catch(() => {});

// Add price column to service_dc_items if not already present
db.promise().query(
  "ALTER TABLE service_dc_items ADD COLUMN price DECIMAL(10,2) DEFAULT 0.00"
).catch(() => {});

db.promise().query(
  "ALTER TABLE salesinvoice MODIFY COLUMN dc_date VARCHAR(255) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE service_invoices MODIFY COLUMN dc_date VARCHAR(255) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE directinvoice MODIFY COLUMN dc_date VARCHAR(255) NULL"
).catch(() => {});

// Convert order_date columns from DATE to VARCHAR(500) for multi-date support
db.promise().query(
  "ALTER TABLE salesinvoice MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE service_invoices MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE directinvoice MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE salesinvoice_items MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE service_invoice_items MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE invoice_items MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE sales_dc_entries MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE sales_dc_items MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE standby_dc_entries MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE job_dc_entries MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE job_dc_items MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE purchase_entry MODIFY COLUMN order_date VARCHAR(500) NULL"
).catch(() => {});
// Service DC uses party_dc_date instead of order_date
db.promise().query(
  "ALTER TABLE service_dc_items MODIFY COLUMN party_dc_date VARCHAR(500) NULL"
).catch(() => {});
db.promise().query(
  "ALTER TABLE service_dc_entries MODIFY COLUMN party_dc_date VARCHAR(500) NULL"
).catch(() => {});

// Convert inward_entry.dc_date from DATE to VARCHAR(500) for multi-date support
db.promise().query(
  "ALTER TABLE inward_entry MODIFY COLUMN dc_date VARCHAR(500) NULL"
).catch(() => {});

// Add dc_no and dc_date columns to salesinvoice_items and service_invoice_items
db.promise().query(
  "ALTER TABLE salesinvoice_items ADD COLUMN dc_no VARCHAR(100) DEFAULT ''"
).catch(() => {});
db.promise().query(
  "ALTER TABLE salesinvoice_items ADD COLUMN dc_date VARCHAR(100) DEFAULT ''"
).catch(() => {});
db.promise().query(
  "ALTER TABLE service_invoice_items ADD COLUMN dc_no VARCHAR(100) DEFAULT ''"
).catch(() => {});
db.promise().query(
  "ALTER TABLE service_invoice_items ADD COLUMN dc_date VARCHAR(100) DEFAULT ''"
).catch(() => {});

// Legacy data migration for AT0916
db.promise().query(
  "UPDATE salesinvoice_items SET dc_no = '1189', dc_date = '2026-06-15' WHERE invoice_id = 12 AND order_no = 'GG 006'"
).catch(() => {});
db.promise().query(
  "UPDATE salesinvoice_items SET dc_no = '1190', dc_date = '2026-06-15' WHERE invoice_id = 12 AND order_no = 'G 007'"
).catch(() => {});
db.promise().query(
  "UPDATE salesinvoice SET dc_no = '1189, 1190' WHERE id = 12"
).catch(() => {});

// -- Order Status Tracking Table ----------------------------------------------
(async () => {
  try {
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS order_status (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        order_no VARCHAR(100) NOT NULL,
        dc_type VARCHAR(50) NOT NULL DEFAULT 'Service',
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_order (customer_name, order_no, dc_type)
      )`
    );

    // Seed: mark all existing inward_entry dc_numbers as Pending (if not tracked)
    await db.promise().query(
      `INSERT IGNORE INTO order_status (customer_name, order_no, dc_type, status)
      SELECT supplier_name, dc_number, 'Service', 'Pending'
      FROM inward_entry
      WHERE dc_number IS NOT NULL AND dc_number != ''`
    );

    // Seed: mark all existing Service DC order numbers as Completed
    const [dcRows] = await db.promise().query(
      "SELECT supplier_name, party_dc_no FROM service_dc_entries WHERE party_dc_no IS NOT NULL AND party_dc_no != ''"
    );
    for (const row of dcRows) {
      const orderNos = (row.party_dc_no || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const orderNo of orderNos) {
        await db.promise().query(
          `INSERT INTO order_status (customer_name, order_no, dc_type, status)
           VALUES (?, ?, 'Service', 'Completed')
           ON DUPLICATE KEY UPDATE status = 'Completed'`,
          [row.supplier_name, orderNo]
        );
      }
    }
  } catch (e) {
    console.error("order_status migration error:", e.message);
  }
})();

// -- DC Status Tracking Table --------------------------------------------------
(async () => {
  try {
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS dc_status (
        id INT AUTO_INCREMENT PRIMARY KEY,
        dc_number VARCHAR(255) NOT NULL,
        dc_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',
        invoice_type VARCHAR(50) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_dc (dc_number, dc_type)
      )`
    );

    // Seed all existing Sales DC numbers as Pending
    await db.promise().query(
      `INSERT IGNORE INTO dc_status (dc_number, dc_type, status)
      SELECT dc_no, 'SalesDC', 'Pending'
      FROM sales_dc_entries
      WHERE dc_no IS NOT NULL AND dc_no != ''`
    );

    // Seed all existing Service DC numbers as Pending
    await db.promise().query(
      `INSERT IGNORE INTO dc_status (dc_number, dc_type, status)
      SELECT inward_dc_no, 'ServiceDC', 'Pending'
      FROM service_dc_entries
      WHERE inward_dc_no IS NOT NULL AND inward_dc_no != ''`
    );

    // Seed: mark DCs already used in Sales Invoices as Completed
    const [salesInvDcs] = await db.promise().query(
      "SELECT dc_no FROM salesinvoice WHERE dc_no IS NOT NULL AND dc_no != ''"
    );
    for (const row of salesInvDcs) {
      const dcNos = (row.dc_no || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const dcNo of dcNos) {
        await db.promise().query(
          `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
           VALUES (?, 'SalesDC', 'Completed', 'SalesInvoice')
           ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'SalesInvoice'`,
          [dcNo]
        );
      }
    }

    // Seed: mark DCs already used in Service Invoices as Completed
    const [svcInvDcs] = await db.promise().query(
      "SELECT dc_no FROM service_invoices WHERE dc_no IS NOT NULL AND dc_no != ''"
    );
    for (const row of svcInvDcs) {
      const dcNos = (row.dc_no || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const dcNo of dcNos) {
        await db.promise().query(
          `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
           VALUES (?, 'ServiceDC', 'Completed', 'ServiceInvoice')
           ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'ServiceInvoice'`,
          [dcNo]
        );
      }
    }

    // Seed: mark DCs already used in Direct Invoices as Completed
    const [dirInvDcs] = await db.promise().query(
      "SELECT dc_no FROM directinvoice WHERE dc_no IS NOT NULL AND dc_no != ''"
    );
    for (const row of dirInvDcs) {
      const dcNos = (row.dc_no || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const dcNo of dcNos) {
        await db.promise().query(
          `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
           VALUES (?, 'DirectDC', 'Completed', 'DirectInvoice')
           ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'DirectInvoice'`,
          [dcNo]
        );
      }
    }
  } catch (e) {
    console.error("dc_status migration error:", e.message);
  }
})();

// -- Performance Invoice Tables -----------------------------------------------
(async () => {
  try {
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS performance_invoice_header (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(255),
        invoice_no VARCHAR(100) UNIQUE,
        invoice_date VARCHAR(255),
        dc_no VARCHAR(500),
        dc_date VARCHAR(500),
        order_no VARCHAR(500),
        order_date VARCHAR(500),
        payment_terms VARCHAR(255),
        dispatch_through VARCHAR(255),
        discount DECIMAL(10,2) DEFAULT 0,
        transport DECIMAL(10,2) DEFAULT 0,
        subtotal DECIMAL(10,2) DEFAULT 0,
        ordertype VARCHAR(50),
        cgst DECIMAL(10,2) DEFAULT 0,
        sgst DECIMAL(10,2) DEFAULT 0,
        igst DECIMAL(10,2) DEFAULT 0,
        round_off DECIMAL(10,2) DEFAULT 0,
        grandtotal DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    );
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS performance_invoice_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id INT,
        item_name VARCHAR(255),
        serial_no VARCHAR(255),
        quantity DECIMAL(10,2),
        price DECIMAL(10,2),
        uom VARCHAR(50),
        hsn_number VARCHAR(50),
        amount DECIMAL(10,2),
        FOREIGN KEY (invoice_id) REFERENCES performance_invoice_header(id) ON DELETE CASCADE
      )`
    );
    console.log("Performance Invoice tables ready");
  } catch (e) {
    console.error("Performance Invoice table migration error:", e.message);
  }
})();

// -- Performance Invoice 2 Tables ---------------------------------------------
(async () => {
  try {
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS performance_invoice2_header (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(255),
        invoice_no VARCHAR(100) UNIQUE,
        invoice_date VARCHAR(255),
        dc_no VARCHAR(500),
        dc_date VARCHAR(500),
        order_no VARCHAR(500),
        order_date VARCHAR(500),
        payment_terms VARCHAR(255),
        dispatch_through VARCHAR(255),
        discount DECIMAL(10,2) DEFAULT 0,
        transport DECIMAL(10,2) DEFAULT 0,
        subtotal DECIMAL(10,2) DEFAULT 0,
        ordertype VARCHAR(50),
        cgst DECIMAL(10,2) DEFAULT 0,
        sgst DECIMAL(10,2) DEFAULT 0,
        igst DECIMAL(10,2) DEFAULT 0,
        round_off DECIMAL(10,2) DEFAULT 0,
        grandtotal DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    );
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS performance_invoice2_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        invoice_id INT,
        item_name VARCHAR(255),
        serial_no VARCHAR(255),
        quantity DECIMAL(10,2),
        price DECIMAL(10,2),
        uom VARCHAR(50),
        hsn_number VARCHAR(50),
        amount DECIMAL(10,2),
        FOREIGN KEY (invoice_id) REFERENCES performance_invoice2_header(id) ON DELETE CASCADE
      )`
    );
    console.log("Performance Invoice 2 tables ready");
  } catch (e) {
    console.error("Performance Invoice 2 table migration error:", e.message);
  }
})();

// -- DC Running Number Counter ------------------------------------------------
(async () => {
  try {
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS dc_running_number (
        id INT PRIMARY KEY DEFAULT 1,
        current_number INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    );
    const [rows] = await db.promise().query("SELECT COUNT(*) AS cnt FROM dc_running_number");
    if (rows[0].cnt === 0) {
      const [salesRows] = await db.promise().query("SELECT dc_no FROM sales_dc_entries");
      const [serviceRows] = await db.promise().query("SELECT inward_dc_no AS dc_no FROM service_dc_entries");
      const extractNum = (str) => {
        if (!str) return 0;
        const m = String(str).match(/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : 0;
      };
      let maxNo = 1190;
      [...salesRows, ...serviceRows].forEach(r => { maxNo = Math.max(maxNo, extractNum(r.dc_no)); });
      await db.promise().query(
        "INSERT INTO dc_running_number (id, current_number) VALUES (1, ?)",
        [maxNo + 1]
      );
      console.log(`dc_running_number seeded with current_number = ${maxNo + 1}`);
    }
  } catch (e) {
    console.error("dc_running_number migration error:", e.message);
  }
})();

const app = express();

app.use(cors());

app.use(express.json({limit: "200mb"}));

app.use(express.urlencoded({extended: true, limit: "200mb"}));

app.use("/api/customers", require("./routes/ClientRoutes"));
app.use("/api/employees", require("./routes/employeedata"));
app.use("/api/Sparemodels", require("./routes/sparemodel"));
app.use("/api/Services", require("./routes/services"));
app.use("/api/expenses", require("./routes/expensedata"));
app.use("/api/purchaseitems", require("./routes/purchase"));
app.use("/api/purchaseorders", require("./routes/purchaseorder"));
app.use("/api/debitnotes", require("./routes/debitnote"));
app.use("/api/suppliers", require("./routes/supplier"));
app.use("/api/taxpurchases", require("./routes/taxpurchase"));
app.use("/api/billpayment", require("./routes/billwisepayment"));
app.use("/api/quotations", require("./routes/quotation"));
app.use("/api/directinvoices", require("./routes/directinvoice"));
app.use("/api/performanceinvoices2", require("./routes/performanceinvoice2"));
app.use("/api/salesinvoices", require("./routes/salesinvoice"));
app.use("/api/salesdc", require("./routes/salesdc"));
app.use("/api/Inwardentries", require("./routes/inwardentry"));
app.use("/api/servicedcentry", require("./routes/dcEntry"));
app.use("/api/serviceinvoice", require("./routes/serviceinvoic"));
app.use("/api/receipts", require("./routes/receipt"));
app.use("/api/pendings", require("./routes/pending"));
app.use("/api/creditnotes", require("./routes/creditnote"));
app.use("/api/pcb-stock", require("./routes/pcbstock"));
app.use("/api/standby-pcb", require("./routes/standbypcb"));
app.use("/api/scrappcb", require("./routes/scrappcb"));
app.use("/api/spareusage", require("./routes/spareusage"));
app.use("/api/jobdcentry", require("./routes/jobDcEntry"));
app.use("/api/jobreturndc", require("./routes/jobReturnDc"));
app.use("/api/standbydcentry", require("./routes/standbyDcEntry"));
app.use("/api/standbyreturndc", require("./routes/standbyReturnDc"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Running: http://localhost:${PORT}`);
});
