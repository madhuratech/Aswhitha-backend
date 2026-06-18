const db = require("../config/database");

async function generateNextPI2InvoiceNo() {
    try {
        const [rows] = await db.promise().query(
            "SELECT invoice_no FROM performance_invoice2_header"
        );
        let maxNo = 0;
        rows.forEach(({ invoice_no }) => {
            const m = (invoice_no || "").match(/PI2\/INV-(\d+)/i);
            if (m) {
                const n = parseInt(m[1], 10);
                if (n > maxNo) maxNo = n;
            }
        });
        return `PI2/INV-${String(maxNo + 1).padStart(4, "0")}`;
    } catch {
        return "PI2/INV-0001";
    }
}

module.exports = { generateNextPI2InvoiceNo };
