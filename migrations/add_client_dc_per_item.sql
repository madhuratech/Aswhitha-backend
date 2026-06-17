-- Migration: Add client_dc_no and client_dc_date per item
-- Run this once against your MySQL database.
-- These columns allow each line item in a DC or Invoice to carry its own
-- Client DC reference, enabling multiple Client DCs to appear in one format.

ALTER TABLE sales_dc_items
    ADD COLUMN IF NOT EXISTS client_dc_no  VARCHAR(100) NULL AFTER remarks,
    ADD COLUMN IF NOT EXISTS client_dc_date DATE         NULL AFTER client_dc_no;

ALTER TABLE service_dc_items
    ADD COLUMN IF NOT EXISTS client_dc_no  VARCHAR(100) NULL AFTER remarks,
    ADD COLUMN IF NOT EXISTS client_dc_date DATE         NULL AFTER client_dc_no;

ALTER TABLE salesinvoice_items
    ADD COLUMN IF NOT EXISTS client_dc_no  VARCHAR(100) NULL AFTER amount,
    ADD COLUMN IF NOT EXISTS client_dc_date DATE         NULL AFTER client_dc_no;

ALTER TABLE service_invoice_items
    ADD COLUMN IF NOT EXISTS client_dc_no  VARCHAR(100) NULL AFTER amount,
    ADD COLUMN IF NOT EXISTS client_dc_date DATE         NULL AFTER client_dc_no;
