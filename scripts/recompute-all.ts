#!/usr/bin/env tsx
/** Recompute aggregates for every brand in shade_signatures. */
import "dotenv/config";
import { getSupabase } from "../src/supabase/client.js";
import { recomputeShadeAggregate } from "../src/supabase/recompute.js";

const sb = getSupabase();

const skipBrand = process.argv.slice(2).find(a => a.startsWith("--skip="))?.slice(7);

const { data: brands, error } = await sb
  .from("shade_signatures")
  .select("brand")
  .order("brand");
if (error) { console.error(error); process.exit(1); }

const distinctBrands = [...new Set((brands ?? []).map((b: any) => b.brand as string))]
  .filter(b => b !== skipBrand);

console.log(`Recomputing ${distinctBrands.length} brands${skipBrand ? ` (skipping ${skipBrand})` : ""}`);

for (const brand of distinctBrands) {
  const { data: shades } = await sb
    .from("shade_signatures").select("id, shade_name").eq("brand", brand).order("shade_name");
  console.log(`\n${brand} (${shades?.length ?? 0} shades)`);
  let done = 0;
  for (const s of shades ?? []) {
    await recomputeShadeAggregate((s as any).id);
    done++;
    if (done % 25 === 0 || done === shades?.length) {
      console.log(`  [${done}/${shades?.length}]`);
    }
  }
}

console.log("\nDone.");
