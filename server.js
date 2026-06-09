require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./config/database");

// Add client_dc_no column if not already present
db.promise().query(
  "ALTER TABLE service_invoices ADD COLUMN client_dc_no VARCHAR(100) DEFAULT ''"
).catch(() => {});

// Add remarks column to sales_dc_items if not already present
db.promise().query(
  "ALTER TABLE sales_dc_items ADD COLUMN remarks VARCHAR(100) DEFAULT NULL"
).catch(() => {});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Running: http://localhost:${PORT}`);
});
