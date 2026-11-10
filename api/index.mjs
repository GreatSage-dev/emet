import { createEmetRequestHandler } from "../packages/agent-gateway/src/gateway_server.mjs";

const emetHandler = createEmetRequestHandler();

export default async function handler(req, res) {
  try {
    return await emetHandler(req, res);
  } catch (err) {
    console.error("EMET Vercel Function error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", detail: err?.message || "Unknown error" }));
    }
  }
}
