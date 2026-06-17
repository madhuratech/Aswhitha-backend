/**
 * GST Calculation Utility
 * 
 * GST Flow:
 *   SubTotal = sum of all item amounts
 *   Taxable Value = SubTotal + Transport
 *   For Tamil Nadu (state code 33): CGST = SGST = taxableValue * (rate/2) / 100, IGST = 0
 *   For Other States:               IGST = taxableValue * rate / 100, CGST = SGST = 0
 */

/**
 * Returns true if the customer is a Tamil Nadu entity.
 * Detection order:
 *   1. GST number starts with "33"
 *   2. State field contains "tamil nadu" (case-insensitive)
 *   3. State field equals "TN" (case-insensitive)
 */
function isTamilNadu(gstNumber, state) {
    if (gstNumber && String(gstNumber).trim().startsWith("33")) return true;
    if (state) {
        const s = String(state).trim().toLowerCase();
        if (s === "tamil nadu" || s === "tamilnadu" || s === "tn") return true;
    }
    return false;
}

/**
 * Computes GST breakdown from the given inputs.
 *
 * @param {Object} params
 * @param {number} params.subtotal       - Sum of all item amounts
 * @param {number} [params.transport=0]  - Transport / freight charges
 * @param {number} params.gstRate        - Total GST rate percentage (e.g. 18 for 18%)
 * @param {string} [params.gstNumber]    - Customer's GST number (used for state detection)
 * @param {string} [params.state]        - Customer's state name/code (fallback)
 *
 * @returns {{ taxableValue, cgst, sgst, igst, roundOff, grandTotal }}
 */
function computeGst({ subtotal, transport = 0, gstRate, gstNumber, state }) {
    const sub   = parseFloat(subtotal)  || 0;
    const trans = parseFloat(transport) || 0;
    const rate  = parseFloat(gstRate)   || 0;

    const taxableValue = parseFloat((sub + trans).toFixed(2));
    const isTN = isTamilNadu(gstNumber, state);

    let cgst = 0;
    let sgst = 0;
    let igst = 0;

    if (isTN) {
        // Split GST into CGST + SGST
        cgst = parseFloat((taxableValue * (rate / 2) / 100).toFixed(2));
        sgst = parseFloat((taxableValue * (rate / 2) / 100).toFixed(2));
    } else {
        // Full GST as IGST
        igst = parseFloat((taxableValue * rate / 100).toFixed(2));
    }

    const rawTotal    = taxableValue + cgst + sgst + igst;
    const rounded     = Math.round(rawTotal);
    const roundOff    = parseFloat((rounded - rawTotal).toFixed(2));
    const grandTotal  = rounded;

    return { taxableValue, cgst, sgst, igst, roundOff, grandTotal };
}

module.exports = { isTamilNadu, computeGst };
