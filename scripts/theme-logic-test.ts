// No-network test of the theme tool's JSON-surgery + schema validation logic.
import { extractSchema, acceptedBlocks, settingIds, parseTemplate, genId, isAppBlock, stripJsonComments } from "../src/mcp/tools/theme.js";

let pass = 0, failn = 0;
const ok = (name: string, cond: boolean, extra = "") => { cond ? pass++ : failn++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

// 1. extractSchema handles {%- schema -%} whitespace variants + real JSON
const liquidA = `<div>markup</div>\n{%- schema -%}\n{"name":"X","blocks":[{"type":"@theme"},{"type":"@app"}],"max_blocks":3,"settings":[{"type":"text","id":"title"},{"type":"header","content":"h"}]}\n{%- endschema -%}`;
const schemaA = extractSchema(liquidA)!;
ok("extractSchema parses {%- -%} variant", !!schemaA && schemaA.name === "X");
ok("settingIds skips id-less header", settingIds(schemaA.settings).size === 1 && settingIds(schemaA.settings).has("title"));
const abA = acceptedBlocks(schemaA);
ok("acceptedBlocks detects @theme + @app", abA.theme && abA.app && abA.named.length === 0);

// real number-counter schema (verbatim subset) — local named block "counter"
const nc = extractSchema(`{% schema %}{"name":"t:sections.number-counter.name","settings":[{"type":"range","id":"columns","min":1,"max":5,"default":4,"label":"x"}],"blocks":[{"type":"counter","name":"c","settings":[{"type":"text","id":"number","default":"100"},{"type":"text","id":"unit"}]}],"presets":[{"name":"nc","blocks":[{"type":"counter","settings":{"number":"150","unit":"K+"}}]}]}{% endschema %}`)!;
const abNC = acceptedBlocks(nc);
ok("number-counter accepts local 'counter' block", abNC.named.includes("counter") && !abNC.theme);
ok("extractSchema returns null when no schema", extractSchema("just markup") === null);

// 2. parseTemplate guards non-section JSON
let guarded = false;
try { parseTemplate(`{"foo":1}`, "x.json"); } catch { guarded = true; }
ok("parseTemplate rejects non-section JSON", guarded);
const tpl = parseTemplate(`{"sections":{"nc1":{"type":"number-counter","blocks":{"b1":{"type":"counter","settings":{"number":"1"}}},"block_order":["b1"],"settings":{"columns":4}}},"order":["nc1"]}`, "templates/index.json");
ok("parseTemplate accepts valid template", tpl.order[0] === "nc1");
// JSONC: real Shopify templates lead with a /* ... */ banner comment
const banner = `/*\n * IMPORTANT: auto-generated.\n */\n{"sections":{"s1":{"type":"x","settings":{}}},"order":["s1"]}`;
ok("stripJsonComments removes leading banner", stripJsonComments(banner).startsWith("{"));
ok("parseTemplate parses JSONC banner template", parseTemplate(banner, "templates/index.json").order[0] === "s1");
ok("stripJsonComments preserves shopify:// in values", parseTemplate(`${banner.replace('"settings":{}', '"settings":{"link":"shopify://collections/x"}')}`, "t.json").sections.s1.settings!.link === "shopify://collections/x");

// 3. genId / isAppBlock
ok("genId shape <type>_<rand>", /^number_counter_[a-z0-9]{7}$/.test(genId("number-counter")));
ok("isAppBlock detects app urls", isAppBlock("shopify://apps/x/blocks/y/uuid") && isAppBlock("@app") && !isAppBlock("counter"));

// 4. simulate add_block validation against number-counter (max_blocks unlimited here)
function canAddBlock(schema: any, blockType: string, currentCount: number, themeBlocks: string[]): { allowed: boolean; reason?: string } {
  const ab = acceptedBlocks(schema);
  let allowed = ab.named.includes(blockType);
  if (!allowed && ab.app && isAppBlock(blockType)) allowed = true;
  if (!allowed && ab.theme && !isAppBlock(blockType) && themeBlocks.includes(blockType)) allowed = true;
  if (!allowed) return { allowed: false, reason: "type not accepted" };
  if (typeof schema.max_blocks === "number" && currentCount >= schema.max_blocks) return { allowed: false, reason: "max_blocks" };
  return { allowed: true };
}
ok("add_block: allows accepted local block", canAddBlock(nc, "counter", 1, []).allowed);
ok("add_block: rejects unaccepted block", !canAddBlock(nc, "heading", 1, ["heading"]).allowed);
ok("add_block: @theme section allows known theme block", canAddBlock(schemaA, "heading", 0, ["heading", "text"]).allowed);
ok("add_block: @theme section rejects unknown theme block", !canAddBlock(schemaA, "bogus", 0, ["heading"]).allowed);
ok("add_block: enforces max_blocks", !canAddBlock(schemaA, "heading", 3, ["heading"]).allowed && canAddBlock(schemaA, "heading", 2, ["heading"]).allowed);
ok("add_block: @app section accepts app url", canAddBlock(schemaA, "shopify://apps/a/blocks/b/uuid", 0, []).allowed);

// 5. simulate the actual mutation round-trips through JSON
const sec = tpl.sections.nc1;
const bid = genId("counter");
sec.blocks![bid] = { type: "counter", settings: { number: "42" } };
sec.block_order = [...(sec.block_order ?? []), bid];
const round = JSON.parse(JSON.stringify(tpl));
ok("add_block round-trips through JSON", round.sections.nc1.block_order.length === 2 && round.sections.nc1.blocks[bid].settings.number === "42");

// update_settings unknown-key rejection (section level)
const validKeys = settingIds(nc.settings);
ok("update_settings rejects unknown section key", !validKeys.has("bogus") && validKeys.has("columns"));

console.log(`\n${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
