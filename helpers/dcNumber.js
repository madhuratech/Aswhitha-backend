const db = require("../config/database");

// One common running DC sequence shared by Sales DC and Service DC.
// Scans both tables for the highest trailing number (also covers legacy
// AT/SDC-xxx and AT/DC-xxx formats) so numbers never repeat across modules.
async function generateNextDcNo(conn) {
    const runner = conn || db.promise();
    const [rows] = await runner.query(`
        SELECT dc_no AS no FROM sales_dc_entries
        UNION ALL
        SELECT inward_dc_no AS no FROM service_dc_entries
    `);
    let maxNo =  0;
    
    rows.forEach(({ no }) => {
        const match = (no || "").match(/(\d+)\s*$/);
        if (match) maxNo = Math.max(maxNo, parseInt(match[1], 10));
    });

    const nextNumber = maxNo + 1;
    return `AT/DC${String(nextNumber).padStart(3, "0")}`;
}

module.exports = { generateNextDcNo };
