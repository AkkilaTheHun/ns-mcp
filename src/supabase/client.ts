import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | undefined;

/**
 * Returns a singleton Supabase client. Reads SUPABASE_URL and SUPABASE_KEY
 * (service role preferred for server-side writes; anon works while RLS is off).
 * Throws on first call if the env vars are missing.
 */
export function getSupabase(): SupabaseClient {
  if (!cachedClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY) env vars must be set to use vector-catalog tools.",
      );
    }
    cachedClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedClient;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_KEY),
  );
}
