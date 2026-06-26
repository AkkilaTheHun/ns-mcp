import "dotenv/config";
import { shopifyGraphQL } from "../src/shopify/client.js";

const SHOP = "nailstuff-ca.myshopify.com";
const THEME = "gid://shopify/OnlineStoreTheme/149649490073"; // published MAIN (read-only)

function extractSchema(liquid: string): any | null {
  const m = liquid.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function accepted(schema: any) {
  const named: string[] = []; let theme = false, app = false;
  for (const b of schema.blocks ?? []) {
    if (b.type === "@theme") theme = true; else if (b.type === "@app") app = true; else named.push(b.type);
  }
  return [...named, ...(theme ? ["@theme"] : []), ...(app ? ["@app"] : [])];
}

async function readFiles(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < names.length; i += 8) {
    const res = await shopifyGraphQL<any>(
      `query($id:ID!,$names:[String!]!){theme(id:$id){files(filenames:$names){nodes{filename body{...on OnlineStoreThemeFileBodyText{content}}}}}}`,
      { id: THEME, names: names.slice(i, i + 8) }, SHOP);
    for (const n of res.data.theme.files.nodes) if (n.body?.content) out.set(n.filename, n.body.content);
  }
  return out;
}
async function listFilenames(prefix: string): Promise<string[]> {
  const names: string[] = []; let after: string | undefined;
  do {
    const res = await shopifyGraphQL<any>(
      `query($id:ID!,$after:String){theme(id:$id){files(first:250,after:$after){nodes{filename}pageInfo{hasNextPage endCursor}}}}`,
      { id: THEME, after }, SHOP);
    const c = res.data.theme.files;
    for (const n of c.nodes) if (n.filename.startsWith(prefix)) names.push(n.filename);
    after = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : undefined;
  } while (after);
  return names;
}

(async () => {
  const sectionFiles = (await listFilenames("sections/")).filter((f) => f.endsWith(".liquid"));
  const contents = await readFiles(sectionFiles);
  let ok = 0, noSchema = 0;
  for (const f of sectionFiles) (extractSchema(contents.get(f) ?? "") ? ok++ : noSchema++);
  console.log(`CATALOG: ${sectionFiles.length} section files → ${ok} schemas parsed, ${noSchema} without schema`);

  const idx = JSON.parse((await readFiles(["templates/index.json"])).get("templates/index.json")!);
  console.log(`\nHOMEPAGE templates/index.json — ${idx.order.length} sections in order:`);
  for (const id of idx.order) {
    const s = idx.sections[id];
    const nb = s?.block_order?.length ?? Object.keys(s?.blocks ?? {}).length;
    console.log(`  ${id}  (type=${s?.type}${nb ? `, ${nb} blocks` : ""})`);
  }

  // Drill into anything that looks brand/collection related
  for (const id of idx.order) {
    const s = idx.sections[id];
    if (!s) continue;
    if (/collection|brand/i.test(s.type) || /brand/i.test(id)) {
      const schema = extractSchema(contents.get(`sections/${s.type}.liquid`) ?? "");
      console.log(`\n--- "${id}" type=${s.type} ---`);
      console.log(`  accepts blocks: ${schema ? accepted(schema).join(", ") || "(none)" : "?"}`);
      console.log(`  max_blocks: ${schema?.max_blocks ?? "unlimited"}`);
      console.log(`  setting keys set: ${Object.keys(s.settings ?? {}).join(", ")}`);
      if (s.block_order?.length) {
        console.log(`  blocks:`);
        for (const bid of s.block_order) {
          const b = s.blocks[bid];
          console.log(`    ${bid} type=${b.type} settings=${JSON.stringify(b.settings).slice(0, 160)}`);
        }
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
