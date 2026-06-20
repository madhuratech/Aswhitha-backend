
const express = require("express");
const router = express.Router();
const db = require("../config/database");

console.log("Pending routes loaded ✅");

/* =========================
   TEST ROUTE
========================= */
router.get("/ping", (req, res) => {
    res.json({ success: true, message: "Pending API is working" });
});

/* =========================
   CALCULATED PENDING
   Inward Qty − SUM(Service DC Qty), only pending_qty > 0
========================= */
router.get("/calculated", async (req, res) => {
    try {
        const [rows] = await db.promise().query(`
            SELECT
                ie.id                                                   AS entry_id,
                ii.id                                                   AS item_id,
                ie.supplier_name                                        AS customer_name,
                ie.dc_number                                            AS dc_no,
                DATE_FORMAT(ie.dc_date, '%Y-%m-%d')                     AS dc_date,
                ie.description_type                                     AS item_type,
                ii.item_name,
                ii.quantity                                             AS order_qty,
                COALESCE(SUM(sdi.quantity), 0)                          AS despatch_qty,
                (ii.quantity - COALESCE(SUM(sdi.quantity), 0))          AS pending_qty
            FROM inward_entry ie
            JOIN inward_items ii
                ON ii.inward_id = ie.id
            LEFT JOIN service_dc_items sdi
                ON  sdi.item_name    = ii.item_name
                AND sdi.service_dc_id IN (
                    SELECT sde.id FROM service_dc_entries sde
                    WHERE sde.supplier_name = ie.supplier_name
                      AND CONCAT(',', sde.party_dc_no, ',') LIKE CONCAT('%,', ie.dc_number, ',%')
                )
            GROUP BY ie.id, ii.id
            HAVING pending_qty > 0
            ORDER BY ie.id DESC
        `);
        res.json(rows);
    } catch (err) {
        console.log("CALCULATED PENDING ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/* =========================
   GET PENDING LIST
========================= */
router.get("/list", async (req, res) => {

    try {

        const [rows] = await db.promise().query(`
            SELECT
                e.id AS entry_id,
                e.customer_name,
                e.dc_no,
                DATE_FORMAT(e.dc_date, '%Y-%m-%d') AS dc_date,
                i.id AS item_id,
                i.item_name,
                i.order_qty,
                i.despatch_qty,
                i.pending_qty,
                i.remarks
            FROM pending_entries e
            LEFT JOIN pending_items i
            ON i.pending_id = e.id
            ORDER BY e.id DESC
        `);

        res.json(rows);

    } catch (err) {

        console.log("LIST ERROR:", err);

        res.status(500).json({
            success: false,
            message: err.message
        });

    }

});


/* =========================
   SAVE PENDING
========================= */
router.post("/save", async (req, res) => {

    let connection;

    try {

        connection = await db.promise().getConnection();

        const {
            customer_name,
            dc_no,
            dc_date,
            items
        } = req.body;

        if (
            !customer_name ||
            !dc_no ||
            !Array.isArray(items) ||
            items.length === 0
        ) {

            return res.status(400).json({
                success: false,
                message: "Required fields missing"
            });

        }

        await connection.beginTransaction();

        // INSERT HEADER
        const [entryResult] = await connection.query(
            `
            INSERT INTO pending_entries
            (
                customer_name,
                dc_no,
                dc_date
            )
            VALUES (?, ?, ?)
            `,
            [
                customer_name,
                dc_no,
                dc_date || null
            ]
        );

        const pendingId = entryResult.insertId;

        // INSERT ITEMS
        for (const item of items) {

            await connection.query(
                `
                INSERT INTO pending_items
                (
                    pending_id,
                    item_name,
                    order_qty,
                    despatch_qty,
                    pending_qty,
                    remarks
                )
                VALUES (?, ?, ?, ?, ?, ?)
                `,
                [
                    pendingId,
                    item.item_name || "",
                    Number(item.order_qty) || 0,
                    Number(item.despatch_qty) || 0,
                    Number(item.pending_qty) || 0,
                    item.remarks || null
                ]
            );

        }

        await connection.commit();

        res.json({
            success: true,
            saved: items.length
        });

    } catch (err) {

        console.log("SAVE ERROR:", err);

        if (connection) {
            await connection.rollback();
        }

        res.status(500).json({
            success: false,
            message: err.message
        });

    } finally {

        if (connection) {
            connection.release();
        }

    }

});


/* =========================
   DELETE ENTRY
========================= */
router.delete("/delete/:id", async (req, res) => {

    let connection;

    try {

        connection = await db.promise().getConnection();

        const { id } = req.params;

        await connection.beginTransaction();

        await connection.query(
            `DELETE FROM pending_items WHERE pending_id = ?`,
            [id]
        );

        await connection.query(
            `DELETE FROM pending_entries WHERE id = ?`,
            [id]
        );

        await connection.commit();

        res.json({
            success: true
        });

    } catch (err) {

        console.log("DELETE ERROR:", err);

        if (connection) {
            await connection.rollback();
        }

        res.status(500).json({
            success: false,
            message: err.message
        });

    } finally {

        if (connection) {
            connection.release();
        }

    }

});

module.exports = router;
