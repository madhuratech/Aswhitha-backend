const mysql = require("mysql2/promise");
require("dotenv").config();

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    console.log("Connected to database:", process.env.DB_NAME);

    const tables = [
        { name: "purchase_entry", col: "despatch" },
        { name: "standby_return_dc", col: "despatch_through" },
        { name: "standby_dc_entries", col: "despatch_through" },
        { name: "job_return_dc", col: "despatch_through" },
        { name: "job_dc_entries", col: "despatch_through" },
        { name: "service_dc_entries", col: "despatch_through" },
        { name: "sales_dc_entries", col: "despatch_through" },
        { name: "salesinvoice", col: "dispatch_through" },
        { name: "service_invoices", col: "dispatch_through" },
        { name: "directinvoice", col: "dispatch_through" },
        { name: "performance_invoice2_header", col: "dispatch_through" }
    ];

    for (const { name, col } of tables) {
        console.log(`Checking table '${name}' column '${col}'...`);
        // Verify if table and column exist first
        const [exists] = await conn.query(
            `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [process.env.DB_NAME, name, col]
        );

        if (!exists.length) {
            console.log(`Table '${name}' or column '${col}' does not exist, skipping.`);
            continue;
        }

        // Normalize values
        console.log(`Normalizing values in '${name}.${col}'...`);

        // Mapping queries:
        // 1. Courier (courier, COURIER, etc.) -> Courier
        await conn.query(
            `UPDATE ?? SET ?? = 'Courier' WHERE TRIM(LOWER(??)) IN ('courier')`,
            [name, col, col]
        );

        // 2. By Hand (Hand, Byhand, Hand Delivery, By hand, etc.) -> By Hand
        await conn.query(
            `UPDATE ?? SET ?? = 'By Hand' WHERE TRIM(LOWER(??)) IN ('hand', 'byhand', 'hand delivery', 'by hand', 'by hand ')`,
            [name, col, col]
        );

        // 3. Transport (Transports, Transport, Lorry, Bus, Parcel Service, By Bus, By Train etc.) -> Transport
        await conn.query(
            `UPDATE ?? SET ?? = 'Transport' WHERE TRIM(LOWER(??)) IN ('transports', 'transport', 'lorry', 'bus', 'parcel service', 'by bus', 'by train')`,
            [name, col, col]
        );

        // 4. Customer Pickup -> By Hand
        await conn.query(
            `UPDATE ?? SET ?? = 'By Hand' WHERE TRIM(LOWER(??)) IN ('customer pickup')`,
            [name, col, col]
        );

        // Optional check: what's left?
        const [unmatched] = await conn.query(
            `SELECT DISTINCT ?? FROM ?? WHERE ?? IS NOT NULL AND ?? NOT IN ('Courier', 'By Hand', 'Transport')`,
            [col, name, col, col]
        );
        if (unmatched.length) {
            console.warn(`Warning: Unmatched values in ${name}.${col}:`, unmatched.map(r => r[col]));
            // Default any remaining non-null unmatched values to 'By Hand' as requested by the plan
            await conn.query(
                `UPDATE ?? SET ?? = 'By Hand' WHERE ?? IS NOT NULL AND ?? NOT IN ('Courier', 'By Hand', 'Transport')`,
                [name, col, col, col]
            );
            console.log(`Unmatched values defaulted to 'By Hand'.`);
        } else {
            console.log(`Successfully normalized all values in '${name}.${col}'.`);
        }
    }

    await conn.end();
    console.log("\nDatabase normalization migration completed.");
}

main().catch(err => {
    console.error("Migration failed:", err.message);
    process.exit(1);
});
