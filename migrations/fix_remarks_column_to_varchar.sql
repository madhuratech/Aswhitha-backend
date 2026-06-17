-- Migration: Change remarks column from ENUM to VARCHAR in all DC/invoice item tables
-- Run once against MySQL. The ENUM type was silently truncating free-text remarks values.

ALTER TABLE sales_dc_items
    MODIFY COLUMN remarks VARCHAR(500) NULL;

ALTER TABLE service_dc_items
    MODIFY COLUMN remarks VARCHAR(500) NULL;
