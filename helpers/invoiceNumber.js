const db = require("../config/database");

const INVOICE_MIN = 918; // first number → AT0918

// Parse an invoice_no string and return the numeric part.
// Handles both legacy "AT/INV/034" and current "AT0918" formats.
function extractInvoiceNum(str) {
    if (!str) return 0;
    // AT/INV/034 or AT/INV034
    const legacyMatch = str.match(/AT\/INV\/?(\d+)/i);
    if (legacyMatch) return parseInt(legacyMatch[1], 10);
    // AT0918 (AT followed by digits)
    const newMatch = str.match(/^AT(\d+)$/i);
    if (newMatch) return parseInt(newMatch[1], 10);
    return 0;
}

// Shared invoice sequence across all three invoice types.
async function generateNextInvoiceNo(conn) {
    const runner = conn || db.promise();
    const [rows] = await runner.query(`
        SELECT invoice_no FROM salesinvoice
        UNION ALL
        SELECT invoice_no FROM service_invoices
        UNION ALL
        SELECT invoice_no FROM directinvoice
    `);
    let maxNo = INVOICE_MIN - 1;
    rows.forEach(({ invoice_no }) => {
        const n = extractInvoiceNum(invoice_no);
        if (n > maxNo) maxNo = n;
    });
    return `AT${String(maxNo + 1).padStart(4, "0")}`;
}

module.exports = { generateNextInvoiceNo };
