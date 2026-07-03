#!/usr/bin/env tsx
/**
 * Build the shade-index visual test harness — a single self-contained HTML page
 * for eyeballing color/ΔE matching against the live catalog.
 *
 *   pnpm exec tsx scripts/build-delta-tester.ts          # regenerate tester/index.html
 *   pnpm exec tsx scripts/build-delta-tester.ts --open   # regenerate + open in browser
 *
 * Snapshots every shade_signatures row (base color LAB + one representative
 * image) into the page, so ranking runs client-side with no server. Rerun after
 * a recompute/backfill or when new shades are indexed to refresh the snapshot.
 *
 * As we add features to shade_index (new distance metrics, filters, attrs),
 * extend the UI here so there's always a visual way to validate them.
 *
 * Output (tester/index.html) is a generated artifact and is gitignored — the
 * generator is the source of truth, not its output.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getSupabase } from "../src/supabase/client.js";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tester");
const OUT_FILE = resolve(OUT_DIR, "index.html");

const sb = getSupabase();

const { data: shades, error } = await sb
  .from("shade_signatures")
  .select("id, brand, shade_name, base_color_hex, base_color_lab, finish_type, has_ultrachrome, has_holographic, has_iridescent, photo_count")
  .not("base_color_lab", "is", null)
  .order("brand")
  .order("shade_name");
if (error) { console.error(error); process.exit(1); }

// Page through ALL image rows (PostgREST caps each request at 1000).
type ImgRow = { shade_id: number; image_type: string | null; source_path: string };
const imgs: ImgRow[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error: iErr } = await sb
    .from("image_signatures")
    .select("shade_id, image_type, source_path")
    .like("source_path", "http%")
    .order("id")
    .range(from, from + 999);
  if (iErr) { console.error(iErr); process.exit(1); }
  if (!data || !data.length) break;
  imgs.push(...(data as ImgRow[]));
  if (data.length < 1000) break;
}

// Pick one representative image per shade: prefer on-nail swatch, then bottle, then macro.
const PREF: Record<string, number> = {
  swatch_on_nails: 1, bottle_in_hand: 2, macro_detail: 3, swatch_stick: 4, layering_demo: 5,
};
const bestImg = new Map<number, { rank: number; url: string }>();
for (const r of imgs) {
  const rank = PREF[r.image_type ?? ""] ?? 9;
  const cur = bestImg.get(r.shade_id);
  if (!cur || rank < cur.rank) bestImg.set(r.shade_id, { rank, url: r.source_path });
}

const data = (shades ?? []).map((s: any) => ({
  id: s.id,
  brand: s.brand,
  name: s.shade_name,
  hex: s.base_color_hex,
  lab: s.base_color_lab, // [L,a,b]
  finish: s.finish_type,
  uc: s.has_ultrachrome, holo: s.has_holographic, irid: s.has_iridescent,
  photos: s.photo_count,
  img: bestImg.get(s.id)?.url ?? null,
}));

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NailStuff — ΔE Color Match Tester</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#272b34; --txt:#e6e8ec; --dim:#9aa3b2; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); }
  header { padding:14px 18px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5; }
  h1 { font-size:16px; margin:0 0 2px; } .sub { color:var(--dim); font-size:12px; }
  code { color:#8fd0ff; }
  .wrap { display:grid; grid-template-columns:340px 1fr; gap:0; height:calc(100vh - 66px); }
  .col { overflow-y:auto; padding:14px; }
  .picker { border-right:1px solid var(--line); }
  input[type=search], input[type=number], input[type=text] { padding:8px 10px; background:var(--panel); border:1px solid var(--line); border-radius:8px; color:var(--txt); }
  input[type=search] { width:100%; }
  .item { display:flex; gap:10px; align-items:center; padding:6px; border-radius:8px; cursor:pointer; }
  .item:hover { background:var(--panel); }
  .item.sel { background:#233; outline:1px solid #3a6; }
  .thumb { width:44px; height:44px; border-radius:6px; object-fit:cover; background:#222; flex:0 0 auto; }
  .swatch { width:44px; height:44px; border-radius:6px; flex:0 0 auto; border:1px solid #0006; }
  .nm { font-weight:600; } .bd { color:var(--dim); font-size:12px; }
  .target { display:flex; gap:14px; align-items:center; padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:12px; margin-bottom:14px; }
  .target img, .target .swatch-lg { width:90px; height:90px; border-radius:10px; object-fit:cover; }
  .controls { display:flex; gap:14px; align-items:center; margin:6px 0 14px; flex-wrap:wrap; }
  .controls label { color:var(--dim); font-size:12px; display:flex; gap:6px; align-items:center; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .card .top { position:relative; height:120px; background:#222; }
  .card .top img { width:100%; height:100%; object-fit:cover; }
  .card .chip { position:absolute; left:8px; bottom:8px; width:26px; height:26px; border-radius:6px; border:1px solid #0008; }
  .card .de { position:absolute; right:8px; top:8px; padding:3px 7px; border-radius:20px; font-weight:700; font-size:12px; color:#000; }
  .card .meta { padding:8px 10px; } .card .meta .nm { font-size:13px; } .card .meta .bd { font-size:11px; }
  .fin { display:inline-block; margin-top:4px; font-size:11px; color:var(--dim); }
  .rank { display:inline-block; min-width:18px; color:var(--dim); font-size:11px; }
  .empty { color:var(--dim); padding:40px; text-align:center; }
  .legend { display:flex; gap:10px; align-items:center; font-size:11px; color:var(--dim); flex-wrap:wrap; }
  .dot { width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:3px; }
  .hexbox { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
</style></head>
<body>
<header>
  <h1>NailStuff — ΔE Color Match Tester</h1>
  <div class="sub">Pick a polish (or enter a hex/color name) on the left. Matches rank by hue-only ΔE (CIE76) on the aggregated base color — the exact metric <code>shade_index mode:"color"</code> uses. Lower ΔE = closer. Finish is shown but does <b>not</b> affect ranking.
    <span class="legend" style="margin-top:4px">
      <span><i class="dot" style="background:#57d97a"></i>&lt;3 identical</span>
      <span><i class="dot" style="background:#9ede5a"></i>&lt;6 very close</span>
      <span><i class="dot" style="background:#ffd25a"></i>&lt;12 same color</span>
      <span><i class="dot" style="background:#ff9d4d"></i>&lt;22 related</span>
      <span><i class="dot" style="background:#ff6b6b"></i>22+ different</span>
    </span>
  </div>
</header>
<div class="wrap">
  <div class="col picker">
    <div class="hexbox">
      <input id="picker" type="color" value="#5a8fc4" title="Pick any color" style="width:44px;height:38px;padding:2px;background:var(--panel);border:1px solid var(--line);border-radius:8px;cursor:pointer">
      <input id="hex" type="text" placeholder="#a8c5e8 or 'teal'" style="flex:1" autocomplete="off">
      <button id="hexgo" style="padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--txt);cursor:pointer">Match</button>
    </div>
    <input id="q" type="search" placeholder="…or search ${data.length} shades by name/brand" autocomplete="off">
    <div id="list" style="margin-top:10px"></div>
  </div>
  <div class="col results">
    <div id="target"></div>
    <div class="controls">
      <label>Max ΔE (family radius) <input id="maxde" type="number" value="25" min="1" max="120" style="width:70px"></label>
      <label><input id="samefin" type="checkbox"> same finish only</label>
      <span id="count" class="sub"></span>
    </div>
    <div id="matches" class="grid"></div>
  </div>
</div>
<script>
const SHADES = ${JSON.stringify(data)};
// Minimal color-name table (mirrors src/util/color.ts COLOR_NAMES for parity).
const COLOR_NAMES = ${JSON.stringify({
  "pastel blue":"#b5d3e7","light blue":"#aacae8","powder blue":"#c0d8e8","sky blue":"#7ab8d8","blue":"#5a8fc4","navy":"#1f3066","indigo":"#4858a0","periwinkle":"#a8b8e0",
  "pastel mint":"#c8e6d3","mint":"#a8e0c0","pastel teal":"#b8e3d6","teal":"#5fb5a8","turquoise":"#48c0bc","sage":"#a8c4a4","green":"#80b890","olive":"#808040",
  "pastel pink":"#f5c4d3","pink":"#f0a8c0","rose":"#e08098","magenta":"#d040a0","fuchsia":"#e060c0","red":"#c46060","burgundy":"#702030","maroon":"#702028","coral":"#f08070",
  "pastel purple":"#c5a8d3","purple":"#9070a8","lavender":"#c5a8d3","lilac":"#c5a8d3","violet":"#8060c0","plum":"#704060",
  "orange":"#e8a060","amber":"#d8a040","yellow":"#e8d060","gold":"#d4a040","copper":"#b46838","bronze":"#a06030","rose gold":"#d8a098","silver":"#c8c8c8",
  "white":"#f0f0f0","ivory":"#ece8d8","cream":"#e8e0c8","beige":"#d8c4a8","tan":"#c4a880","brown":"#80583a","charcoal":"#303030","black":"#202020","grey":"#b0b0b0","gray":"#b0b0b0",
})};
const deColor = de => de < 3 ? '#57d97a' : de < 6 ? '#9ede5a' : de < 12 ? '#ffd25a' : de < 22 ? '#ff9d4d' : '#ff6b6b';
const dE = (a,b) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);

// hex/name -> LAB, mirroring color.ts so the ad-hoc query matches the server.
function hexToRgb(h){ h=h.replace('#',''); if(h.length===3)h=h.split('').map(c=>c+c).join(''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function rgbToLab(r,g,b){
  let [R,G,B]=[r,g,b].map(v=>{v/=255; return v<=0.04045? v/12.92 : ((v+0.055)/1.055)**2.4;});
  let X=(R*0.4124+G*0.3576+B*0.1805)/0.95047, Y=(R*0.2126+G*0.7152+B*0.0722), Z=(R*0.0193+G*0.1192+B*0.9505)/1.08883;
  const f=t=>t>0.008856? Math.cbrt(t) : (7.787*t)+16/116;
  [X,Y,Z]=[f(X),f(Y),f(Z)];
  return [116*Y-16, 500*(X-Y), 200*(Y-Z)];
}
function parseColorToLab(input){
  const s=(input||'').trim().toLowerCase();
  if(!s) return null;
  if(s.startsWith('#')) { try{ return rgbToLab(...hexToRgb(s)); }catch{ return null; } }
  if(COLOR_NAMES[s]) return rgbToLab(...hexToRgb(COLOR_NAMES[s]));
  return null;
}

let target = null; // a shade object, OR an ad-hoc {name,hex,lab,adhoc:true}

const listEl = document.getElementById('list');
const qEl = document.getElementById('q');
function renderList() {
  const q = qEl.value.trim().toLowerCase();
  const rows = SHADES.filter(s => !q || (s.name+' '+s.brand).toLowerCase().includes(q)).slice(0, 400);
  listEl.innerHTML = rows.map(s => \`
    <div class="item \${target&&target.id===s.id?'sel':''}" data-id="\${s.id}">
      \${s.img ? \`<img class="thumb" loading="lazy" src="\${s.img}">\` : \`<div class="swatch" style="background:\${s.hex}"></div>\`}
      <div><div class="nm">\${s.name}</div><div class="bd">\${s.brand}</div></div>
    </div>\`).join('') || '<div class="empty">No matches</div>';
}
listEl.addEventListener('click', e => {
  const el = e.target.closest('.item'); if (!el) return;
  target = SHADES.find(s => s.id == el.dataset.id); renderList(); renderTarget(); renderMatches();
});
qEl.addEventListener('input', renderList);

function runHex(){
  const raw = document.getElementById('hex').value;
  const lab = parseColorToLab(raw);
  if(!lab){ alert('Enter a hex like #a8c5e8 or a known color name (blue, teal, coral, …)'); return; }
  target = { id:null, name:'"'+raw.trim()+'"', brand:'ad-hoc color query', hex: raw.trim().startsWith('#')?raw.trim():COLOR_NAMES[raw.trim().toLowerCase()], lab, finish:null, adhoc:true };
  renderList(); renderTarget(); renderMatches();
}
document.getElementById('hexgo').addEventListener('click', runHex);
document.getElementById('hex').addEventListener('keydown', e=>{ if(e.key==='Enter') runHex(); });
// Native color picker — live-updates matches as you drag the spectrum.
document.getElementById('picker').addEventListener('input', e=>{ document.getElementById('hex').value=e.target.value; runHex(); });

function finTxt(s){ const t=[s.finish]; if(s.holo)t.push('holo'); if(s.uc)t.push('ultrachrome'); if(s.irid)t.push('iridescent'); return t.filter(Boolean).join(' · ')||'—'; }

function renderTarget() {
  const t = document.getElementById('target');
  if (!target) { t.innerHTML = '<div class="empty">← Pick a polish, or enter a hex/color name, to see closest color matches</div>'; return; }
  const media = target.img ? \`<img src="\${target.img}">\` : \`<div class="swatch-lg swatch" style="background:\${target.hex}"></div>\`;
  t.innerHTML = \`<div class="target">\${media}
    <div>
      <div class="nm" style="font-size:18px">\${target.name}</div>
      <div class="bd">\${target.brand}</div>
      <div class="fin">\${target.adhoc?'':finTxt(target)+' · '}<span style="color:\${target.hex}">\${target.hex}</span> · LAB [\${target.lab.map(n=>n.toFixed(1)).join(', ')}]</div>
    </div></div>\`;
}
function renderMatches() {
  const box = document.getElementById('matches');
  if (!target) { box.innerHTML=''; document.getElementById('count').textContent=''; return; }
  const maxde = parseFloat(document.getElementById('maxde').value) || 999;
  const sameFin = document.getElementById('samefin').checked && !target.adhoc;
  let rows = SHADES.filter(s => s.id !== target.id)
    .map(s => ({ s, de: dE(target.lab, s.lab) }))
    .filter(r => r.de <= maxde)
    .filter(r => !sameFin || r.s.finish === target.finish)
    .sort((a,b) => a.de - b.de);
  document.getElementById('count').textContent = rows.length + ' within ΔE ' + maxde;
  box.innerHTML = rows.slice(0, 120).map((r,i) => \`
    <div class="card">
      <div class="top">
        \${r.s.img ? \`<img loading="lazy" src="\${r.s.img}">\` : ''}
        <div class="chip" style="background:\${r.s.hex}"></div>
        <div class="de" style="background:\${deColor(r.de)}">\${r.de.toFixed(1)}</div>
      </div>
      <div class="meta"><span class="rank">#\${i+1}</span> <span class="nm">\${r.s.name}</span>
        <div class="bd">\${r.s.brand}</div><div class="fin">\${finTxt(r.s)}</div></div>
    </div>\`).join('') || '<div class="empty">Nothing within that ΔE. Raise the radius.</div>';
}
document.getElementById('maxde').addEventListener('input', renderMatches);
document.getElementById('samefin').addEventListener('change', renderMatches);
renderList(); renderTarget();
</script>
</body></html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, html);
console.log(`Wrote ${OUT_FILE}  (${data.length} shades, ${[...bestImg.keys()].length} with images, ${imgs.length} image rows scanned, ${Math.round(html.length/1024)}KB)`);

if (process.argv.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { execFileSync(opener, [OUT_FILE]); console.log("Opened in browser."); }
  catch { console.log(`Open it manually: ${OUT_FILE}`); }
}
