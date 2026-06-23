const mysql = require('mysql2');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

async function migrate() {
  try {
    await db.promise().query(`
      ALTER TABLE expenses
      ADD COLUMN employee_name VARCHAR(255) DEFAULT NULL AFTER category
    `);
    console.log("✓ Added employee_name column to expenses table");
    process.exit(0);
  } catch (err) {
    if (err.errno === 1060) {
      console.log("✓ Column employee_name already exists");
      process.exit(0);
    }
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
}

migrate();
