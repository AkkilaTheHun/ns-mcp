/**
 * signature-check — does description parsing rediscover, without any
 * brand knowledge, the discriminators that were previously hand-written?
 *
 *   pnpm tsx scripts/signature-check.ts [data/<collection>.json]
 */
import { readFileSync } from "fs";
import { parseAll, discriminate } from "../src/vision/signature.js";

const FILE = process.argv[2] ?? "data/halloween-2026.json";
const data = JSON.parse(readFileSync(FILE, "utf-8"));
const sigs = parseAll(
  Object.fromEntries(
    Object.entries<any>(data.shades).map(([k, v]) => [
      k,
      { vendorDescription: v.vendorDescription, polishType: v.polishType },
    ]),
  ),
);
console.log("=== parsed facts ===\n");
for (const s of sigs) {
  console.log(s.shade);
  for (const f of s.facts) console.log(`   ${f.attribute.padEnd(8)} ${f.value.padEnd(9)} "${f.source}"`);
  console.log();
}

console.log("=== auto-derived discriminators (hard attributes only) ===\n");
const found = new Map<string, string[]>();
for (let i = 0; i < sigs.length; i++) {
  for (let j = i + 1; j < sigs.length; j++) {
    const d = discriminate(sigs[i], sigs[j]);
    if (!d.length) continue;
    const key = [sigs[i].shade, sigs[j].shade].sort().join(" | ");
    found.set(key, d.map((x) => `${x.attribute}: ${Object.entries(x.values).map(([s, v]) => `${s}=${v}`).join(", ")}`));
  }
}
for (const [k, v] of found) { console.log(k); for (const line of v) console.log(`   ${line}`); }

console.log(`\n=== vs the ${data._discrimination.confusablePairs.length} hand-written pairs ===\n`);
let hit = 0;
for (const p of data._discrimination.confusablePairs) {
  const key = [...p.pair].sort().join(" | ");
  const got = found.get(key);
  if (got) { hit++; console.log(`FOUND    ${key}\n   hand: ${p.discriminator}\n   auto: ${got.join(" ; ")}`); }
  else console.log(`MISSED   ${key}\n   hand: ${p.discriminator}`);
}
console.log(`\n${hit}/${data._discrimination.confusablePairs.length} hand-written pairs rediscovered; ${found.size} pairs separated in total`);
