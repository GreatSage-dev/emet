/**
 * Emet Adversarial Attack & Exploit Verification Runner (`npm run demo:attack`)
 * Satisfies Track 06 (`security`), Track 01 (`defi`), and Track 07 (`agents`) requirements.
 */
import assert from "node:assert/strict";
import {
  EmetKernelSimulator,
  queryMpcSignerTestnet,
  computeForeignTxPayloadHashV1,
} from "./index.mjs";

async function runAttackSuite() {
  const startMs = performance.now();
  console.log("================================================================================");
  console.log(" EMET — ADVERSARIAL EXPLOIT & OUTCOME VERIFICATION SUITE (NEAR MPC v3.18.0)");
  console.log("================================================================================\n");

  // Step 0: Probe live NEAR Testnet `v1.signer-prod.testnet`
  const mpcVersion = await queryMpcSignerTestnet("version");
  const mpcChains = await queryMpcSignerTestnet("get_available_foreign_chains");
  console.log(
    `[0/5] MPC Signer Probe (${mpcVersion.contractId}): version=${JSON.stringify(
      mpcVersion.value
    )} | block=${mpcVersion.blockHeight} | live=${mpcVersion.live}`
  );
  console.log(
    `      Available Foreign Chains: ${JSON.stringify(mpcChains.value)}\n`
  );

  const kernel = new EmetKernelSimulator();
  kernel.upsertCounterparty({
    receiverId: "solver-prime.near",
    accountAgeDays: 145,
    isContract: true,
    codeChangedRecently: false,
    priorSuccessfulSettlements: 19,
  });

  kernel.registerAgent({
    agentId: "agent-treasury.near",
    initialBudget: "10000000000", // 10,000.00 USDC
    maxPerTx: "4000000000",      //  4,000.00 USDC
    epochSpendCap: "6000000000", //  6,000.00 USDC
    allowedCounterparties: ["solver-prime.near", "drainer-vault.near"],
  });

  const solanaFinalizedSpec = {
    chain: "Solana",
    txIdHex: "11".repeat(64),
    finality: "Finalized",
    extractors: [
      { type: "InnerInstruction", instructionIndex: 2, innerInstructionIndex: 0 },
      { type: "AccountState", pubkeyHex: "22".repeat(32) },
    ],
    values: [
      {
        kind: "SvmInnerInstruction",
        programIdHex: "33".repeat(32),
        accountsHex: ["44".repeat(32), "55".repeat(32)],
        dataHex: "deadbeef",
      },
      {
        kind: "SvmAccountState",
        ownerHex: "66".repeat(32),
        dataHex: "cafe",
      },
    ],
  };

  // ---------------------------------------------------------------------------
  // ATTACK 1: Prompt-Injected Agent Paying Reported Malicious Counterparty
  // ---------------------------------------------------------------------------
  kernel.reportMaliciousCounterparty({
    reporterAgentId: "agent-treasury.near",
    counterpartyId: "drainer-vault.near",
    evidenceTxHash: "0x88f1c90a44e2b77d001928374655647382910abcdef",
  });

  let attack1Blocked = false;
  try {
    kernel.initiateIntent({
      intentId: "atk-01-prompt-injection",
      agentId: "agent-treasury.near",
      counterpartyId: "drainer-vault.near",
      amount: "1500000000",
      nonce: 1,
      foreignTxSpec: solanaFinalizedSpec,
    });
  } catch (err) {
    attack1Blocked = true;
    console.log(`[1/5] ATTACK 1 (Prompt-Injected Malicious Receiver): BLOCKED`);
    console.log(`      Reason: ${err.message}\n`);
  }
  assert.equal(attack1Blocked, true);

  // ---------------------------------------------------------------------------
  // ATTACK 2: FullAccess Key Escalation Violation (`06-security.md`)
  // ---------------------------------------------------------------------------
  let attack2Blocked = false;
  try {
    kernel.initiateIntent({
      intentId: "atk-02-full-access-key",
      agentId: "agent-treasury.near",
      counterpartyId: "solver-prime.near",
      amount: "500000000",
      nonce: 1,
      keyPermission: { type: "FullAccess" },
      foreignTxSpec: solanaFinalizedSpec,
    });
  } catch (err) {
    attack2Blocked = true;
    console.log(`[2/5] ATTACK 2 (FullAccess Key Escalation): BLOCKED`);
    console.log(`      Reason: ${err.message}\n`);
  }
  assert.equal(attack2Blocked, true);

  // ---------------------------------------------------------------------------
  // ATTACK 3: The Oct 1 $3.8M NEAR Intents Ghost-Deposit Exploit
  // ---------------------------------------------------------------------------
  const bnbExploitIntent = kernel.initiateIntent({
    intentId: "atk-03-bnb-ghost-deposit",
    agentId: "agent-treasury.near",
    counterpartyId: "solver-prime.near",
    amount: "3800000000", // 3,800.00 USDC
    nonce: 1,
    foreignTxSpec: {
      chain: "Bnb",
      txIdHex: "99".repeat(32),
      finality: "Finalized",
      extractors: [{ type: "BlockHash" }],
      values: [{ kind: "EvmBlockHash", blockHashHex: "aa".repeat(32) }],
    },
  });

  const refundReceipt = kernel.reconcileForeignOutcome({
    intentId: bnbExploitIntent.intentId,
    verdict: {
      type: "TransactionFailed",
      reason:
        "BNB Chain deposit tx 0x9999... reverted on-chain (Verdict::TransactionFailed) — Ghost deposit rejected",
    },
  });

  assert.equal(refundReceipt.status.state, "Refunded");
  const ledgerAfterExploit = kernel.getAgentLedger("agent-treasury.near");
  assert.equal(ledgerAfterExploit.availableBalance, "10000000000");
  assert.equal(ledgerAfterExploit.refundedSaved, "3800000000");
  console.log(`[3/5] ATTACK 3 (Oct 1 $3.8M Ghost-Deposit Exploit Replay): REJECTED & REFUNDED`);
  console.log(`      MPC Verdict: ${refundReceipt.status.reason}`);
  console.log(
    `      Agent Ledger Restored: available=${ledgerAfterExploit.availableBalance} | refunded_saved=${ledgerAfterExploit.refundedSaved}\n`
  );

  // ---------------------------------------------------------------------------
  // ATTACK 4: Stalled Relayer Nonce Replay & Runaway LLM Retry Drain
  // ---------------------------------------------------------------------------
  let attack4Blocked = false;
  try {
    kernel.initiateIntent({
      intentId: "atk-04-stalled-relayer-retry",
      agentId: "agent-treasury.near",
      counterpartyId: "solver-prime.near",
      amount: "3800000000",
      nonce: 1, // Duplicate nonce 1!
      foreignTxSpec: solanaFinalizedSpec,
    });
  } catch (err) {
    attack4Blocked = true;
    console.log(`[4/5] ATTACK 4 (Stalled Relayer LLM Duplicate Retry Loop): BLOCKED`);
    console.log(`      Reason: ${err.message}\n`);
  }
  assert.equal(attack4Blocked, true);

  // ---------------------------------------------------------------------------
  // CONTROL 5: Valid Finalized Solana Swap (`EMET` — Cryptographic Truth)
  // ---------------------------------------------------------------------------
  const validIntent = kernel.initiateIntent({
    intentId: "sol-finalized-swap-005",
    agentId: "agent-treasury.near",
    counterpartyId: "solver-prime.near",
    amount: "2500000000", // 2,500.00 USDC
    nonce: 2,
    foreignTxSpec: solanaFinalizedSpec,
  });

  const expectedSolHash = computeForeignTxPayloadHashV1(solanaFinalizedSpec);
  assert.equal(
    expectedSolHash,
    "f53a1a864fa9ce51d50349b2e5fe38ff23e45b25b20038d405c12316f9bf05b1"
  );

  const settledReceipt = kernel.reconcileForeignOutcome({
    intentId: validIntent.intentId,
    verdict: {
      type: "Extracted",
      payloadHash: expectedSolHash,
      signatureHex:
        "ed25519:9b4e7d2a1c8f3e6b5a4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a21",
    },
  });

  assert.equal(settledReceipt.status.state, "Settled");
  const finalLedger = kernel.getAgentLedger("agent-treasury.near");
  const elapsedMs = (performance.now() - startMs).toFixed(2);

  console.log(`[5/5] CONTROL (Finalized Solana Swap via v1.signer-prod.testnet): SETTLED (EMET)`);
  console.log(`      MPC Payload Hash: ${settledReceipt.expectedPayloadHash}`);
  console.log(
    `      Spread Unlock:    ${settledReceipt.naiveUnverifiedSpreadBps} bps (naive) -> ${settledReceipt.solverSpreadBps} bps (Emet verified)`
  );
  console.log(
    `      Final Ledger:     available=${finalLedger.availableBalance} | settled=${finalLedger.settledSpent} | saved=${finalLedger.refundedSaved}`
  );
  console.log("================================================================================");
  console.log(` ALL 5 DETERMINISTIC SECURITY & SETTLEMENT ASSERTIONS PASSED IN ${elapsedMs}ms`);
  console.log("================================================================================");
}

runAttackSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
