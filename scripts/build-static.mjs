/**
 * Build static assets into public/ for zero-cold-start Vercel CDN deployment.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_HTML } from "../packages/agent-gateway/src/landing_html.mjs";
import { COCKPIT_HTML } from "../packages/agent-gateway/src/cockpit_html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.resolve(rootDir, "public");

fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

fs.writeFileSync(path.resolve(publicDir, "index.html"), LANDING_HTML, "utf8");
fs.writeFileSync(path.resolve(publicDir, "cockpit.html"), COCKPIT_HTML, "utf8");
fs.writeFileSync(path.resolve(publicDir, "app.html"), COCKPIT_HTML, "utf8");
// Published contract binary, re-hashed in the browser on /cockpit#verify
fs.copyFileSync(
  path.resolve(rootDir, "artifacts/emet_settlement_contract.wasm"),
  path.resolve(publicDir, "emet_settlement_contract.wasm")
);
fs.writeFileSync(
  path.resolve(publicDir, "robots.txt"),
  "User-agent: *\nAllow: /\n",
  "utf8"
);

console.log("✅ EMET static assets generated in public/ for Vercel deployment.");
