import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeForeignTxPayloadHashV1,
  assertStrictFinality,
  EmetKernelSimulator,
  createEmetMcpTools,
  fetchIntentsDryQuote,
} from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmContractPath = path.resolve(
  __dirname,
  "../../../target/wasm32-unknown-unknown/release/emet_settlement_contract.wasm"
);

describe("Compiled Rust Smart Contract (.wasm) In-VM Execution", () => {
  it("instantiates emet_settlement_contract.wasm and passes all near/mpc + audit assertions in WASM VM", async () => {
    assert.equal(fs.existsSync(wasmContractPath), true, "Compiled .wasm binary must exist");
    const wasmBytes = fs.readFileSync(wasmContractPath);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const result = instance.exports.wasm_run_emet_verification_suite();
    assert.equal(result, 1);
  });
});

describe("Emet NEAR MPC v3.18.0 Wire & Snapshot Hash Parity", () => {
  it("computes byte-identical SHA-256 hash for Ethereum ForeignTxSignPayload::V1 snapshot", () => {
    const hash = computeForeignTxPayloadHashV1({
      chain: "Ethereum",
      txIdHex: "ab".repeat(32),
      finality: "Finalized",
      extractors: [{ type: "BlockHash" }],
      values: [{ kind: "EvmBlockHash", blockHashHex: "ef".repeat(32) }],
    });
    assert.equal(
      hash,
      "2ab97999d1e015730271c7d6cbb298af76fd1de7af81926b42a8877bc4f5794e"
    );
  });

  it("computes byte-identical SHA-256 hash for Solana ForeignTxSignPayload::V1 snapshot", () => {
    const hash = computeForeignTxPayloadHashV1({
      chain: "Solana",
      txIdHex: "11".repeat(64),
      finality: "Finalized",
      extractors: [
        {
          type: "InnerInstruction",
          instructionIndex: 2,
          innerInstructionIndex: 0,
        },
        {
          type: "AccountState",
          pubkeyHex: "22".repeat(32),
        },
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
    });
    assert.equal(
      hash,
      "f53a1a864fa9ce51d50349b2e5fe38ff23e45b25b20038d405c12316f9bf05b1"
    );
  });

  it("computes byte-identical SHA-256 hash for Bitcoin ForeignTxSignPayload::V1 snapshot", () => {
    const hash = computeForeignTxPayloadHashV1({
      chain: "Bitcoin",
      txIdHex: "55".repeat(32),
      confirmations: 6,
      extractors: [{ type: "BlockHash" }],
      values: [{ kind: "BitcoinBlockHash", blockHashHex: "2a".repeat(32) }],
    });
    assert.equal(
      hash,
      "08e426dcd6eb98cc5eb5280d50f9c14e024f4a531bd5e09314ac4ae8bb07c9be"
    );
  });

  it("rejects unfinalized Solana or EVM finality states", () => {
    assert.throws(
      () => assertStrictFinality({ chain: "Solana", finality: "Confirmed" }),
      /FINALITY_VIOLATION/
    );
    assert.throws(
      () => assertStrictFinality({ chain: "Bnb", finality: "Latest" }),
      /FINALITY_VIOLATION/
    );
    assert.throws(
      () => assertStrictFinality({ chain: "Bitcoin", confirmations: 2 }),
      /FINALITY_VIOLATION/
    );
  });
});

describe("Emet Settlement Kernel & Double-Entry Agent Budget Ledger", () => {
  function createInitializedKernel() {
    const kernel = new EmetKernelSimulator();
    kernel.upsertCounterparty({
      receiverId: "solver-prime.near",
      accountAgeDays: 120,
      isContract: true,
      codeChangedRecently: false,
      priorSuccessfulSettlements: 12,
    });
    kernel.registerAgent({
      agentId: "agent-alpha.near",
      initialBudget: "10000000000", // 10,000 USDC
      maxPerTx: "4000000000",      // 4,000 USDC
      epochSpendCap: "6000000000", // 6,000 USDC
      allowedCounterparties: ["solver-prime.near"],
    });
    return kernel;
  }

  const validSolanaSpec = {
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
  };

  it("moves funds to inFlightLocked on initiate and settles to settledSpent upon MPC proof", () => {
    const kernel = createInitializedKernel();
    const intent = kernel.initiateIntent({
      intentId: "intent-sol-001",
      agentId: "agent-alpha.near",
      counterpartyId: "solver-prime.near",
      amount: "2500000000",
      nonce: 1,
      foreignTxSpec: validSolanaSpec,
    });

    assert.equal(intent.status, "VerifyingOutcome");
    const midLedger = kernel.getAgentLedger("agent-alpha.near");
    assert.equal(midLedger.availableBalance, "7500000000");
    assert.equal(midLedger.inFlightLocked, "2500000000");
    assert.equal(midLedger.settledSpent, "0");

    const receipt = kernel.reconcileForeignOutcome({
      intentId: "intent-sol-001",
      verdict: {
        type: "Extracted",
        payloadHash: intent.expectedPayloadHash,
        signatureHex: "ed25519_sig_verified_by_v1_signer",
      },
    });

    assert.equal(receipt.status.state, "Settled");
    assert.equal(receipt.solverSpreadBps, 10);
    assert.equal(receipt.naiveUnverifiedSpreadBps, 200);

    const finalLedger = kernel.getAgentLedger("agent-alpha.near");
    assert.equal(finalLedger.availableBalance, "7500000000");
    assert.equal(finalLedger.inFlightLocked, "0");
    assert.equal(finalLedger.settledSpent, "2500000000");
  });

  it("blocks the Oct 1 $3.8M Ghost-Deposit Exploit (TransactionFailed) and refunds agent budget", () => {
    const kernel = createInitializedKernel();
    kernel.initiateIntent({
      intentId: "intent-bnb-oct1",
      agentId: "agent-alpha.near",
      counterpartyId: "solver-prime.near",
      amount: "3800000000",
      nonce: 1,
      foreignTxSpec: {
        chain: "Bnb",
        txIdHex: "99".repeat(32),
        finality: "Finalized",
        extractors: [{ type: "BlockHash" }],
        values: [{ kind: "EvmBlockHash", blockHashHex: "aa".repeat(32) }],
      },
    });

    const receipt = kernel.reconcileForeignOutcome({
      intentId: "intent-bnb-oct1",
      verdict: {
        type: "TransactionFailed",
        reason: "BNB Chain deposit transaction reverted — ghost deposit blocked",
      },
    });

    assert.equal(receipt.status.state, "Refunded");
    const ledger = kernel.getAgentLedger("agent-alpha.near");
    assert.equal(ledger.availableBalance, "10000000000");
    assert.equal(ledger.inFlightLocked, "0");
    assert.equal(ledger.settledSpent, "0");
    assert.equal(ledger.refundedSaved, "3800000000");
  });

  it("blocks FullAccess keys, prompt-injected malicious counterparties, and runaway nonce retries", async () => {
    const kernel = createInitializedKernel();

    // 1. FullAccess key rejected
    assert.throws(
      () =>
        kernel.initiateIntent({
          intentId: "intent-full-access",
          agentId: "agent-alpha.near",
          counterpartyId: "solver-prime.near",
          amount: "500000000",
          nonce: 1,
          keyPermission: { type: "FullAccess" },
          foreignTxSpec: validSolanaSpec,
        }),
      /FULL_ACCESS_KEY_FORBIDDEN/
    );

    // 2. Shared blocklist stops prompt-injected payment
    kernel.reportMaliciousCounterparty({
      reporterAgentId: "agent-alpha.near",
      counterpartyId: "drainer-vault.near",
      evidenceTxHash: "0xdeadbeef999",
    });

    assert.throws(
      () =>
        kernel.initiateIntent({
          intentId: "intent-injected",
          agentId: "agent-alpha.near",
          counterpartyId: "drainer-vault.near",
          amount: "500000000",
          nonce: 1,
          foreignTxSpec: validSolanaSpec,
        }),
      /COUNTERPARTY_BLOCKED/
    );

    // 3. MCP Tools work end-to-end
    const tools = createEmetMcpTools(kernel);
    const evalTool = tools.find((t) => t.name === "emet_evaluate_counterparty");
    const verdict = await evalTool.handler({ counterpartyId: "drainer-vault.near" });
    assert.equal(verdict.decision, "BLOCK");

    // 4. Dry-run quote calculates spread savings
    const quote = await fetchIntentsDryQuote({ amount: "2500000000", timeoutMs: 500 });
    assert.equal(quote.dry, true);
    assert.equal(quote.spreadSavedUnits, "47500000"); // 47.50 USDC saved per 2,500 USDC swap
  });
});
