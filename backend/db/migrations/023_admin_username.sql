-- Add username column to admin_users for username-based login.
-- NOTE: bootstrap.js performs this same work on every deploy; this file exists
-- for manual/local runs and is kept idempotent and consistent with it.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS username TEXT;

-- Backfill from the email local-part, lowercased to match the login handler.
-- Assigning every row 'admin' would violate the unique index whenever more
-- than one admin row exists, so collisions get a row-number suffix.
UPDATE admin_users AS u
   SET username = s.uname
  FROM (
    SELECT id,
           CASE WHEN rn = 1 THEN base ELSE base || rn::text END AS uname
      FROM (
        SELECT id,
               lower(split_part(email, '@', 1)) AS base,
               ROW_NUMBER() OVER (
                 PARTITION BY lower(split_part(email, '@', 1))
                 ORDER BY created_at
               ) AS rn
          FROM admin_users
         WHERE username IS NULL
      ) t
  ) AS s
 WHERE u.id = s.id;

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_key
  ON admin_users (username) WHERE username IS NOT NULL;
