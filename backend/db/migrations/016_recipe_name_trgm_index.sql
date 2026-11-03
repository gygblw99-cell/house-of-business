-- Migration 016: GIN trigram index on recipes.name for fuzzy dish matching
-- Used by _syncDishesFromSaleItems step (ה) which runs similarity() against
-- all active recipes per business. Without this, each import does a full
-- sequential scan of recipes × unmatched sale_items.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX IF NOT EXISTS idx_recipes_name_trgm
  ON recipes USING GIN (
    (regexp_replace(trim(lower(name)), '\s+', ' ', 'g')) gin_trgm_ops
  );
