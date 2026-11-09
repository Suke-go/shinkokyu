// node tools/build-pages.mjs [outDir=_site] — static site for GitHub Pages (zero deps).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || "_site");
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), out, { recursive: true });
const dd = path.join(out, "data");
fs.mkdirSync(dd, { recursive: true });
fs.copyFileSync(path.join(root, "server/experiments.json"), path.join(dd, "experiments.json"));

const list = [];
const src = path.join(root, "data");
for (const f of fs.existsSync(src) ? fs.readdirSync(src) : []) {
  if (!/^[A-Za-z0-9_-]+(\.events\.jsonl|\.json)$/.test(f)) continue;
  fs.copyFileSync(path.join(src, f), path.join(dd, f));
  if (f.endsWith(".events.jsonl") || f === "experiments.json" || f === "index.json") continue;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
    let eventCount = m.eventCount;
    if (!Number.isInteger(eventCount)) {
      const ev = path.join(src, m.sessionId + ".events.jsonl");
      eventCount = fs.existsSync(ev) ? fs.readFileSync(ev, "utf8").split("\n").filter(Boolean).length : 0;
    }
    list.push({ sessionId: m.sessionId, expId: m.expId, participantId: m.participantId, startedAt: m.startedAt, endedAt: m.endedAt, eventCount, source: "bundled", _c: m.createdAt || m.startedAt || 0 });
  } catch { /* skip corrupt meta */ }
}
list.sort((a, b) => b._c - a._c);
fs.writeFileSync(path.join(dd, "index.json"), JSON.stringify(list.map(({ _c, ...x }) => x)));
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`built ${out} (${list.length} bundled sessions)`);
