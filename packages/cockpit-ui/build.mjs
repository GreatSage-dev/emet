/**
 * Production Build & Verification Script for Emet Cockpit UI (`npm run build`)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcHtmlPath = path.join(__dirname, "index.html");
const distDir = path.join(__dirname, "dist");
const distHtmlPath = path.join(distDir, "index.html");

const html = fs.readFileSync(srcHtmlPath, "utf8");

// Deterministic structural assertions on the Cockpit UI bundle
const requiredMarkers = [
  "EMET // אמת",
  "v1.signer-prod.testnet",
  "SvmFinality::Finalized",
  "FunctionCall(emet.near::initiate_intent)",
  "f53a1a864fa9ce51d50349b2e5fe38ff23e45b25b20038d405c12316f9bf05b1",
  "2ab97999d1e015730271c7d6cbb298af76fd1de7af81926b42a8877bc4f5794e",
];

for (const marker of requiredMarkers) {
  if (!html.includes(marker)) {
    throw new Error(`UI build verification failed: missing marker "${marker}"`);
  }
}

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(distHtmlPath, html, "utf8");

console.log(`[emet-cockpit-ui] Built and verified ${distHtmlPath} (${Buffer.byteLength(html)} bytes)`);
