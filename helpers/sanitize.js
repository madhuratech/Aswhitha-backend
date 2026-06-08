/**
 * sanitize.js — Global NULL-safety helpers for all ERP routes.
 *
 * Usage:
 *   const { emptyToNull, toNum, sanitizeBody, sanitizeItems } = require("../helpers/sanitize");
 *
 * Apply BEFORE every INSERT and UPDATE:
 *   const s = sanitizeBody(req.body);
 *   const items = sanitizeItems(req.body.items);
 */

/**
 * Converts empty string, undefined, or null → null.
 * Use for optional VARCHAR, TEXT, and DATE fields before INSERT/UPDATE.
 */
function emptyToNull(value) {
  if (value === "" || value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

/**
 * Converts empty/undefined/null to a number (default 0).
 * Use for optional numeric fields (discount, transport, cgst, etc.)
 */
function toNum(value, defaultVal = 0) {
  if (value === "" || value === undefined || value === null) return defaultVal;
  const n = Number(value);
  return isNaN(n) ? defaultVal : n;
}

/**
 * Sanitizes all string-valued keys in an object: '' | undefined | null → null.
 * Numbers are passed through as-is (use toNum separately for numeric fields).
 * Trims whitespace from strings and converts blank strings to null.
 */
function sanitizeBody(obj) {
  if (!obj || typeof obj !== "object") return {};
  const result = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === undefined || v === null) {
      result[key] = null;
    } else if (typeof v === "string") {
      result[key] = v.trim() === "" ? null : v.trim();
    } else {
      result[key] = v;
    }
  }
  return result;
}

/**
 * Sanitizes an array of item objects.
 * Applies sanitizeBody to each item object.
 * Returns [] if input is not a valid array.
 */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => sanitizeBody(item));
}

module.exports = { emptyToNull, toNum, sanitizeBody, sanitizeItems };

