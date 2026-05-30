const express = require("express");
const router = express.Router();
const db = require("../config/database");

// Generate Service Invoice Number

async function GenerateServiceInvoice() {

  const [rows] = await db.promise().query(
    "SELECT MAX(id) AS lastId FROM service_invoices"
  );

  let lastId = rows[0].lastId || 0;

  let nextId = lastId + 1;

  return `AT/SV/INV-${nextId.toString().padStart(3, "0")}`;
}


// Auto Invoice Number

router.get("/next-SV-no", async (req, res) => {

  try {

    const invoice_no = await GenerateServiceInvoice();

    res.json({
      invoice_no
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Failed To Generate Invoice Number"
    });

  }

});


// Clients — only those who have a DC entry with status 'Service'

router.get("/clients", async (req, res) => {

  try {

    const [rows] = await db.promise().query(
      `SELECT DISTINCT supplier_name AS customer_name
       FROM service_dc_entries
       WHERE status = 'Service'
       ORDER BY supplier_name ASC`
    );

    res.json(rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});


// Client Search — only those who have a DC entry with status 'Service'

router.get("/clients/search", async (req, res) => {

  try {

    const q = req.query.q || "";

    const [rows] = await db.promise().query(

      `SELECT DISTINCT supplier_name AS customer_name
       FROM service_dc_entries
       WHERE status = 'Service'
       AND supplier_name LIKE ?
       ORDER BY supplier_name ASC`,

      [`%${q}%`]

    );

    res.json(rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Search Failed"
    });

  }

});


// Service DC Search

router.get("/service-dc/search", async (req, res) => {

  try {

    const q = req.query.q || "";
    const supplier = req.query.supplier || "";

    let query = `SELECT DISTINCT inward_dc_no
       FROM service_dc_entries
       WHERE status = 'Service'
       AND inward_dc_no LIKE ?`;
    const params = [`%${q}%`];

    if (supplier) {
      query += " AND supplier_name = ?";
      params.push(supplier);
    }

    query += " ORDER BY inward_dc_no DESC";

    const [rows] = await db.promise().query(query, params);

    res.json(rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});


// Fetch Service DC Full Data

router.get("/service-dc/:dcNo", async (req, res) => {

  try {

    const { dcNo } = req.params;

    const [headerRows] = await db.promise().query(

      `SELECT *
       FROM service_dc_entries
       WHERE inward_dc_no = ?
       AND status = 'Service'
       ORDER BY id DESC
       LIMIT 1`,

      [dcNo]

    );

    if (!headerRows.length) {

      return res.status(404).json({
        message: "DC Not Found"
      });

    }

    const header = headerRows[0];

    const [items] = await db.promise().query(

      `SELECT
        item_name,
        quantity,
        received_qty,
        uom,
        hsn AS hsn_number,
        remarks
       FROM service_dc_items
       WHERE service_dc_id = ?
       AND (remarks = 'Service' OR remarks = 'Services')`,

      [header.id]

    );

    res.json({
      header,
      items
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});


// Save Invoice

router.post("/create", async (req, res) => {

  try {

    const {
      customer_name,
      invoice_no,
      invoice_date,
      dc_no,
      dc_date,
      order_no,
      order_date,
      payment_terms,
      dispatch_through,
      discount,
      cgst,
      sgst,
      igst,
      transport,
      round_off,
      grand_total,
      items
    } = req.body;

    const [result] = await db.promise().query(

      `INSERT INTO service_invoices
      (
        customer_name,
        invoice_no,
        invoice_date,
        dc_no,
        dc_date,
        order_no,
        order_date,
        payment_terms,
        dispatch_through,
        discount,
        cgst,
        sgst,
        igst,
        transport,
        round_off,
        grand_total
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

      [
        customer_name,
        invoice_no,
        invoice_date,
        dc_no,
        dc_date,
        order_no,
        order_date,
        payment_terms,
        dispatch_through,
        discount,
        cgst,
        sgst,
        igst,
        transport,
        round_off,
        grand_total
      ]

    );

    const invoiceId = result.insertId;

    for (const item of items) {

      await db.promise().query(

        `INSERT INTO service_invoice_items
        (
          invoice_id,
          item_name,
          quantity,
          price,
          discount,
          amount,
          uom,
          hsn_number
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

        [
          invoiceId,
          item.item_name,
          item.quantity,
          item.price,
          item.discount,
          item.amount,
          item.uom,
          item.hsn_number
        ]

      );

    }

    res.json({
      message: "Invoice Saved Successfully"
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Save Failed"
    });

  }

});


// Search Invoice

router.get("/search-invoice", async (req, res) => {

  try {

    const q = req.query.q || "";

    const [rows] = await db.promise().query(

      `SELECT invoice_no
       FROM service_invoices
       WHERE invoice_no LIKE ?
       ORDER BY id DESC`,

      [`%${q}%`]

    );

    res.json(rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Search Failed"
    });

  }

});


// Load Invoice

router.get("/invoice/:invoice_no", async (req, res) => {

  try {

    const { invoice_no } = req.params;

    const [rows] = await db.promise().query(

      `SELECT *
       FROM service_invoices
       WHERE invoice_no = ?`,

      [invoice_no]

    );

    if (!rows.length) {

      return res.status(404).json({
        message: "Invoice Not Found"
      });

    }

    const invoice = rows[0];

    const [items] = await db.promise().query(

      `SELECT *
       FROM service_invoice_items
       WHERE invoice_id = ?`,

      [invoice.id]

    );

    res.json({
      header: invoice,
      items
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});


// Update Invoice
router.put("/update/:invoice_no", async (req, res) => {
    try {
        const { invoice_no } = req.params;
        const {
            customer_name,
            invoice_date,
            dc_no,
            dc_date,
            order_no,
            order_date,
            payment_terms,
            dispatch_through,
            discount,
            cgst,
            sgst,
            igst,
            transport,
            round_off,
            grand_total,
            items
        } = req.body;

        const [existing] = await db.promise().query(
            "SELECT id FROM service_invoices WHERE invoice_no = ?",
            [invoice_no]
        );
        if (!existing.length) return res.status(404).json({ message: "Invoice Not Found" });
        const invoiceId = existing[0].id;

        await db.promise().query(
            `UPDATE service_invoices SET
                customer_name=?, invoice_date=?, dc_no=?, dc_date=?, order_no=?, order_date=?,
                payment_terms=?, dispatch_through=?, discount=?, cgst=?, sgst=?, igst=?, transport=?, round_off=?, grand_total=?
             WHERE invoice_no=?`,
            [
                customer_name, invoice_date, dc_no, dc_date, order_no, order_date,
                payment_terms, dispatch_through, discount, cgst, sgst, igst, transport, round_off, grand_total, invoice_no
            ]
        );

        await db.promise().query("DELETE FROM service_invoice_items WHERE invoice_id = ?", [invoiceId]);

        for (const item of items) {
            await db.promise().query(
                `INSERT INTO service_invoice_items (invoice_id, item_name, quantity, price, discount, amount, uom, hsn_number)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoiceId, item.item_name, item.quantity, item.price, item.discount, item.amount, item.uom, item.hsn_number]
            );
        }

        res.json({ message: "Invoice Updated" });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server Error" });
    }
});

// Delete Invoice
router.delete("/delete/:invoice_no", async (req, res) => {
    try {
        const { invoice_no } = req.params;
        const [existing] = await db.promise().query(
            "SELECT id FROM service_invoices WHERE invoice_no = ?",
            [invoice_no]
        );
        if (!existing.length) return res.status(404).json({ message: "Invoice Not Found" });
        const invoiceId = existing[0].id;

        await db.promise().query("DELETE FROM service_invoice_items WHERE invoice_id = ?", [invoiceId]);
        await db.promise().query("DELETE FROM service_invoices WHERE id = ?", [invoiceId]);

        res.json({ message: "Invoice Deleted" });
    } catch (error) {
        res.status(500).json({ message: "Server Error" });
    }
});

module.exports = router;