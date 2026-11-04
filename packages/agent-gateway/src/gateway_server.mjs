/**
 * Emet Agent Settlement Gateway — HTTP REST Server & Multi-Tenant Agent API
 * Exposes Emet double-entry budget ledger, counterparty risk engine, and 1Click quote proxy.
 */
import { createServer } from "node:http";
import { URL } from "node:url";
import {
  EmetKernelSimulator,
  fetchIntentsDryQuote,
  computeForeignTxPayloadHashV1,
  MPC_SIGNER_CONTRACT,
} from "./index.mjs";

export function createEmetGatewayServer({
  port = 4173,
  kernel = new EmetKernelSimulator(),
  enableNaiveBypass = false,
} = {}) {
  // Pre-seed test agents
  kernel.registerAgent({
    agentId: "alpha-treasury.near",
    initialBudget: "50000000000", // 50,000.00 USDC
    maxPerTx: "10000000000",      // 10,000.00 USDC
    epochSpendCap: "25000000000", // 25,000.00 USDC
    allowedCounterparties: ["solver-prime.near", "1click-market.near"],
  });

  kernel.registerAgent({
    agentId: "beta-striker.near",
    initialBudget: "1000000000",  // 1,000.00 USDC
    maxPerTx: "500000000",        //   500.00 USDC
    epochSpendCap: "1000000000",  // 1,000.00 USDC
    allowedCounterparties: ["solver-prime.near"],
  });

  // Pre-seed known counterparties
  kernel.upsertCounterparty({
    receiverId: "solver-prime.near",
    accountAgeDays: 140,
    isContract: true,
    codeChangedRecently: false,
    priorSuccessfulSettlements: 24,
    reportedMaliciousBy: [],
  });

  kernel.upsertCounterparty({
    receiverId: "drainer-ghost.near",
    accountAgeDays: 1,
    isContract: false,
    codeChangedRecently: false,
    priorSuccessfulSettlements: 0,
    reportedMaliciousBy: [
      { reporterAgentId: "alpha-treasury.near", evidenceTxHash: "0xdeadbeef123" }
    ],
  });

  const tokenToAgentMap = new Map([
    ["token_alpha_treasury_session", "alpha-treasury.near"],
    ["token_beta_striker_session", "beta-striker.near"],
  ]);

  const server = createServer(async (req, res) => {
    // CORS & JSON headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-agent-id");

    const method = req.method || "GET";
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";

    // Authentication Helper
    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const callerAgentId = tokenToAgentMap.get(bearerToken) || req.headers["x-agent-id"] || null;

    // ROUTE 1: Gateway Health & MPC Status
    if (method === "GET" && pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "emet-agent-gateway",
          mpcSigner: MPC_SIGNER_CONTRACT,
          activeAgents: ["alpha-treasury.near", "beta-striker.near"],
        })
      );
      return;
    }

    // ROUTE 2: 1Click Dry Quote Proxy
    if (method === "GET" && pathname === "/api/quote") {
      const originAsset = parsedUrl.searchParams.get("originAsset") || "nep141:usdc.near";
      const destinationAsset =
        parsedUrl.searchParams.get("destinationAsset") ||
        "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const amount = parsedUrl.searchParams.get("amount") || "2500000000";

      const quote = await fetchIntentsDryQuote({ originAsset, destinationAsset, amount });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(quote));
      return;
    }

    // ROUTE 3: Agent Double-Entry Budget Ledger (IDOR / BOLA Target)
    const budgetMatch = pathname.match(/^\/api\/agents\/([^/]+)\/budget$/);
    if (method === "GET" && budgetMatch) {
      const targetAgentId = decodeURIComponent(budgetMatch[1]);

      // If caller is not authenticated at all
      if (!callerAgentId && !enableNaiveBypass) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Missing agent bearer token" }));
        return;
      }

      // Check Cross-Tenant Isolation (BOLA Defense)
      // When enableNaiveBypass is false (Emet Default), an agent cannot access another agent's budget
      if (!enableNaiveBypass && callerAgentId && callerAgentId !== targetAgentId) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Forbidden: Cross-tenant agent budget isolation enforced by Emet Shield.",
            authenticatedAgent: callerAgentId,
            targetAgent: targetAgentId,
          })
        );
        return;
      }

      // If enableNaiveBypass is true or authenticated agent matches:
      const ledger = kernel.getAgentLedger(targetAgentId);
      if (!ledger) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Agent not found: ${targetAgentId}` }));
        return;
      }

      // Sensitive Confidential Vault payload inside agent ledger
      const responseData = {
        ...ledger,
        confidentialVaultSeed: `CONFIDENTIAL_VAULT_KEY_${targetAgentId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
        status: "active",
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseData));
      return;
    }

    // ROUTE 4: Vulnerable Naive Endpoint for Exploit Proving
    // Exposes raw unshielded budget lookup when testing naive status quo
    const naiveBudgetMatch = pathname.match(/^\/api\/vulnerable\/agents\/([^/]+)\/budget$/);
    if (method === "GET" && naiveBudgetMatch) {
      const targetAgentId = decodeURIComponent(naiveBudgetMatch[1]);
      if (!callerAgentId) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      // Naive implementation: ignores whether callerAgentId === targetAgentId!
      const ledger = kernel.getAgentLedger(targetAgentId);
      if (!ledger) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...ledger,
          confidentialVaultSeed: `CONFIDENTIAL_VAULT_KEY_${targetAgentId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
          status: "active",
        })
      );
      return;
    }

    // ROUTE 5: Counterparty Reputation Evaluation
    const cpMatch = pathname.match(/^\/api\/counterparties\/([^/]+)$/);
    if (method === "GET" && cpMatch) {
      const cpId = decodeURIComponent(cpMatch[1]);
      const verdict = kernel.evaluateCounterparty(cpId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(verdict));
      return;
    }

    // ROUTE 6: Counterparty Update (PUT)
    if (method === "PUT" && cpMatch) {
      const cpId = decodeURIComponent(cpMatch[1]);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "updated",
              counterpartyId: cpId,
              accountAgeDays: parsed.accountAgeDays ?? 30,
              isContract: parsed.isContract ?? true,
              priorSuccessfulSettlements: parsed.priorSuccessfulSettlements ?? 0,
            })
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    // ROUTE 6B: Agent Account & Policy Profile Update (Mass Assignment Target & Shield)
    const profileMatch = pathname.match(/^\/api\/agents\/([^/]+)\/(profile|account)$/);
    if (method === "PUT" && profileMatch) {
      const targetAgentId = decodeURIComponent(profileMatch[1]);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          
          // Emet Shield Defense against Mass Assignment (OWASP API3 / BOPLA):
          // Reject client attempts to inject privileged role or financial limits unless authenticated as admin
          const privilegedKeys = ["role", "isAdmin", "epochSpendCap", "maxPerTx", "availableBalance"];
          const injectedPrivileged = privilegedKeys.filter((k) => k in parsed);

          if (!enableNaiveBypass && injectedPrivileged.length > 0 && callerAgentId !== "admin.near") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Forbidden: Mass assignment violation — Privileged field escalation rejected by Emet Shield.",
                injectedFields: injectedPrivileged,
                agentId: targetAgentId,
              })
            );
            return;
          }

          // Whitelisted profile fields allowed for self-service agent updates
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "updated",
              agentId: targetAgentId,
              displayName: parsed.displayName || targetAgentId,
              webhookUrl: parsed.webhookUrl || null,
              role: enableNaiveBypass && parsed.role ? parsed.role : "agent",
              isAdmin: enableNaiveBypass && parsed.isAdmin ? parsed.isAdmin : false,
              epochSpendCap: "10000000000",
            })
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }

    // ROUTE 7: Initiate Verified Intent
    if (method === "POST" && pathname === "/api/intents/initiate") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const params = JSON.parse(body);
          const intent = kernel.initiateIntent(params);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", intent }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "rejected", error: err.message }));
        }
      });
      return;
    }

    // ROUTE 8: Destructive Administrative Path (Safety Governor Target)
    if (pathname.startsWith("/api/admin/drain_funds") || pathname.startsWith("/api/admin/reset_ledger")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Administrative destructive action forbidden" }));
      return;
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Endpoint not found: ${pathname}` }));
  });

  return {
    server,
    start: () =>
      new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          resolve(`http://127.0.0.1:${port}`);
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

// Direct execution
const isDirect = Boolean(
  process.argv[1] && process.argv[1].endsWith("gateway_server.mjs")
);

if (isDirect) {
  const port = parseInt(process.env.PORT || "4173", 10);
  const gateway = createEmetGatewayServer({ port });
  gateway.start().then((url) => {
    console.log(`🛡️  EMET AGENT SETTLEMENT GATEWAY RUNNING: ${url}`);
  });
}
