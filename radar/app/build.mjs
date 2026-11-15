// dist/ = the radar screen (ui/) + the typing experiment and dashboard, built as for GitHub Pages (site/).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

execFileSync(process.execPath, ["../../tools/build-pages.mjs", "dist/site"], { stdio: "inherit" });
for (const f of ["index.html", "style.css", "main.js"]) fs.copyFileSync(`ui/${f}`, `dist/${f}`);
