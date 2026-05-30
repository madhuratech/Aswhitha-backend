require("dotenv").config();
const express = require("express");
const cors = require("cors");
require("./config/database");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/customers", require("./routes/ClientRoutes"));
app.use("/api/employees", require("./routes/employeedata"));
app.use("/api/Sparemodels", require("./routes/sparemodel"));
app.use("/api/Services", require("./routes/services"));
app.use("/api/expenses", require("./routes/expensedata"));
app.use("/api/purchaseitems",require("./routes/purchase"));
app.use("/api/purchaseorders", require("./routes/purchaseorder"));
app.use("/api/debitnotes", require("./routes/debitnote"));
app.use("/api/suppliers", require("./routes/supplier"));
app.use("/api/taxpurchases",require("./routes/taxpurchase"));
app.use("/api/billpayment",require("./routes/billwisepayment"));
app.use("/api/quotations", require("./routes/quotation"));
app.use("/api/directinvoices", require("./routes/directinvoice"));
app.use("/api/salesinvoices", require("./routes/salesinvoice"));
app.use("/api/salesdc", require("./routes/salesdc"));
app.use("/api/Inwardentries", require("./routes/inwardentry"));
app.use("/api/servicedcentry", require("./routes/dcEntry"));
app.use("/api/serviceinvoice", require("./routes/serviceinvoic"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Running: http://localhost:${PORT}`);
});
