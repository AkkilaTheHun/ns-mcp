import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

// ============================================================
// THEME TOOL — read/duplicate/edit theme sections & blocks
// ============================================================
// Two layers of an OS 2.0 theme:
//   1. Capability layer — sections/*.liquid + blocks/*.liquid carry a
//      {% schema %} JSON declaring settings, accepted block types,
//      max_blocks and presets. The `catalog` action parses these.
//   2. Content layer — templates/*.json and sections/*-group.json declare
//      which section instances live on a page, their setting values, and
//      the blocks inside them. add_section/add_block/update_settings/remove
//      surgically edit these JSON files, validated against layer 1.
//
// Workflow: always `duplicate` first, edit the copy, `preview_url`, then
// `publish` to swap it live. Mutating actions refuse to touch the published
// (MAIN) theme unless allowLive:true is passed.

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (d: unknown): ToolResult => ({ content: [{ type: "text", text: typeof d === "string" ? d : toText(d) }] });
const fail = (m: string): ToolResult => ({ content: [{ type: "text", text: m }], isError: true });

const numericId = (gid: string): string => gid.split("/").pop() ?? gid;
const toGid = (id: string): string => (id.startsWith("gid://") ? id : `gid://shopify/OnlineStoreTheme/${id}`);

// --- low-level file IO -------------------------------------------------

const READ_FILES = `query($id:ID!,$names:[String!]!){theme(id:$id){files(filenames:$names){nodes{filename size body{...on OnlineStoreThemeFileBodyText{content}}}}}}`;
const UPSERT = `mutation($themeId:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){themeFilesUpsert(themeId:$themeId,files:$files){upsertedThemeFiles{filename}userErrors{filename code message}}}`;

interface FileNode { filename: string; size?: string; body?: { content?: string } }

async function readFiles(themeGid: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // chunk to keep Shopify response sizes reasonable (section files are large)
  for (let i = 0; i < names.length; i += 8) {
    const slice = names.slice(i, i + 8);
    const res = await shopifyGraphQL<{ theme: { files: { nodes: FileNode[] } } }>(READ_FILES, { id: themeGid, names: slice });
    for (const n of res.data?.theme?.files?.nodes ?? []) {
      if (typeof n.body?.content === "string") out.set(n.filename, n.body.content);
    }
  }
  return out;
}

async function readFile(themeGid: string, name: string): Promise<string | null> {
  const m = await readFiles(themeGid, [name]);
  return m.get(name) ?? null;
}

async function writeFile(themeGid: string, name: string, content: string): Promise<void> {
  const res = await shopifyGraphQL<{ themeFilesUpsert: { userErrors: Array<{ field?: string[]; message: string }> } }>(
    UPSERT, { themeId: themeGid, files: [{ filename: name, body: { type: "TEXT", value: content } }] });
  throwIfUserErrors(res.data?.themeFilesUpsert?.userErrors, "themeFilesUpsert");
}

async function listFilenames(themeGid: string, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let after: string | undefined;
  do {
    const res = await shopifyGraphQL<{ theme: { files: { nodes: Array<{ filename: string }>; pageInfo: { hasNextPage: boolean; endCursor: string } } } }>(
      `query($id:ID!,$after:String){theme(id:$id){files(first:250,after:$after){nodes{filename}pageInfo{hasNextPage endCursor}}}}`,
      { id: themeGid, after });
    const conn = res.data?.theme?.files;
    for (const n of conn?.nodes ?? []) if (n.filename.startsWith(prefix)) names.push(n.filename);
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : undefined;
  } while (after);
  return names;
}

// --- theme metadata / safety ------------------------------------------

async function getThemeMeta(themeGid: string): Promise<{ id: string; name: string; role: string } | null> {
  const res = await shopifyGraphQL<{ theme: { id: string; name: string; role: string } | null }>(
    `query($id:ID!){theme(id:$id){id name role}}`, { id: themeGid });
  return res.data?.theme ?? null;
}

