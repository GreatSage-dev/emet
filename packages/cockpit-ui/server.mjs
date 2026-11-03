/**
 * Local Interactive Dev Server for Emet Split-Screen Cockpit (`npm run dev`)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchIntentsDryQuote, queryMpcSignerTestnet } from "../agent-gateway/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, "index.html");
const port = Number(process.env.PORT || 4173);

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/mpc-status") {
    const status = await queryMpcSignerTestnet("version");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }
  if (req.url === "/api/quote") {
    const quote = await fetchIntentsDryQuote();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(quote));
    return;
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(port, () => {
  console.log(`Emet Cockpit UI running at http://localhost:${port}`);
});
