-- Add use case billing columns to commission_reports so one report row covers both
-- order commission and AI use case fees for a billing period.
ALTER TABLE commission_reports
  ADD COLUMN IF NOT EXISTS use_case_count  INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS use_case_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
