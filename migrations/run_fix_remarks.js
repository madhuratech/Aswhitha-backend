const mysql = require("mysql2/promise");
require("dotenv").config();

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    console.log("Connected. Checking current column type...");

    const [cols] = await conn.query(
        `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sales_dc_items' AND COLUMN_NAME = 'remarks'`,
        [process.env.DB_NAME]
    );

    if (cols.length) {
        console.log("Current type:", cols[0].COLUMN_TYPE);
    }

    console.log("Altering sales_dc_items.remarks to VARCHAR(500)...");
    await conn.query("ALTER TABLE sales_dc_items MODIFY COLUMN remarks VARCHAR(500) NULL");
    console.log("Done: sales_dc_items.remarks");

    console.log("Altering service_dc_items.remarks to VARCHAR(500)...");
    try {
        await conn.query("ALTER TABLE service_dc_items MODIFY COLUMN remarks VARCHAR(500) NULL");
        console.log("Done: service_dc_items.remarks");
    } catch (e) {
        console.warn("Skipped service_dc_items:", e.message);
    }

    await conn.end();
    console.log("\nMigration complete. The remarks column now accepts free text.");
}

main().catch(err => {
    console.error("Migration failed:", err.message);
    process.exit(1);
});
