/**
 * utils/supabase.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY: This file contains TWO Supabase clients with very different trust levels.
 *
 *  1. supabaseAdmin  — uses SERVICE_ROLE key. Bypasses Row-Level Security (RLS).
 *     USE ONLY for backend-to-backend operations where you've already validated
 *     the user's identity. NEVER send this client or its key to the frontend.
 *
 *  2. createUserClient(accessToken) — creates a client scoped to a specific
 *     authenticated user. Supabase enforces RLS automatically on every query,
 *     so a user can only read rows they own. Use this for all user-facing queries.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const logger           = require('./logger');

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY     = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Guard: fail loudly at startup if secrets are missing ─────────────────────
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    '[supabase.js] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env. ' +
    'The service will not start without them.'
  );
}

// ── 1. Admin client (service role) ───────────────────────────────────────────
// SECURITY: SERVICE_ROLE_KEY bypasses ALL RLS policies.
//   - Never expose this client or key to the frontend
//   - Only use after verifying user identity server-side via JWT
//   - Only for operations that require elevated access (bulk reads, admin tasks)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,   // Backend has no session to refresh
    persistSession:  false,    // Never persist sessions on the server
    detectSessionInUrl: false, // Not a browser
  },
  // Disable realtime — backend doesn't need push events
  realtime: { params: { eventsPerSecond: 0 } },
});

// ── 2. User-scoped client factory ────────────────────────────────────────────
// Creates a Supabase client that operates as a specific authenticated user.
// Supabase validates the JWT and applies RLS policies automatically.
// This means the user can only read/write rows they own (business_id / user_id).
//
// SECURITY: The accessToken here is the JWT we issued ourselves (from our own
// JWT_SECRET), NOT a Supabase-issued token. We pass it so Supabase can decode
// the `sub` (userId) from our token and apply our RLS policies that reference
// auth.uid(). For this to work, RLS policies must use auth.uid() or we pass
// the userId explicitly in queries using the admin client.
//
// In this project we use the admin client but ENFORCE ownership in the service
// layer (supabaseData.service.js), which is equally secure.
const createUserClient = (accessToken) => {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('[supabase.js] SUPABASE_ANON_KEY is required to create user clients');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken:   false,
      persistSession:     false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Pass the user's token so Supabase RLS can identify them
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
};

// ── 3. Health check helper ────────────────────────────────────────────────────
// Verifies connectivity to Supabase at startup. Logs a warning (does not crash)
// so the rest of the app remains functional even if Supabase is temporarily down.
const checkSupabaseConnection = async () => {
  try {
    // Minimal query — just check the connection
    const { error } = await supabaseAdmin
      .from('businesses')
      .select('id')
      .limit(1);

    if (error) {
      logger.warn('[supabase] Connection check warning', { err: error.message });
    } else {
      logger.info('[supabase] Connected to Supabase successfully');
    }
  } catch (err) {
    logger.warn('[supabase] Could not verify connection', { err: err.message });
  }
};

module.exports = { supabaseAdmin, createUserClient, checkSupabaseConnection };
