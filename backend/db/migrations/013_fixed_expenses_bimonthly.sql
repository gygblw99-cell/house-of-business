-- fixed_expenses.frequency's CHECK constraint never included 'bimonthly', even though
-- app validation, the UI, and VAT/finance calculations all already support it — saving
-- a bimonthly fixed expense crashes with a raw 500 (constraint violation).
ALTER TABLE fixed_expenses DROP CONSTRAINT IF EXISTS fixed_expenses_frequency_check;
ALTER TABLE fixed_expenses ADD CONSTRAINT fixed_expenses_frequency_check
  CHECK (frequency IN ('monthly','weekly','yearly','bimonthly','one_time'));
