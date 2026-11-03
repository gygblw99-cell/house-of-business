-- Migration 005: dish_ingredients table
-- מנות ומרכיבים ישירים

CREATE TABLE IF NOT EXISTS dishes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  selling_price NUMERIC(10,2) DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dish_recipes (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dish_id   UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
  qty       NUMERIC(10,3) NOT NULL DEFAULT 1,
  UNIQUE (dish_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS dish_ingredients (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dish_id           UUID NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  name              VARCHAR(255),
  qty               NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit              VARCHAR(50),
  manual_cost       NUMERIC(10,4)
);
