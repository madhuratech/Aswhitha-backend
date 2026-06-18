const db = require("../config/database");

// Preview only — reads current counter without incrementing
async function getCurrentDcNumber() {
  const [rows] = await db.promise().query(
    "SELECT current_number FROM dc_running_number WHERE id = 1"
  );
  return String(rows[0].current_number);
}

// Atomic get-and-increment — safe under concurrent saves
// Accepts optional conn for callers already inside a transaction
async function getAndIncrementDcNumber(conn) {
  const runner = conn || db.promise();
  const ownsConn = !conn;
  try {
    if (ownsConn) await runner.beginTransaction();
    const [rows] = await runner.query(
      "SELECT current_number FROM dc_running_number WHERE id = 1 FOR UPDATE"
    );
    const current = rows[0].current_number;
    await runner.query(
      "UPDATE dc_running_number SET current_number = current_number + 1 WHERE id = 1"
    );
    if (ownsConn) await runner.commit();
    return String(current);
  } catch (err) {
    if (ownsConn) await runner.rollback();
    throw err;
  } finally {
    if (ownsConn && runner.release) runner.release();
  }
}

module.exports = { getCurrentDcNumber, getAndIncrementDcNumber };
