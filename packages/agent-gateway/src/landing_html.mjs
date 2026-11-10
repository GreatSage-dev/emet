/**
 * EMET landing page (/): shared Hallmark limestone-ledger design with /cockpit.
 */
import fs from "node:fs";
import { EMET_CSS } from "./cockpit_html.mjs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

export const LANDING_HTML = read("./ui/landing.html").replace("/*EMET_CSS*/", () => EMET_CSS);
