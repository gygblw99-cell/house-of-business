-- Migration 021: unique index on z_report_shifts for ON CONFLICT support
--
-- importToDatabase uses ON CONFLICT (business_id, LOWER(employee_name), report_date)
-- but only a non-unique index existed, causing any INSERT with shift data to
-- throw "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". Without this index the shifts are silently not imported and
-- the `imported` counter is reported as 0 even though the sales row was saved.
--
-- Safe to run on existing data: LOWER() is deterministic; if duplicates already
-- exist the index creation will fail — run the cleanup query first if needed:
--   DELETE FROM z_report_shifts a USING z_report_shifts b
--   WHERE a.id > b.id
--     AND a.business_id = b.business_id
--     AND LOWER(a.employee_name) = LOWER(b.employee_name)
--     AND a.report_date = b.report_date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_z_report_shifts_uniq_biz_name_date
  ON z_report_shifts (business_id, LOWER(employee_name), report_date);
