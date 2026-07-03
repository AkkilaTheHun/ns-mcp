#!/usr/bin/env tsx
/** Re-run recomputeShadeAggregate on every shade for a brand. */
import "dotenv/config";
import { getSupabase } from "../src/supabase/client.js";
import { recomputeShadeAggregate } from "../src/supabase/recompute.js";

const brand = process.argv[2];
if (!brand) { console.error("Usage: tsx scripts/recompute-brand.ts <brand>"); process.exit(1); }
const sb = getSupabase();
const { data: shades, error } = await sb.from("shade_signatures").select("id, shade_name").eq("brand", brand).order("shade_name");
if (error) { console.error(error); process.exit(1); }
console.log(`Recomputing ${shades?.length ?? 0} shades for "${brand}"...`);
for (const s of shades ?? []) {
  await recomputeShadeAggregate(s.id);
  console.log(` ✓ ${s.shade_name}`);
}
