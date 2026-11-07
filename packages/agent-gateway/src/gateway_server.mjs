/**
 * Emet Agent Settlement Gateway — HTTP REST Server & Multi-Tenant Agent API
 * Exposes Emet double-entry budget ledger, counterparty risk engine, and 1Click quote proxy.
 */
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import {
  EmetKernelSimulator,
  fetchIntentsDryQuote,
  computeForeignTxPayloadHashV1,
  evaluateDualBrainPipeline,
  MPC_SIGNER_CONTRACT,
} from "./index.mjs";
import { callNearViewFunction } from "./near_testnet.mjs";
import { COCKPIT_HTML } from "./cockpit_html.mjs";
import { LANDING_HTML } from "./landing_html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTNET_MANIFEST_PATH = path.resolve(__dirname, "../../../testnet-deployment.json");

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

  kernel.upsertCounterparty({
    receiverId: "new-gpu-node.near",
    accountAgeDays: 14,
    isContract: true,
    codeChangedRecently: true,
    priorSuccessfulSettlements: 2,
    reportedMaliciousBy: [],
  });

  const tokenToAgentMap = new Map([
    ["token_alpha_treasury_session", "alpha-treasury.near"],
    ["token_beta_striker_session", "beta-striker.near"],
    ["token_owner_wallet_session", "owner.near"],
    ["token_admin_root_session", "admin.near"],
  ]);

  const ownerAuthorizedTokens = new Set([
    "token_owner_wallet_session",
    "token_admin_root_session",
  ]);

  const server = createServer(async (req, res) => {
    // CORS & JSON headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Owner-Authorization, x-agent-id"
    );

    const method = req.method || "GET";
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";

    // Authentication Helper: strict separation between Agent session and Human Owner key
    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const ownerHeader = req.headers["x-owner-authorization"] || "";
    const ownerToken = ownerHeader.replace(/^Bearer\s+/i, "").trim();
    const isOwnerAuthorized =
      ownerAuthorizedTokens.has(bearerToken) || ownerAuthorizedTokens.has(ownerToken);
    const callerAgentId = tokenToAgentMap.get(bearerToken) || req.headers["x-agent-id"] || null;

    if (method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LANDING_HTML);
      return;
    }

    if (method === "GET" && pathname === "/cockpit") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(COCKPIT_HTML);
      return;
    }

    // ROUTE 1: Gateway Health & MPC Status
    if (method === "GET" && pathname === "/api/health") {
      const hasManifest = fs.existsSync(TESTNET_MANIFEST_PATH);
      const manifest = hasManifest
        ? JSON.parse(fs.readFileSync(TESTNET_MANIFEST_PATH, "utf8"))
        : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "emet-agent-gateway",
          mpcSigner: MPC_SIGNER_CONTRACT,
          testnetContractId: manifest?.contractId || null,
          activeAgents: ["alpha-treasury.near", "beta-striker.near"],
        })
      );
      return;
    }

    // ROUTE 1B: Live NEAR Testnet Contract Deployment & On-Chain State Probe
    if (method === "GET" && pathname === "/api/testnet/status") {
      if (!fs.existsSync(TESTNET_MANIFEST_PATH)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deployed: false, error: "testnet-deployment.json not found" }));
        return;
      }
      const manifest = JSON.parse(fs.readFileSync(TESTNET_MANIFEST_PATH, "utf8"));
      let liveRpcLedger = null;
      let liveRpcSource = "cached-manifest";
      try {
        liveRpcLedger = await callNearViewFunction({
          contractId: manifest.contractId,
          methodName: "get_agent_ledger",
          args: { agent_id: manifest.contractId },
          timeoutMs: 2500,
        });
        if (liveRpcLedger && liveRpcLedger.agent_id) {
          liveRpcSource = "live-near-testnet-rpc";
        }
      } catch {
        // Offline fallback to verified manifest snapshot
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          deployed: true,
          source: liveRpcSource,
          contractId: manifest.contractId,
          codeHash: manifest.codeHash,
          mpcSignerContractId: manifest.mpcSignerContractId,
          mpcForeignTxDomainId: manifest.mpcForeignTxDomainId,
          explorerAccountUrl: manifest.explorerAccountUrl,
          transactions: manifest.transactions,
          liveOnChainLedger: liveRpcLedger || manifest.verifiedOnChainState?.agentLedger || null,
          verifiedIntents: {
            ghostRefund: manifest.verifiedOnChainState?.ghostIntent || null,
            bnbSettled: manifest.verifiedOnChainState?.bnbIntent || null,
          },
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

    // ROUTE 7B: Update Agent Mission Parameters (Owner Policy Control — Strictly Forbidden for Agent Tokens)
    const missionMatch = pathname.match(/^\/api\/agents\/([^/]+)\/mission$/);
    if (method === "PUT" && missionMatch) {
      if (!enableNaiveBypass && !isOwnerAuthorized) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Forbidden: Autonomous agent sessions cannot modify owner spending policies. Requires human owner wallet authorization.",
          })
        );
        return;
      }
      const targetAgentId = decodeURIComponent(missionMatch[1]);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const updated = kernel.updateAgentMission({
            agentId: targetAgentId,
            ...parsed,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "updated", ledger: updated }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ROUTE 7C: Two-Brain Clean-Room Evaluation & Automatic Escrow Lock on ALLOW
    if (method === "POST" && pathname === "/api/dual-brain/evaluate") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const params = JSON.parse(body || "{}");
          if (!enableNaiveBypass && params.humanApprovedOverride && !isOwnerAuthorized) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "forbidden",
                error:
                  "Forbidden: Agent session cannot self-approve WARN overrides. Requires separate human owner authorization.",
              })
            );
            return;
          }
          const trace = await evaluateDualBrainPipeline({
            kernel,
            agentId: params.agentId || "alpha-treasury.near",
            untrustedExternalText: params.untrustedExternalText || "",
            proposedTx: params.proposedTx || {},
            humanApprovedOverride: Boolean(params.humanApprovedOverride),
          });

          let lockedIntent = null;
          if (trace.brain2Conscience.verdict === "ALLOW") {
            const p = trace.glassWall.passedToBrain2;
            if (params.humanApprovedOverride) {
              // Owner explicitly approved this counterparty via OutLayer tasks::confirm
              const agentObj = kernel.agents.get(trace.agentId);
              if (agentObj) agentObj.allowedCounterparties.add(p.receiverId);
              kernel.upsertCounterparty({
                receiverId: p.receiverId,
                accountAgeDays: 14,
                isContract: true,
                codeChangedRecently: false,
                priorSuccessfulSettlements: 5,
              });
            }
            const chain = p.targetChain || "Solana";
            const foreignTxSpec =
              chain === "Solana"
                ? {
                    chain: "Solana",
                    txIdHex: "11".repeat(64),
                    finality: "Finalized",
                    extractors: [
                      { type: "InnerInstruction", instructionIndex: 2, innerInstructionIndex: 0 },
                    ],
                    values: [
                      {
                        kind: "SvmInnerInstruction",
                        programIdHex: "33".repeat(32),
                        accountsHex: ["44".repeat(32), "55".repeat(32)],
                        dataHex: "deadbeef",
                      },
                    ],
                  }
                : chain === "Bitcoin"
                ? {
                    chain: "Bitcoin",
                    txIdHex: "55".repeat(32),
                    confirmations: 6,
                    extractors: [{ type: "BlockHash" }],
                    values: [{ kind: "BitcoinBlockHash", blockHashHex: "2a".repeat(32) }],
                  }
                : {
                    chain,
                    txIdHex: "642441b3f1bebd9951b09e3fdedee8e03c304e48a1cca726039cfecea9082a05",
                    finality: "Finalized",
                    extractors: [{ type: "BlockHash" }],
                    values: [
                      {
                        kind: "EvmBlockHash",
                        blockHashHex:
                          "9978b780d86d964d76ea8ec6db5c0f5f1c350a7f93ea5c97f25fb468ea1b2b1d",
                      },
                    ],
                  };

            lockedIntent = kernel.initiateIntent({
              intentId: `intent-${p.nonce}-${Date.now().toString(36)}`,
              agentId: trace.agentId,
              counterpartyId: p.receiverId,
              amount: p.amountIn,
              nonce: p.nonce,
              foreignTxSpec,
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: trace.brain2Conscience.verdict,
              trace,
              lockedIntent,
            })
          );
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: err.message }));
        }
      });
      return;
    }

    // ROUTE 7D: List Intents & Reconcile Foreign Outcome (Settle or Snapback Refund)
    if (method === "GET" && pathname === "/api/intents") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ intents: [...kernel.intents.values()].reverse() }));
      return;
    }

    if (method === "POST" && pathname === "/api/intents/reconcile") {
      if (!enableNaiveBypass && !isOwnerAuthorized) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Forbidden: Agent session cannot forge MPC settlement callbacks. Requires MPC callback / owner authorization.",
          })
        );
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const { intentId, verdict } = JSON.parse(body || "{}");
          const receipt = kernel.reconcileForeignOutcome({
            callerId: "emet.near",
            intentId,
            verdict,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "reconciled", receipt }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
        server.listen(port, () => {
          resolve(`http://localhost:${port}`);
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
