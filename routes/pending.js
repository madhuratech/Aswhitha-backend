
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
