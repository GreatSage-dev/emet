/**
 * King's Court Rule 8.12: Smoke Sanity Gate.
 * Boots in-memory gateway and verifies that core HTTP endpoints and routes
 * return expected HTTP 200/302 codes and never 500 errors.
 */
import assert from "node:assert/strict";
import { createEmetGatewayServer } from "../packages/agent-gateway/src/gateway_server.mjs";

export async function runSmoke() {
  console.log("================================================================================");
  console.log(" KING'S COURT: FAST SMOKE SANITY GATE (RULE 8.12)");
  console.log("================================================================================");

  const port = 4921;
  const server = createEmetGatewayServer({ port });
  const baseUrl = await server.start();

  try {
    // 1. Landing Page
    const r1 = await fetch(`${baseUrl}/`);
    assert.equal(r1.status, 200);
    console.log(`  ✅ GET / -> 200 OK (${r1.headers.get("content-type")})`);

    // 2. Cockpit App
    const r2 = await fetch(`${baseUrl}/cockpit`);
    assert.equal(r2.status, 200);
    console.log(`  ✅ GET /cockpit -> 200 OK`);

    // 3. Adversarial /rob Honeypot Redirect
    const r3 = await fetch(`${baseUrl}/rob`, { redirect: "manual" });
    assert.equal(r3.status, 302);
    assert.equal(r3.headers.get("location"), "/cockpit#break");
    console.log(`  ✅ GET /rob -> 302 Redirect to /cockpit#break`);

    // 4. API Health
    const r4 = await fetch(`${baseUrl}/api/health`);
    assert.equal(r4.status, 200);
    const healthJson = await r4.json();
    assert.equal(healthJson.status, "ok");
    console.log(`  ✅ GET /api/health -> 200 OK (service: ${healthJson.service})`);

    // 5. Testnet Status
    const r5 = await fetch(`${baseUrl}/api/testnet/status`);
    assert.equal(r5.status, 200);
    const testnetJson = await r5.json();
    assert.equal(testnetJson.contractId, "emet-v2-mwab6fsl.testnet");
    console.log(`  ✅ GET /api/testnet/status -> 200 OK (${testnetJson.contractId})`);

    // 6. Dual-Brain Pipeline Evaluation
    const r6 = await fetch(`${baseUrl}/api/dual-brain/evaluate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token_alpha_treasury_session",
      },
      body: JSON.stringify({
        agentId: "alpha-treasury.near",
        untrustedExternalText: "Pay 50 USDC for GPU compute",
        proposedTx: {
          counterpartyId: "solver-prime.near",
          amount: "50000000",
          amountOut: "49500000",
          tokenIn: "nep141:usdc.near",
          tokenOut: "solana:USDC",
          chain: "Solana",
          nonce: 1,
        },
      }),
    });
    assert.equal(r6.status, 200);
    const evalJson = await r6.json();
    assert.equal(evalJson.status, "ALLOW");
    console.log(`  ✅ POST /api/dual-brain/evaluate -> 200 OK (status: ${evalJson.status})`);

    console.log("--------------------------------------------------------------------------------");
    console.log("🎯 RESULT: 6 of 6 endpoints verified clean (0 errors, 0 HTTP 500s).");
    console.log("--------------------------------------------------------------------------------\n");
  } finally {
    await server.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("smoke.mjs")) {
  runSmoke().catch((e) => {
    console.error("Smoke check failed:", e);
    process.exit(1);
  });
}