async function assertEditable(themeGid: string, allowLive: boolean): Promise<void> {
  const meta = await getThemeMeta(themeGid);
  if (!meta) throw new Error(`Theme not found: ${themeGid}`);
  if (meta.role === "MAIN" && !allowLive) {
    throw new Error(`Refusing to edit the published (MAIN) theme "${meta.name}". Duplicate it first (action:"duplicate"), edit the copy, preview, then publish. Pass allowLive:true to override.`);
  }
}

// --- schema parsing ----------------------------------------------------

interface BlockDef { type: string; name?: string; settings?: Array<Record<string, unknown>> }
interface SectionSchema {
  name?: string;
  settings?: Array<Record<string, unknown>>;
  blocks?: BlockDef[];
  max_blocks?: number;
  presets?: Array<{ name?: string; settings?: Record<string, unknown>; blocks?: Array<{ type: string; settings?: Record<string, unknown> }> }>;
}

export function extractSchema(liquid: string): SectionSchema | null {
  const m = liquid.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// id of a setting => its definition (skips header/paragraph dividers which have no id)
export function settingIds(settings?: Array<Record<string, unknown>>): Set<string> {
  const s = new Set<string>();
  for (const def of settings ?? []) if (typeof def.id === "string") s.add(def.id);
  return s;
}

function summariseSettings(settings?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return (settings ?? [])
    .filter((d) => typeof d.id === "string")
    .map((d) => {
      const out: Record<string, unknown> = { id: d.id, type: d.type };
      if (d.default !== undefined) out.default = d.default;
      if (Array.isArray(d.options)) out.options = (d.options as Array<{ value: unknown }>).map((o) => o.value);
      return out;
    });
}

// classify a section's accepted block types
export function acceptedBlocks(schema: SectionSchema): { named: string[]; theme: boolean; app: boolean } {
  const named: string[] = [];
  let theme = false, app = false;
  for (const b of schema.blocks ?? []) {
    if (b.type === "@theme") theme = true;
    else if (b.type === "@app") app = true;
    else named.push(b.type);
  }
  return { named, theme, app };
}

// --- catalog cache (per theme, parses every section/block schema) ------

interface Catalog {
  sections: Record<string, { name?: string; settingCount: number; accepts: string[]; maxBlocks?: number; presetCount: number; localBlocks: string[] }>;
  themeBlocks: string[];
}
const catalogCache = new Map<string, Catalog>();

async function buildCatalog(themeGid: string): Promise<Catalog> {
  const sectionFiles = (await listFilenames(themeGid, "sections/")).filter((f) => f.endsWith(".liquid"));
  const blockFiles = (await listFilenames(themeGid, "blocks/")).filter((f) => f.endsWith(".liquid"));
  const contents = await readFiles(themeGid, sectionFiles);

  const sections: Catalog["sections"] = {};
  for (const f of sectionFiles) {
    const type = f.replace(/^sections\//, "").replace(/\.liquid$/, "");
    const schema = extractSchema(contents.get(f) ?? "");
    if (!schema) continue;
    const ab = acceptedBlocks(schema);
    const accepts: string[] = [...ab.named];
    if (ab.theme) accepts.push("@theme");
    if (ab.app) accepts.push("@app");
    sections[type] = {
      name: schema.name,
      settingCount: settingIds(schema.settings).size,
      accepts,
      maxBlocks: schema.max_blocks,
      presetCount: schema.presets?.length ?? 0,
      localBlocks: ab.named,
    };
  }
  const themeBlocks = blockFiles
    .map((f) => f.replace(/^blocks\//, "").replace(/\.liquid$/, ""))
    .filter((n) => !n.startsWith("_")); // _ blocks are private (nested-only)

  const catalog: Catalog = { sections, themeBlocks };
  catalogCache.set(themeGid, catalog);
  return catalog;
}

async function getCatalog(themeGid: string, refresh = false): Promise<Catalog> {
  if (!refresh && catalogCache.has(themeGid)) return catalogCache.get(themeGid)!;
  return buildCatalog(themeGid);
}

async function getSectionSchema(themeGid: string, type: string): Promise<SectionSchema> {
  const liquid = await readFile(themeGid, `sections/${type}.liquid`);
  if (liquid === null) throw new Error(`Section type not found: sections/${type}.liquid`);
  const schema = extractSchema(liquid);
  if (!schema) throw new Error(`Section sections/${type}.liquid has no parseable {% schema %}`);
  return schema;
}

// --- JSON template helpers ---------------------------------------------

interface BlockInstance { type: string; settings?: Record<string, unknown>; disabled?: boolean; blocks?: Record<string, BlockInstance>; block_order?: string[] }
interface SectionInstance { type: string; settings?: Record<string, unknown>; blocks?: Record<string, BlockInstance>; block_order?: string[]; disabled?: boolean; name?: string }
interface TemplateJson { sections: Record<string, SectionInstance>; order: string[]; [k: string]: unknown }

export function parseTemplate(content: string, file: string): TemplateJson {
  let json: TemplateJson;
  try { json = JSON.parse(content); } catch (e) { throw new Error(`${file} is not valid JSON: ${String(e)}`); }
  if (!json.sections || !Array.isArray(json.order)) {
    throw new Error(`${file} is not a section-bearing JSON file (missing "sections"/"order"). add/update/remove only work on templates/*.json and sections/*-group.json.`);
  }
  return json;
}

export function genId(type: string): string {
  const base = type.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "item";
  const rand = Math.random().toString(36).slice(2, 9);
  return `${base}_${rand}`;
}

export function isAppBlock(type: string): boolean {
  return type.startsWith("shopify://apps/") || type === "@app";
}

export function registerThemeGateway(server: McpServer): void {
  server.tool(
    "shopify_theme",
    `Read and edit Online Store theme sections & blocks. Always duplicate, edit, preview, then publish.
- list_themes: List all themes with id/name/role (the MAIN one is published/live)
- duplicate: Copy a theme (params: sourceThemeId?=published MAIN, name?) → returns new UNPUBLISHED themeId
- catalog: Parse the theme's section/block schemas (params: themeId, sectionType?, refresh?). No sectionType → relational index of every section + accepted block types + theme blocks. With sectionType → that section's full settings, local block defs, max_blocks, presets.
- get_template: Read a content JSON file (params: themeId, file e.g. "templates/index.json" or "sections/footer-group.json")
- add_section: Add a section instance to a template (params: themeId, file, type, settings?, index?). Seeds settings from schema defaults + first preset.
- add_block: Add a block to a section instance (params: themeId, file, sectionId, blockType, settings?, index?). Validates blockType is accepted + max_blocks.
- update_settings: Change setting values on a section or block (params: themeId, file, sectionId, blockId?, settings). Hard-fails on unknown setting ids.
- remove: Remove a section or block instance (params: themeId, file, sectionId, blockId?)
- preview_url: Get the storefront preview URL (params: themeId)
- publish: Make a theme the live MAIN theme (params: themeId)
- delete: Delete a theme (params: themeId)
Mutating actions refuse the published MAIN theme unless allowLive:true.`,
    {
      action: z.enum(["list_themes", "duplicate", "catalog", "get_template", "add_section", "add_block", "update_settings", "remove", "preview_url", "publish", "delete"]),
      themeId: z.string().optional().describe("Theme id or GID to operate on"),
      sourceThemeId: z.string().optional().describe("duplicate: theme to copy (defaults to the published MAIN theme)"),
      name: z.string().optional().describe("duplicate: name for the new theme"),
      file: z.string().optional().describe("Content JSON file, e.g. templates/index.json or sections/footer-group.json"),
      sectionType: z.string().optional().describe("catalog: section type to describe in full"),
      type: z.string().optional().describe("add_section: the section type to add (a file in sections/)"),
      sectionId: z.string().optional().describe("Instance id of a section within the file (key in its `sections` object)"),
      blockType: z.string().optional().describe("add_block: block type — a theme block name, a local block type, or shopify://apps/.../<uuid>"),
      blockId: z.string().optional().describe("Instance id of a block within a section"),
      settings: z.record(z.string(), z.unknown()).optional().describe("Setting id → value map"),
      index: z.number().optional().describe("Insertion position in order/block_order (default: append)"),
      refresh: z.boolean().optional().describe("catalog: rebuild instead of using cache"),
      allowLive: z.boolean().optional().describe("Permit editing the published MAIN theme (dangerous)"),
    },
    async ({ action, ...p }) => {
      const allowLive = p.allowLive ?? false;
      switch (action) {
        case "list_themes": {
          const res = await shopifyGraphQL(`{themes(first:50){nodes{id name role updatedAt}}}`);
          return text(res.data);
        }

        case "duplicate": {
          let src = p.sourceThemeId;
          if (!src) {
            const r = await shopifyGraphQL<{ themes: { nodes: Array<{ id: string; role: string }> } }>(`{themes(first:50){nodes{id role}}}`);
            src = r.data?.themes?.nodes?.find((t) => t.role === "MAIN")?.id;
            if (!src) return fail("Could not find the published MAIN theme to duplicate.");
          }
          const res = await shopifyGraphQL<{ themeDuplicate: { newTheme: unknown; userErrors: Array<{ field?: string[]; message: string }> } }>(
            `mutation($id:ID!,$name:String){themeDuplicate(id:$id,name:$name){newTheme{id name role}userErrors{field message}}}`,
            { id: toGid(src), name: p.name });
          throwIfUserErrors(res.data?.themeDuplicate?.userErrors, "themeDuplicate");
          return text(res.data?.themeDuplicate?.newTheme);
        }

        case "catalog": {
          if (!p.themeId) return fail("themeId required");
          const gid = toGid(p.themeId);
          if (p.sectionType) {
            const schema = await getSectionSchema(gid, p.sectionType);
            const ab = acceptedBlocks(schema);
            return text({
              type: p.sectionType,
              name: schema.name,
              maxBlocks: schema.max_blocks,
              settings: summariseSettings(schema.settings),
              acceptsBlocks: [...ab.named, ...(ab.theme ? ["@theme (any theme block)"] : []), ...(ab.app ? ["@app"] : [])],
              localBlockDefs: (schema.blocks ?? [])
                .filter((b) => !b.type.startsWith("@"))
                .map((b) => ({ type: b.type, name: b.name, settings: summariseSettings(b.settings) })),
              presets: (schema.presets ?? []).map((pr) => ({ name: pr.name, blocks: pr.blocks?.map((b) => b.type) })),
            });
          }
          const cat = await getCatalog(gid, p.refresh);
          return text(cat);
        }

        case "get_template": {
          if (!p.themeId || !p.file) return fail("themeId and file required");
          const content = await readFile(toGid(p.themeId), p.file);
          if (content === null) return fail(`File not found: ${p.file}`);
          return text(content);
        }

        case "add_section": {
          if (!p.themeId || !p.file || !p.type) return fail("themeId, file and type required");
          const gid = toGid(p.themeId);
          await assertEditable(gid, allowLive);
          const schema = await getSectionSchema(gid, p.type);
          const content = await readFile(gid, p.file);
          if (content === null) return fail(`File not found: ${p.file}`);
          const tpl = parseTemplate(content, p.file);

          // seed settings: schema defaults < first preset settings < user-provided
          const seeded: Record<string, unknown> = {};
          for (const def of schema.settings ?? []) if (typeof def.id === "string" && def.default !== undefined) seeded[def.id] = def.default;
          const preset = schema.presets?.[0];
          if (preset?.settings) Object.assign(seeded, preset.settings);
          if (p.settings) Object.assign(seeded, p.settings);

          const inst: SectionInstance = { type: p.type, settings: seeded };
          // seed preset blocks if the preset defines any
          if (preset?.blocks?.length) {
            inst.blocks = {};
            inst.block_order = [];
            for (const b of preset.blocks) {
              const bid = genId(b.type);
              inst.blocks[bid] = { type: b.type, settings: b.settings ?? {} };
              inst.block_order.push(bid);
            }
          }
          const id = genId(p.type);
          tpl.sections[id] = inst;
          const at = p.index ?? tpl.order.length;
          tpl.order.splice(at, 0, id);
          await writeFile(gid, p.file, JSON.stringify(tpl, null, 2));
          return text({ added: id, type: p.type, file: p.file, settings: seeded, blocks: inst.block_order ?? [] });
        }

        case "add_block": {
          if (!p.themeId || !p.file || !p.sectionId || !p.blockType) return fail("themeId, file, sectionId and blockType required");
          const gid = toGid(p.themeId);
          await assertEditable(gid, allowLive);
          const content = await readFile(gid, p.file);
          if (content === null) return fail(`File not found: ${p.file}`);
          const tpl = parseTemplate(content, p.file);
          const sec = tpl.sections[p.sectionId];
          if (!sec) return fail(`No section instance "${p.sectionId}" in ${p.file}. Existing: ${Object.keys(tpl.sections).join(", ")}`);

          const schema = await getSectionSchema(gid, sec.type);
          const ab = acceptedBlocks(schema);
          const bt = p.blockType;
          let allowed = ab.named.includes(bt);
          if (!allowed && ab.app && isAppBlock(bt)) allowed = true;
          if (!allowed && ab.theme && !isAppBlock(bt)) {
            const cat = await getCatalog(gid);
            if (cat.themeBlocks.includes(bt)) allowed = true;
          }
          if (!allowed) {
            const opts = [...ab.named, ...(ab.theme ? ["<any theme block>"] : []), ...(ab.app ? ["<app blocks>"] : [])];
            return fail(`Block type "${bt}" is not accepted by section "${sec.type}". Accepted: ${opts.join(", ") || "(none — this section takes no blocks)"}`);
          }
          const order = sec.block_order ?? Object.keys(sec.blocks ?? {});
          if (typeof schema.max_blocks === "number" && order.length >= schema.max_blocks) {
            return fail(`Section "${sec.type}" allows at most ${schema.max_blocks} blocks; it already has ${order.length}.`);
          }
          sec.blocks = sec.blocks ?? {};
          const bid = genId(bt.startsWith("shopify://") ? "app" : bt);
          sec.blocks[bid] = { type: bt, settings: p.settings ?? {} };
          const newOrder = [...order];
          newOrder.splice(p.index ?? newOrder.length, 0, bid);
          sec.block_order = newOrder;
          await writeFile(gid, p.file, JSON.stringify(tpl, null, 2));
          return text({ added: bid, blockType: bt, sectionId: p.sectionId, file: p.file, settings: p.settings ?? {}, block_order: newOrder });
        }

        case "update_settings": {
          if (!p.themeId || !p.file || !p.sectionId || !p.settings) return fail("themeId, file, sectionId and settings required");
          const gid = toGid(p.themeId);
          await assertEditable(gid, allowLive);
          const content = await readFile(gid, p.file);
          if (content === null) return fail(`File not found: ${p.file}`);
          const tpl = parseTemplate(content, p.file);
          const sec = tpl.sections[p.sectionId];
          if (!sec) return fail(`No section instance "${p.sectionId}" in ${p.file}`);
          const schema = await getSectionSchema(gid, sec.type);

          if (p.blockId) {
            const blk = sec.blocks?.[p.blockId];
            if (!blk) return fail(`No block "${p.blockId}" in section "${p.sectionId}"`);
            // validate against the block's local def if present (app/theme blocks aren't locally introspectable here)
            const def = (schema.blocks ?? []).find((b) => b.type === blk.type);
            if (def) {
              const valid = settingIds(def.settings);
              const bad = Object.keys(p.settings).filter((k) => !valid.has(k));
              if (bad.length) return fail(`Unknown setting(s) for block "${blk.type}": ${bad.join(", ")}. Valid: ${[...valid].join(", ")}`);
            }
            blk.settings = { ...(blk.settings ?? {}), ...p.settings };
          } else {
            const valid = settingIds(schema.settings);
            const bad = Object.keys(p.settings).filter((k) => !valid.has(k));
            if (bad.length) return fail(`Unknown setting(s) for section "${sec.type}": ${bad.join(", ")}. Valid: ${[...valid].join(", ")}`);
            sec.settings = { ...(sec.settings ?? {}), ...p.settings };
          }
          await writeFile(gid, p.file, JSON.stringify(tpl, null, 2));
          return text({ updated: p.blockId ? `${p.sectionId}/${p.blockId}` : p.sectionId, file: p.file, settings: p.settings });
        }

        case "remove": {
          if (!p.themeId || !p.file || !p.sectionId) return fail("themeId, file and sectionId required");
          const gid = toGid(p.themeId);
          await assertEditable(gid, allowLive);
          const content = await readFile(gid, p.file);
          if (content === null) return fail(`File not found: ${p.file}`);
          const tpl = parseTemplate(content, p.file);
          const sec = tpl.sections[p.sectionId];
          if (!sec) return fail(`No section instance "${p.sectionId}" in ${p.file}`);
          if (p.blockId) {
            if (!sec.blocks?.[p.blockId]) return fail(`No block "${p.blockId}" in section "${p.sectionId}"`);
            delete sec.blocks[p.blockId];
            sec.block_order = (sec.block_order ?? []).filter((b) => b !== p.blockId);
            await writeFile(gid, p.file, JSON.stringify(tpl, null, 2));
            return text({ removed: `${p.sectionId}/${p.blockId}`, file: p.file });
          }
          delete tpl.sections[p.sectionId];
          tpl.order = tpl.order.filter((s) => s !== p.sectionId);
          await writeFile(gid, p.file, JSON.stringify(tpl, null, 2));
          return text({ removed: p.sectionId, file: p.file });
        }

        case "preview_url": {
          if (!p.themeId) return fail("themeId required");
          const res = await shopifyGraphQL<{ shop: { primaryDomain: { url: string } } }>(`{shop{primaryDomain{url}}}`);
          const base = res.data?.shop?.primaryDomain?.url ?? "";
          return text({ themeId: toGid(p.themeId), preview_url: `${base}/?preview_theme_id=${numericId(toGid(p.themeId))}` });
        }

        case "publish": {
          if (!p.themeId) return fail("themeId required");
          const res = await shopifyGraphQL<{ themePublish: { theme: unknown; userErrors: Array<{ field?: string[]; message: string }> } }>(
            `mutation($id:ID!){themePublish(id:$id){theme{id name role}userErrors{field message}}}`, { id: toGid(p.themeId) });
          throwIfUserErrors(res.data?.themePublish?.userErrors, "themePublish");
          return text(res.data?.themePublish?.theme);
        }

        case "delete": {
          if (!p.themeId) return fail("themeId required");
          const gid = toGid(p.themeId);
          const meta = await getThemeMeta(gid);
          if (meta?.role === "MAIN") return fail(`Refusing to delete the published MAIN theme "${meta.name}".`);
          const res = await shopifyGraphQL<{ themeDelete: { deletedThemeId: string; userErrors: Array<{ field?: string[]; message: string }> } }>(
            `mutation($id:ID!){themeDelete(id:$id){deletedThemeId userErrors{field message}}}`, { id: gid });
          throwIfUserErrors(res.data?.themeDelete?.userErrors, "themeDelete");
          return text({ deleted: res.data?.themeDelete?.deletedThemeId });
        }

        default:
          return fail(`Unknown action: ${action}`);
      }
    },
  );
}
