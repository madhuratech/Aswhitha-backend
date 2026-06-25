const express = require("express");
const router = express.Router();
const db = require("../config/database");
const { emptyToNull, toNum, sanitizeBody } = require("../helpers/sanitize");

const { generateNextInvoiceNo } = require("../helpers/invoiceNumber");

// Auto Invoice Number
router.get("/next-SV-no", async (req, res) => {
  try {
    const invoice_no = await generateNextInvoiceNo();
    res.json({ invoice_no });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Failed To Generate Invoice Number" });
  }
});


// Clients — those who have a non-invoiced Service DC (status Pending Invoice or legacy Service)

router.get("/clients", async (req, res) => {

  try {

    const [rows] = await db.promise().query(
      `SELECT DISTINCT supplier_name AS customer_name
       FROM service_dc_entries sde
       WHERE NOT EXISTS (
           SELECT 1 FROM service_invoices si
           WHERE FIND_IN_SET(sde.inward_dc_no, REPLACE(si.dc_no, ' ', '')) > 0
       )
       AND EXISTS (
           SELECT 1 FROM service_dc_items sdi
           WHERE sdi.service_dc_id = sde.id
           AND sdi.remarks IN ('Serviced', 'For Sale')
       )
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


// Client Search — those who have a non-invoiced Service DC

router.get("/clients/search", async (req, res) => {

  try {

    const q = req.query.q || "";

    const [rows] = await db.promise().query(

      `SELECT DISTINCT sde.supplier_name AS customer_name, nc.state, nc.gst_number
       FROM service_dc_entries sde
       LEFT JOIN newclient nc ON nc.customer_name = sde.supplier_name
       WHERE sde.supplier_name LIKE ?
        AND NOT EXISTS (
            SELECT 1 FROM service_invoices si
            WHERE FIND_IN_SET(sde.inward_dc_no, REPLACE(si.dc_no, ' ', '')) > 0
        )
        AND EXISTS (
            SELECT 1 FROM service_dc_items sdi
            WHERE sdi.service_dc_id = sde.id
            AND sdi.remarks IN ('Serviced', 'For Sale')
        )
        ORDER BY sde.supplier_name ASC`,

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


// Service DC Search — returns Admin DC numbers for dropdown
// Shows only non-invoiced DCs that have at least one Service item

router.get("/service-dc/search", async (req, res) => {
  try {
    const q = req.query.q || "";
    const supplier = req.query.supplier || "";

    // Debug Logging to identify why records are excluded
    try {
      const [allDcs] = await db.promise().query(`
        SELECT sde.inward_dc_no, sde.supplier_name, sde.id,
               (SELECT COUNT(*) FROM service_invoices si WHERE FIND_IN_SET(sde.inward_dc_no, REPLACE(si.dc_no, ' ', '')) > 0) AS invoice_count,
               (SELECT GROUP_CONCAT(CONCAT(sdi.item_name, ':', sdi.remarks)) FROM service_dc_items sdi WHERE sdi.service_dc_id = sde.id) AS items_remarks
        FROM service_dc_entries sde
        ORDER BY sde.id DESC LIMIT 10
      `);
      console.log("=== Service DC Dropdown Filtering Debug ===");
      allDcs.forEach(dc => {
        const isRemarksEligible = dc.items_remarks && (dc.items_remarks.includes("Serviced") || dc.items_remarks.includes("For Sale"));
        const isInvoiced = dc.invoice_count > 0;
        const filterResult = isRemarksEligible && !isInvoiced ? "Visible" : "Excluded";
        console.log(`DC: ${dc.inward_dc_no} | Remarks/Items: [${dc.items_remarks || ""}] | Invoice Status: ${isInvoiced ? "Invoiced" : "Pending"} | Filter Result: ${filterResult}`);
      });
      console.log("==========================================");
    } catch (logErr) {
      console.error("Debug logging query failed:", logErr.message);
    }

    let query = `
      SELECT
          sde.inward_dc_no,
          sde.party_dc_no,
          sde.supplier_name,
          sde.dc_date,
          (
            SELECT GROUP_CONCAT(
                CONCAT(sdi2.item_name, ' × ', CAST(sdi2.quantity AS CHAR), ' [', sdi2.remarks, ']')
                SEPARATOR ' | ')
            FROM service_dc_items sdi2
            WHERE sdi2.service_dc_id = sde.id
            AND sdi2.remarks IN ('Serviced', 'For Sale')
          ) AS items_summary
      FROM service_dc_entries sde
      WHERE 1=1

      -- Only non-invoiced DCs (check service_invoices directly — consistent with clients endpoints)
      AND NOT EXISTS (
          SELECT 1
          FROM service_invoices si
          WHERE FIND_IN_SET(sde.inward_dc_no, REPLACE(si.dc_no, ' ', '')) > 0
      )

      -- Only DCs with at least one invoice-eligible item (Serviced / For Sale)
      AND EXISTS (
          SELECT 1
          FROM service_dc_items sdi
          WHERE sdi.service_dc_id = sde.id
          AND sdi.remarks IN ('Serviced', 'For Sale')
      )

      -- Search filter
      AND (
          sde.inward_dc_no LIKE ?
          OR sde.party_dc_no LIKE ?
      )`;
    const params = [
      `%${q}%`,
      `%${q}%`
    ];

    // Supplier filter
    if (supplier && supplier.trim() !== "") {
      query += ` AND sde.supplier_name = ? `;
      params.push(supplier);
    }

    query += `
      ORDER BY sde.id DESC
      LIMIT 50
    `;

    const [rows] = await db.promise().query(query, params);

    res.json(rows);

  } catch (error) {
    console.error("Service DC Search Error:", error);

    res.status(500).json({
      message: "Search Failed"
    });
  }
});


// Fetch Service DC Full Data by Admin DC number (inward_dc_no)
// Used by Service Invoice to look up DC after Admin DC dropdown selection

router.get("/service-dc/by-admin/:adminDcNo", async (req, res) => {

  try {

    const { adminDcNo } = req.params;

    // Block lookup if DC is already invoiced
    const [alreadyInvoiced] = await db.promise().query(
      `SELECT id FROM service_invoices WHERE FIND_IN_SET(?, REPLACE(dc_no, ' ', '')) > 0 LIMIT 1`,
      [adminDcNo]
    );
    if (alreadyInvoiced.length) {
      return res.status(409).json({ message: "This Service DC has already been invoiced" });
    }

    const [headerRows] = await db.promise().query(
      `SELECT *
       FROM service_dc_entries
       WHERE inward_dc_no = ?
       LIMIT 1`,
      [adminDcNo]
    );

    if (!headerRows.length) {
      return res.status(404).json({ message: "DC Not Found or not eligible for invoicing" });
    }

    const header = headerRows[0];

    const [items] = await db.promise().query(
      `SELECT item_name, quantity, serial_no, uom,
              hsn AS hsn_number, remarks,
              party_dc_no, party_dc_date
       FROM service_dc_items
       WHERE service_dc_id = ?
       AND remarks IN ('Serviced', 'For Sale')`,
      [header.id]
    );

    const allOrderNos = items.map(item => item.party_dc_no).filter(Boolean);
    const allOrderDates = items.map(item => item.party_dc_date).filter(Boolean);

    const aggregated_order_no = allOrderNos.length
        ? [...new Set(allOrderNos)].join(", ")
        : (header.party_dc_no || "");

    const aggregated_order_date = allOrderDates.length
        ? [...new Set(allOrderDates)].join(", ")
        : (header.party_dc_date || "");

    res.json({ header, items, aggregated_order_no, aggregated_order_date });

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
        AND NOT EXISTS (
            SELECT 1 FROM service_invoices si WHERE FIND_IN_SET(service_dc_entries.inward_dc_no, REPLACE(si.dc_no, ' ', '')) > 0
        )
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
        uom,
        hsn AS hsn_number,
        remarks
       FROM service_dc_items
       WHERE service_dc_id = ?
       AND remarks IN ('Serviced', 'For Sale')`,

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

  const items = Array.isArray(req.body.items) ? req.body.items : [];

  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const s = sanitizeBody(req.body);
    const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
    if (!s.dispatch_through?.trim() || !ALLOWED_DESPATCH.includes(s.dispatch_through.trim())) {
      return res.status(400).json({ message: "Despatch Through cannot be null." });
    }

    try {
      // Prevent duplicate invoice for the same DC
      if (s.dc_no) {
        const [existing] = await db.promise().query(
          `SELECT id FROM service_invoices WHERE FIND_IN_SET(?, REPLACE(dc_no, ' ', '')) > 0 LIMIT 1`,
          [s.dc_no]
        );
        if (existing.length) {
          return res.status(409).json({ message: "Invoice already exists for this Service DC" });
        }
      }

      const [result] = await db.promise().query(
        `INSERT INTO service_invoices
        (customer_name, invoice_no, invoice_date, order_no, order_date, dc_no, dc_date,
         dispatch_through, discount, cgst,
         sgst, igst, transport, round_off, grand_total, client_dc_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.customer_name,
          s.invoice_no,
          emptyToNull(s.invoice_date),
          emptyToNull(s.order_no),
          emptyToNull(s.order_date),
          emptyToNull(s.dc_no),
          emptyToNull(s.dc_date),
          emptyToNull(s.dispatch_through),
          toNum(s.discount),
          toNum(s.cgst),
          toNum(s.sgst),
          toNum(s.igst),
          toNum(s.transport),
          toNum(s.round_off),
          toNum(s.grand_total),
          emptyToNull(s.client_dc_no)
        ]
      );

      const invoiceId = result.insertId;

      for (const item of items) {
        await db.promise().query(
          `INSERT INTO service_invoice_items
          (invoice_id, item_name, serial_no, model_no, quantity, price, discount, amount, uom, hsn_number, order_no, order_date, dc_no, dc_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            invoiceId,
            emptyToNull(item.item_name),
            emptyToNull(item.serial_no),
            emptyToNull(item.model_no),
            toNum(item.quantity),
            toNum(item.price),
            toNum(item.discount),
            toNum(item.amount),
            emptyToNull(item.uom),
            emptyToNull(item.hsn_number),
            emptyToNull(item.order_no),
            emptyToNull(item.order_date),
            emptyToNull(item.dc_no),
            emptyToNull(item.dc_date)
          ]
        );
      }

      // Mark DC numbers as completed in dc_status
      if (s.dc_no) {
        const dcNos = (s.dc_no || "").split(",").map(d => d.trim()).filter(Boolean);
        for (const dcNo of dcNos) {
          await db.promise().query(
            `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
             VALUES (?, 'ServiceDC', 'Completed', 'ServiceInvoice')
             ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'ServiceInvoice'`,
            [dcNo]
          );
        }
      }

      return res.json({ message: "Invoice Saved Successfully", invoice_no: s.invoice_no });

    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' && attempts < MAX_ATTEMPTS) {
        const newNo = await GenerateInvoiceNumber();
        req.body.invoice_no = newNo;
        continue;
      }
      console.log(error);
      return res.status(500).json({ message: "Save Failed" });
    }
  }
  res.status(500).json({ message: "Failed to create invoice after multiple attempts" });
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

        const ALLOWED_DESPATCH = ["Courier", "By Hand", "Transport"];
        if (!s.dispatch_through?.trim() || !ALLOWED_DESPATCH.includes(s.dispatch_through.trim())) {
            return res.status(400).json({ message: "Despatch Through cannot be null." });
        }

        const [existing] = await db.promise().query(
            "SELECT id FROM service_invoices WHERE invoice_no = ?",
            [invoice_no]
        );
        if (!existing.length) return res.status(404).json({ message: "Invoice Not Found" });
        const invoiceId = existing[0].id;

        await db.promise().query(
            `UPDATE service_invoices SET
                customer_name=?, invoice_date=?, order_no=?, order_date=?, dc_no=?, dc_date=?,
                dispatch_through=?,
                discount=?, cgst=?, sgst=?, igst=?, transport=?, round_off=?, grand_total=?,
                client_dc_no=?
             WHERE invoice_no=?`,
            [
                s.customer_name, emptyToNull(s.invoice_date), emptyToNull(s.order_no),
                emptyToNull(s.order_date), emptyToNull(s.dc_no), emptyToNull(s.dc_date),
                emptyToNull(s.dispatch_through),
                toNum(s.discount), toNum(s.cgst), toNum(s.sgst), toNum(s.igst),
                toNum(s.transport), toNum(s.round_off), toNum(s.grand_total),
                emptyToNull(s.client_dc_no), invoice_no
            ]
        );

        await db.promise().query("DELETE FROM service_invoice_items WHERE invoice_id = ?", [invoiceId]);

        for (const item of items) {
            await db.promise().query(
                `INSERT INTO service_invoice_items (invoice_id, item_name, serial_no, model_no, quantity, price, discount, amount, uom, hsn_number, order_no, order_date, dc_no, dc_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    invoiceId,
                    emptyToNull(item.item_name),
                    emptyToNull(item.serial_no),
                    emptyToNull(item.model_no),
                    toNum(item.quantity),
                    toNum(item.price),
                    toNum(item.discount),
                    toNum(item.amount),
                    emptyToNull(item.uom),
                    emptyToNull(item.hsn_number),
                    emptyToNull(item.order_no),
                    emptyToNull(item.order_date),
                    emptyToNull(item.dc_no),
                    emptyToNull(item.dc_date)
                ]
            );
        }

        // Mark DC numbers as completed in dc_status
        if (s.dc_no) {
            const dcNos = (s.dc_no || "").split(",").map(d => d.trim()).filter(Boolean);
            for (const dcNo of dcNos) {
                await db.promise().query(
                    `INSERT INTO dc_status (dc_number, dc_type, status, invoice_type)
                     VALUES (?, 'ServiceDC', 'Completed', 'ServiceInvoice')
                     ON DUPLICATE KEY UPDATE status = 'Completed', invoice_type = 'ServiceInvoice'`,
                    [dcNo]
                );
            }
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
            "SELECT id, dc_no FROM service_invoices WHERE invoice_no = ?",
            [invoice_no]
        );
        if (!existing.length) return res.status(404).json({ message: "Invoice Not Found" });
        const { id: invoiceId, dc_no } = existing[0];

        await db.promise().query("DELETE FROM service_invoice_items WHERE invoice_id = ?", [invoiceId]);
        await db.promise().query("DELETE FROM service_invoices WHERE id = ?", [invoiceId]);

        // Clean up dc_status so the DC becomes available again in the dropdown
        if (dc_no) {
            const dcNos = dc_no.split(",").map(d => d.trim()).filter(Boolean);
            for (const dcNo of dcNos) {
                await db.promise().query(
                    `DELETE FROM dc_status WHERE dc_number = ? AND dc_type = 'ServiceDC'`,
                    [dcNo]
                );
            }
        }

        res.json({ message: "Invoice Deleted" });
    } catch (error) {
        res.status(500).json({ message: "Server Error" });
    }
});

module.exports = router;