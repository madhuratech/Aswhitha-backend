const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

// Generate shared invoice number across service_invoices, directinvoice, salesinvoice
async function GenerateInvoiceNumber() {
    const [rows] = await db.promise().query(`
        SELECT invoice_no FROM salesinvoice
        UNION ALL
        SELECT invoice_no FROM service_invoices
        UNION ALL
        SELECT invoice_no FROM directinvoice
    `);

    let maxNumber = 0;

    rows.forEach(row => {
        if (!row.invoice_no) return;

        const match = row.invoice_no.match(/AT\/INV\/(\d+)/);

        if (match) {
            maxNumber = Math.max(
                maxNumber,
                parseInt(match[1], 10)
            );
        }
    });

    const nextNumber = maxNumber + 1;

    return `AT/INV/${String(nextNumber).padStart(3, "0")}`;
}

// Auto Invoice Number

router.get("/next-SV-no", async (req, res) => {

  try {

    const invoice_no = await GenerateInvoiceNumber();

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


// Service DC Search — returns Admin DC numbers (inward_dc_no) for dropdown
// Filters: status='Service', items have remarks='Service'/'Services', matching customer

router.get("/service-dc/search", async (req, res) => {

  try {

    const q = req.query.q || "";
    const supplier = req.query.supplier || "";

    let query = `SELECT sde.inward_dc_no, sde.party_dc_no
       FROM service_dc_entries sde
       WHERE sde.status = 'Service'
       AND sde.inward_dc_no IS NOT NULL
       AND sde.inward_dc_no LIKE ?
       AND EXISTS (
           SELECT 1 FROM service_dc_items sdi
           WHERE sdi.service_dc_id = sde.id
           AND (sdi.remarks = 'Service' OR sdi.remarks = 'Services')
       )`;
    const params = [`%${q}%`];

    if (supplier) {
      query += " AND sde.supplier_name = ?";
      params.push(supplier);
    }

    query += " ORDER BY sde.id DESC";

    const [rows] = await db.promise().query(query, params);

    res.json(rows);

  } catch (error) {

    console.log(error);

    res.status(500).json({
      message: "Server Error"
    });

  }

});


// Fetch Service DC Full Data by Admin DC number (inward_dc_no)
// Used by Service Invoice to look up DC after Admin DC dropdown selection

router.get("/service-dc/by-admin/:adminDcNo", async (req, res) => {

  try {

    const { adminDcNo } = req.params;

    const [headerRows] = await db.promise().query(
      `SELECT *
       FROM service_dc_entries
       WHERE inward_dc_no = ?
       AND status = 'Service'
       LIMIT 1`,
      [adminDcNo]
    );

    if (!headerRows.length) {
      return res.status(404).json({ message: "DC Not Found" });
    }

    const header = headerRows[0];

    const [items] = await db.promise().query(
      `SELECT item_name, quantity, received_qty, serial_no, uom,
              hsn AS hsn_number, remarks
       FROM service_dc_items
       WHERE service_dc_id = ?
       AND (remarks = 'Service' OR remarks = 'Services')`,
      [header.id]
    );

    res.json({ header, items });

  } catch (error) {

    console.log(error);

    res.status(500).json({ message: "Server Error" });

  }

});


// Fetch Service DC Full Data — look up by client (party) DC number

router.get("/service-dc/:dcNo", async (req, res) => {

  try {

    const { dcNo } = req.params;

    const [headerRows] = await db.promise().query(

      `SELECT *
       FROM service_dc_entries
       WHERE party_dc_no = ?
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
    const s = sanitizeBody(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const [result] = await db.promise().query(
      `INSERT INTO service_invoices
      (customer_name, invoice_no, invoice_date, client_dc_no, dc_no, dc_date,
       order_no, order_date, payment_terms, dispatch_through, discount, cgst,
       sgst, igst, transport, round_off, grand_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.customer_name,
        s.invoice_no,
        emptyToNull(s.invoice_date),
        emptyToNull(s.client_dc_no),
        emptyToNull(s.dc_no),
        emptyToNull(s.dc_date),
        emptyToNull(s.order_no),
        emptyToNull(s.order_date),
        emptyToNull(s.payment_terms),
        emptyToNull(s.dispatch_through),
        toNum(s.discount),
        toNum(s.cgst),
        toNum(s.sgst),
        toNum(s.igst),
        toNum(s.transport),
        toNum(s.round_off),
        toNum(s.grand_total)
      ]
    );

    const invoiceId = result.insertId;

    for (const item of items) {
      await db.promise().query(
        `INSERT INTO service_invoice_items
        (invoice_id, item_name, quantity, price, discount, amount, uom, hsn_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          emptyToNull(item.item_name),
          toNum(item.quantity),
          toNum(item.price),
          toNum(item.discount),
          toNum(item.amount),
          emptyToNull(item.uom),
          emptyToNull(item.hsn_number)
        ]
      );
    }

    res.json({ message: "Invoice Saved Successfully" });

  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Save Failed" });
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

      `SELECT si.*,
              nc.address      AS client_address,
              nc.phone        AS client_phone,
              nc.gst_number   AS client_gst,
              nc.state        AS client_state,
              nc.pincode      AS client_pincode
       FROM service_invoices si
       LEFT JOIN newclient nc ON nc.customer_name = si.customer_name
       WHERE si.invoice_no = ?`,

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
        const s = sanitizeBody(req.body);
        const items = Array.isArray(req.body.items) ? req.body.items : [];

        const [existing] = await db.promise().query(
            "SELECT id FROM service_invoices WHERE invoice_no = ?",
            [invoice_no]
        );
        if (!existing.length) return res.status(404).json({ message: "Invoice Not Found" });
        const invoiceId = existing[0].id;

        await db.promise().query(
            `UPDATE service_invoices SET
                customer_name=?, invoice_date=?, client_dc_no=?, dc_no=?, dc_date=?, order_no=?, order_date=?,
                payment_terms=?, dispatch_through=?, discount=?, cgst=?, sgst=?, igst=?, transport=?, round_off=?, grand_total=?
             WHERE invoice_no=?`,
            [
                s.customer_name, emptyToNull(s.invoice_date), emptyToNull(s.client_dc_no),
                emptyToNull(s.dc_no), emptyToNull(s.dc_date), emptyToNull(s.order_no), emptyToNull(s.order_date),
                emptyToNull(s.payment_terms), emptyToNull(s.dispatch_through),
                toNum(s.discount), toNum(s.cgst), toNum(s.sgst), toNum(s.igst),
                toNum(s.transport), toNum(s.round_off), toNum(s.grand_total), invoice_no
            ]
        );

        await db.promise().query("DELETE FROM service_invoice_items WHERE invoice_id = ?", [invoiceId]);

        for (const item of items) {
            await db.promise().query(
                `INSERT INTO service_invoice_items (invoice_id, item_name, quantity, price, discount, amount, uom, hsn_number)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoiceId, emptyToNull(item.item_name), toNum(item.quantity), toNum(item.price), toNum(item.discount), toNum(item.amount), emptyToNull(item.uom), emptyToNull(item.hsn_number)]
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