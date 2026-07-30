-- The business address, printed on invoices and the year-end export.
-- Free text: a mailing address is not worth a column per line.
ALTER TABLE "Agency" ADD COLUMN "businessAddress" TEXT;
