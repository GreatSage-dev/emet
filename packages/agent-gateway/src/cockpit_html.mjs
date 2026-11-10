/**
 * EMET app (/cockpit): Vault, Pay, Break it, Verify, Connect.
 * Markup lives in ./ui/app.html, shared styles in ./ui/emet.css (inlined at load).
 */
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

export const EMET_CSS = read("./ui/emet.css");
export const COCKPIT_HTML = read("./ui/app.html").replace("/*EMET_CSS*/", () => EMET_CSS);
