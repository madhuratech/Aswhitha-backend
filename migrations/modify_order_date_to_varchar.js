const mysql = require("mysql2/promise");
require("dotenv").config();

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    console.log("Connected to MySQL database:", process.env.DB_NAME);

    const tablesToAlter = [
        { table: "salesinvoice", col: "order_date" },
        { table: "service_invoices", col: "order_date" },
        { table: "directinvoice", col: "order_date" },
        { table: "salesinvoice_items", col: "order_date" },
        { table: "service_invoice_items", col: "order_date" },
        { table: "invoice_items", col: "order_date" },
        { table: "sales_dc_entries", col: "order_date" },
        { table: "sales_dc_items", col: "order_date" },
        { table: "standby_dc_entries", col: "order_date" },
        { table: "job_dc_entries", col: "order_date" },
        { table: "job_dc_items", col: "order_date" },
        { table: "purchase_entry", col: "order_date" }
    ];

    for (const item of tablesToAlter) {
        console.log(`Checking column type of ${item.table}.${item.col}...`);
        try {
            const [cols] = await conn.query(
                `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                [process.env.DB_NAME, item.table, item.col]
            );

            if (cols.length) {
                console.log(`Current type of ${item.table}.${item.col}:`, cols[0].COLUMN_TYPE);
                if (cols[0].COLUMN_TYPE.toLowerCase().includes("varchar")) {
                    console.log(`Column ${item.table}.${item.col} is already VARCHAR. Skipping.`);
                    continue;
                }
            } else {
                console.log(`Column ${item.table}.${item.col} does not exist. Skipping.`);
                continue;
            }

            console.log(`Altering ${item.table}.${item.col} to VARCHAR(500)...`);
            await conn.query(`ALTER TABLE ${item.table} MODIFY COLUMN ${item.col} VARCHAR(500) NULL`);
            console.log(`Successfully altered ${item.table}.${item.col}`);
        } catch (err) {
            console.error(`Failed to alter ${item.table}.${item.col}:`, err.message);
        }
    }

    await conn.end();
    console.log("\nMigration completed successfully.");
}

main().catch(err => {
    console.error("Migration script failed:", err.message);
    process.exit(1);
});
