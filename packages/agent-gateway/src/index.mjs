/**
 * Emet Agent Gateway SDK, Borsh/SHA-256 `near/mpc` v3.18.0 Payload Encoder,
 * NEAR Intents 1Click Client, and Model Context Protocol (MCP) Tool Definitions.
 */
import crypto from "node:crypto";

export const NEAR_TESTNET_RPC = "https://rpc.testnet.near.org";
export const MPC_SIGNER_CONTRACT = "v1.signer-prod.testnet";
export const NEAR_INTENTS_1CLICK_API = "https://1click.chaindefuser.com/v0";

/**
 * Discriminant map matching `near-mpc-contract-interface::types::ForeignChainRpcRequest` v3.18.0.
 */
export const CHAIN_DISCRIMINANTS = Object.freeze({
  Abstract: 0,
  Ethereum: 1,
  Solana: 2,
  Bitcoin: 3,
  Starknet: 4,
  Bnb: 5,
  Base: 6,
  Arbitrum: 7,
  Polygon: 8,
  HyperEvm: 9,
  Ton: 10,
  Aptos: 11,
  Sui: 12,
  Avalanche: 13,
  Adi: 14,
  Fogo: 15,
});

export const EVM_FINALITY = Object.freeze({
  Latest: 0,
  Safe: 1,
  Finalized: 2,
});

export const SVM_FINALITY = Object.freeze({
  Confirmed: 0,
  Finalized: 1,
});

function u32le(num) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(num >>> 0, 0);
  return b;
}

function u64le(bigOrNum) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(bigOrNum), 0);
  return b;
}

function hexToBytes(hexStr, expectedLen) {
  const clean = hexStr.startsWith("0x") ? hexStr.slice(2) : hexStr;
  const buf = Buffer.from(clean, "hex");
  if (expectedLen !== undefined && buf.length !== expectedLen) {
    throw new Error(`Expected ${expectedLen} bytes, got ${buf.length}`);
  }
  return buf;
}

/**
 * Computes the canonical `ForeignTxSignPayload::V1` SHA-256 digest matching `near/mpc` v3.18.0.
 */
export function computeForeignTxPayloadHashV1(spec) {
  const chunks = [];
  // ForeignTxSignPayload::V1 discriminant = 0u8
  chunks.push(Buffer.from([0]));

  const chainDisc = CHAIN_DISCRIMINANTS[spec.chain];
  if (chainDisc === undefined) {
    throw new Error(`Unsupported foreign chain: ${spec.chain}`);
  }
  chunks.push(Buffer.from([chainDisc]));

  if (spec.chain === "Solana" || spec.chain === "Fogo") {
    // SvmRpcRequest: tx_id ([u8; 64]), finality (u8), extractors (Vec<SvmExtractor>)
    chunks.push(hexToBytes(spec.txIdHex, 64));
    const fin = SVM_FINALITY[spec.finality];
    if (fin === undefined) throw new Error(`Invalid SVM finality: ${spec.finality}`);
    chunks.push(Buffer.from([fin]));

    const extractors = spec.extractors ?? [];
    chunks.push(u32le(extractors.length));
    for (const ext of extractors) {
      if (ext.type === "InnerInstruction") {
        chunks.push(Buffer.from([1])); // discriminant = 1
        chunks.push(u64le(ext.instructionIndex));
        chunks.push(u64le(ext.innerInstructionIndex));
      } else if (ext.type === "AccountState") {
        chunks.push(Buffer.from([2])); // discriminant = 2
        chunks.push(hexToBytes(ext.pubkeyHex, 32));
      } else {
        throw new Error(`Unknown SVM extractor: ${ext.type}`);
      }
    }
  } else if (spec.chain === "Bitcoin") {
    // BitcoinRpcRequest: tx_id ([u8; 32]), confirmations (u64), extractors (Vec<BitcoinExtractor>)
    chunks.push(hexToBytes(spec.txIdHex, 32));
    chunks.push(u64le(spec.confirmations));
    const extractors = spec.extractors ?? [];
    chunks.push(u32le(extractors.length));
    for (const ext of extractors) {
      if (ext.type === "BlockHash") {
        chunks.push(Buffer.from([0]));
      } else {
        throw new Error(`Unknown Bitcoin extractor: ${ext.type}`);
      }
    }
  } else {
    // EvmRpcRequest: tx_id ([u8; 32]), extractors (Vec<EvmExtractor>), finality (u8)
    chunks.push(hexToBytes(spec.txIdHex, 32));
    const extractors = spec.extractors ?? [];
    chunks.push(u32le(extractors.length));
    for (const ext of extractors) {
      if (ext.type === "BlockHash") {
        chunks.push(Buffer.from([0]));
      } else if (ext.type === "Log") {
        chunks.push(Buffer.from([1]));
        chunks.push(u64le(ext.logIndex));
      } else {
        throw new Error(`Unknown EVM extractor: ${ext.type}`);
      }
    }
    const fin = EVM_FINALITY[spec.finality];
    if (fin === undefined) throw new Error(`Invalid EVM finality: ${spec.finality}`);
    chunks.push(Buffer.from([fin]));
  }

  // values: Vec<ExtractedValue>
  const values = spec.values ?? [];
  chunks.push(u32le(values.length));
  for (const val of values) {
    if (val.kind === "BitcoinBlockHash") {
      // ExtractedValue::BitcoinExtractedValue (0) -> BlockHash (0)
      chunks.push(Buffer.from([0, 0]));
      chunks.push(hexToBytes(val.blockHashHex, 32));
    } else if (val.kind === "EvmBlockHash") {
      // ExtractedValue::EvmExtractedValue (1) -> BlockHash (0)
      chunks.push(Buffer.from([1, 0]));
      chunks.push(hexToBytes(val.blockHashHex, 32));
    } else if (val.kind === "SvmInnerInstruction") {
      // ExtractedValue::SvmExtractedValue (6) -> InnerInstruction (0)
      chunks.push(Buffer.from([6, 0]));
      chunks.push(hexToBytes(val.programIdHex, 32));
      chunks.push(u32le(val.accountsHex.length));
      for (const acc of val.accountsHex) {
        chunks.push(hexToBytes(acc, 32));
      }
      const dataBuf = hexToBytes(val.dataHex);
      chunks.push(u32le(dataBuf.length));
      chunks.push(dataBuf);
    } else if (val.kind === "SvmAccountState") {
      // ExtractedValue::SvmExtractedValue (6) -> AccountState (1)
      chunks.push(Buffer.from([6, 1]));
      chunks.push(hexToBytes(val.ownerHex, 32));
      const dataBuf = hexToBytes(val.dataHex);
      chunks.push(u32le(dataBuf.length));
      chunks.push(dataBuf);
    } else {
      throw new Error(`Unknown extracted value kind: ${val.kind}`);
    }
  }

  const serialized = Buffer.concat(chunks);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Enforces Emet's strict finality policy on foreign chain verification specs.
 */
export function assertStrictFinality(spec) {
  if (spec.chain === "Solana" || spec.chain === "Fogo") {
    if (spec.finality !== "Finalized") {
      throw new Error(
        `FINALITY_VIOLATION: ${spec.chain} requires SvmFinality::Finalized (32-block root), got ${spec.finality}`
      );
    }
    return true;
  }
  if (spec.chain === "Bitcoin") {
    if (Number(spec.confirmations ?? 0) < 6) {
      throw new Error(
        `FINALITY_VIOLATION: Bitcoin requires >= 6 confirmations, got ${spec.confirmations}`
      );
    }
    return true;
  }
  if (spec.finality !== "Finalized") {
    throw new Error(
      `FINALITY_VIOLATION: ${spec.chain} requires EvmFinality::Finalized, got ${spec.finality}`
    );
  }
  return true;
}

/**
 * Queries NEAR Testnet `v1.signer-prod.testnet` view methods with automatic offline fallback.
 */
export async function queryMpcSignerTestnet(methodName = "version", args = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(NEAR_TESTNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "emet-mpc-probe",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: MPC_SIGNER_CONTRACT,
          method_name: methodName,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json?.result?.result) {
      const decoded = Buffer.from(json.result.result).toString("utf8");
      return {
        live: true,
        contractId: MPC_SIGNER_CONTRACT,
        blockHeight: json.result.block_height,
        blockHash: json.result.block_hash,
        value: JSON.parse(decoded),
      };
    }
  } catch {
    // Fallback to verified snapshot fixture if offline or rate-limited
  } finally {
    clearTimeout(timer);
  }
  return {
    live: false,
    contractId: MPC_SIGNER_CONTRACT,
    blockHeight: 276_412_900,
    blockHash: "8fK3x9pLmN2vQr7wYz1cVb4nMq5jHg6tFd3sAe9uWp2k",
    value:
      methodName === "get_available_foreign_chains"
        ? ["Abstract", "Arbitrum", "Base", "Bitcoin", "Bnb", "Ethereum", "Solana", "Starknet", "Ton"]
        : "3.18.0",
  };
}

/**
 * Fetches a cross-chain swap quote from NEAR Intents 1Click API (`dry: true` preview mode),
 * computing the Formula 1 Spread Savings unlocked by Emet MPC verification.
 */
export async function fetchIntentsDryQuote({
  originAsset = "nep141:usdc.near",
  destinationAsset = "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount = "2500000000", // 2,500 USDC (6 decimals)
  recipient = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  refundTo = "agent-alpha.near",
  timeoutMs = 3500,
} = {}) {
  const numericAmount = BigInt(amount);
  const naiveSpreadBps = 200n; // 2.00% unhedged solver default-risk spread
  const emetSpreadBps = 10n;   // 0.10% MPC outcome-verified spread

  const naiveOut = (numericAmount * (10000n - naiveSpreadBps)) / 10000n;
  const emetOut = (numericAmount * (10000n - emetSpreadBps)) / 10000n;
  const capitalSaved = emetOut - naiveOut;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NEAR_INTENTS_1CLICK_API}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 50,
        originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset,
        amount: String(amount),
        refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 600_000).toISOString(),
      }),
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      return {
        source: "live-1click-api",
        dry: true,
        originAsset,
        destinationAsset,
        amountIn: String(amount),
        naiveUnverifiedAmountOut: naiveOut.toString(),
        emetVerifiedAmountOut: emetOut.toString(),
        spreadSavedUnits: capitalSaved.toString(),
        naiveSpreadBps: Number(naiveSpreadBps),
        emetSpreadBps: Number(emetSpreadBps),
        apiQuote: data,
      };
    }
  } catch {
    // Offline / unauthenticated fallback
  } finally {
    clearTimeout(timer);
  }

  return {
    source: "deterministic-1click-fixture",
    dry: true,
    originAsset,
    destinationAsset,
    amountIn: String(amount),
    naiveUnverifiedAmountOut: naiveOut.toString(),
    emetVerifiedAmountOut: emetOut.toString(),
    spreadSavedUnits: capitalSaved.toString(),
    naiveSpreadBps: Number(naiveSpreadBps),
    emetSpreadBps: Number(emetSpreadBps),
  };
}

/**
 * Deterministic JavaScript mirror of `EmetSettlementKernel` for local agent pre-flight,
 * MCP tool execution, and interactive UI sandbox simulation.
 */
export class EmetKernelSimulator {
  constructor({ ownerId = "owner.near", mpcContractId = MPC_SIGNER_CONTRACT } = {}) {
    this.ownerId = ownerId;
    this.mpcContractId = mpcContractId;
    this.agents = new Map();
    this.counterparties = new Map();
    this.intents = new Map();
    this.receipts = new Map();
  }

  registerAgent({
    agentId,
    initialBudget,
    maxPerTx,
    epochSpendCap,
    allowedCounterparties = [],
  }) {
    const ledger = {
      agentId,
      availableBalance: BigInt(initialBudget),
      inFlightLocked: 0n,
      settledSpent: 0n,
      refundedSaved: 0n,
      maxPerTx: BigInt(maxPerTx),
      epochSpendCap: BigInt(epochSpendCap),
      currentEpochExposure: 0n,
      allowedCounterparties: new Set(allowedCounterparties),
      lastNonce: 0,
    };
    this.agents.set(agentId, ledger);
    return this.getAgentLedger(agentId);
  }

  upsertCounterparty({
    receiverId,
    accountAgeDays = 90,
    isContract = true,
    codeChangedRecently = false,
    priorSuccessfulSettlements = 8,
    reportedMaliciousBy = [],
  }) {
    this.counterparties.set(receiverId, {
      receiverId,
      accountAgeDays,
      isContract,
      codeChangedRecently,
      priorSuccessfulSettlements,
      reportedMaliciousBy: [...reportedMaliciousBy],
    });
  }

  reportMaliciousCounterparty({ reporterAgentId, counterpartyId, evidenceTxHash }) {
    if (!this.agents.has(reporterAgentId)) {
      throw new Error(`AGENT_NOT_REGISTERED: ${reporterAgentId}`);
    }
    const existing = this.counterparties.get(counterpartyId) ?? {
      receiverId: counterpartyId,
      accountAgeDays: 0,
      isContract: false,
      codeChangedRecently: false,
      priorSuccessfulSettlements: 0,
      reportedMaliciousBy: [],
    };
    existing.reportedMaliciousBy.push({ reporterAgentId, evidenceTxHash });
    this.counterparties.set(counterpartyId, existing);
  }

  evaluateCounterparty(counterpartyId) {
    const profile = this.counterparties.get(counterpartyId);
    if (!profile) {
      return {
        decision: "WARN",
        riskBps: 500,
        reason: "Unknown counterparty with zero settlement history",
      };
    }
    if (profile.reportedMaliciousBy.length > 0) {
      const first = profile.reportedMaliciousBy[0];
      return {
        decision: "BLOCK",
        riskBps: 10000,
        reason: `Flagged on shared agent blocklist by ${first.reporterAgentId}`,
        evidenceTxHash: first.evidenceTxHash,
      };
    }
    if (profile.isContract && profile.codeChangedRecently) {
      return {
        decision: "WARN",
        riskBps: 350,
        reason: "Receiver contract WASM code modified within 24h quarantine window",
      };
    }
    if (profile.accountAgeDays < 3 && profile.priorSuccessfulSettlements === 0) {
      return {
        decision: "WARN",
        riskBps: 250,
        reason: "Newly created account (<3 days) with no prior verified settlements",
      };
    }
    return {
      decision: "ALLOW",
      riskBps: 5,
      solverSpreadBps: profile.priorSuccessfulSettlements >= 5 ? 10 : 15,
      reason: `Verified counterparty (${profile.priorSuccessfulSettlements} prior MPC settlements, ${profile.accountAgeDays}d age)`,
    };
  }

  initiateIntent({
    intentId,
    agentId,
    counterpartyId,
    amount,
    nonce,
    keyPermission = {
      type: "FunctionCall",
      receiverId: "emet.near",
      methodNames: ["initiate_intent"],
    },
    foreignTxSpec,
  }) {
    if (keyPermission.type === "FullAccess") {
      throw new Error("FULL_ACCESS_KEY_FORBIDDEN: Autonomous agents must use a FunctionCall access key scoped to emet.near");
    }
    if (
      keyPermission.receiverId !== "emet.near" ||
      !keyPermission.methodNames.includes("initiate_intent")
    ) {
      throw new Error("INVALID_FUNCTION_CALL_SCOPE: Key must be scoped to emet.near::initiate_intent");
    }

    assertStrictFinality(foreignTxSpec);
    const expectedPayloadHash = computeForeignTxPayloadHashV1(foreignTxSpec);

    const cpVerdict = this.evaluateCounterparty(counterpartyId);
    if (cpVerdict.decision === "BLOCK") {
      throw new Error(`COUNTERPARTY_BLOCKED: ${counterpartyId} — ${cpVerdict.reason}`);
    }
    if (cpVerdict.decision === "WARN") {
      throw new Error(`COUNTERPARTY_WARN_HUMAN_REQUIRED: ${counterpartyId} — ${cpVerdict.reason}`);
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`AGENT_NOT_REGISTERED: ${agentId}`);
    }
    if (
      agent.allowedCounterparties.size > 0 &&
      !agent.allowedCounterparties.has(counterpartyId)
    ) {
      throw new Error(`COUNTERPARTY_BLOCKED: ${counterpartyId} not in agent allowlist`);
    }
    if (nonce <= agent.lastNonce) {
      throw new Error(
        `NON_MONOTONIC_NONCE: Provided nonce ${nonce} <= last_nonce ${agent.lastNonce} (runaway retry loop blocked)`
      );
    }

    const bigAmount = BigInt(amount);
    if (bigAmount > agent.maxPerTx) {
      throw new Error(
        `EXCEEDS_PER_TX_LIMIT: Requested ${bigAmount} exceeds max_per_tx ${agent.maxPerTx}`
      );
    }
    if (agent.currentEpochExposure + bigAmount > agent.epochSpendCap) {
      throw new Error(
        `EXCEEDS_EPOCH_CAP: Exposure ${agent.currentEpochExposure + bigAmount} exceeds 24h cap ${agent.epochSpendCap}`
      );
    }
    if (bigAmount > agent.availableBalance) {
      throw new Error(
        `INSUFFICIENT_AVAILABLE_BUDGET: Requested ${bigAmount}, available ${agent.availableBalance}`
      );
    }

    // CEI Effects: lock in-flight before MPC verification
    agent.availableBalance -= bigAmount;
    agent.inFlightLocked += bigAmount;
    agent.currentEpochExposure += bigAmount;
    agent.lastNonce = nonce;

    const intent = {
      intentId,
      agentId,
      counterpartyId,
      amount: bigAmount.toString(),
      nonce,
      targetChain: foreignTxSpec.chain,
      expectedPayloadHash,
      status: "VerifyingOutcome",
      createdAtMs: Date.now(),
    };
    this.intents.set(intentId, intent);
    return intent;
  }

  reconcileForeignOutcome({
    callerId = "emet.near",
    intentId,
    verdict,
  }) {
    if (callerId !== "emet.near") {
      throw new Error("PRIVATE_CALLBACK_ONLY: Only emet.near private callback can settle or refund intents");
    }
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`INTENT_NOT_FOUND: ${intentId}`);
    }
    if (intent.status !== "VerifyingOutcome") {
      throw new Error(`INTENT_NOT_VERIFYING: ${intentId}`);
    }

    const agent = this.agents.get(intent.agentId);
    const bigAmount = BigInt(intent.amount);
    agent.inFlightLocked -= bigAmount;

    let receiptStatus;
    if (
      verdict.type === "Extracted" &&
      verdict.payloadHash === intent.expectedPayloadHash
    ) {
      agent.settledSpent += bigAmount;
      intent.status = "Settled";
      receiptStatus = {
        state: "Settled",
        mpcPayloadHash: verdict.payloadHash,
        mpcSignatureHex: verdict.signatureHex,
      };
    } else {
      agent.availableBalance += bigAmount;
      agent.refundedSaved += bigAmount;
      agent.currentEpochExposure -= bigAmount;
      intent.status = "Refunded";
      receiptStatus = {
        state: "Refunded",
        reason:
          verdict.reason ??
          `MPC verification rejected outcome (${verdict.type}) — funds restored to agent available budget`,
      };
    }

    const receipt = {
      receiptId: `rcpt-${intentId}`,
      intentId,
      agentId: intent.agentId,
      counterpartyId: intent.counterpartyId,
      targetChain: intent.targetChain,
      amount: intent.amount,
      solverSpreadBps: 10,
      naiveUnverifiedSpreadBps: 200,
      expectedPayloadHash: intent.expectedPayloadHash,
      status: receiptStatus,
      issuedAtMs: Date.now(),
    };
    this.receipts.set(receipt.receiptId, receipt);
    return receipt;
  }

  getAgentLedger(agentId) {
    const a = this.agents.get(agentId);
    if (!a) return null;
    return {
      agentId: a.agentId,
      availableBalance: a.availableBalance.toString(),
      inFlightLocked: a.inFlightLocked.toString(),
      settledSpent: a.settledSpent.toString(),
      refundedSaved: a.refundedSaved.toString(),
      maxPerTx: a.maxPerTx.toString(),
      epochSpendCap: a.epochSpendCap.toString(),
      currentEpochExposure: a.currentEpochExposure.toString(),
      lastNonce: a.lastNonce,
    };
  }
}

/**
 * Model Context Protocol (MCP) Tool Definitions for `nearai/near-mcp` and Agent Connect.
 */
export function createEmetMcpTools(kernel) {
  return [
    {
      name: "emet_evaluate_counterparty",
      description:
        "Checks a NEAR or cross-chain receiver against Emet's counterparty risk engine and shared malicious blocklist before signing.",
      inputSchema: {
        type: "object",
        properties: {
          counterpartyId: { type: "string" },
        },
        required: ["counterpartyId"],
      },
      handler: async ({ counterpartyId }) => kernel.evaluateCounterparty(counterpartyId),
    },
    {
      name: "emet_initiate_verified_intent",
      description:
        "Locks agent budget in-flight using a scoped Function-Call Access Key and dispatches a NEAR MPC verify_foreign_transaction request.",
      inputSchema: {
        type: "object",
        properties: {
          intentId: { type: "string" },
          agentId: { type: "string" },
          counterpartyId: { type: "string" },
          amount: { type: "string" },
          nonce: { type: "number" },
          foreignTxSpec: { type: "object" },
        },
        required: [
          "intentId",
          "agentId",
          "counterpartyId",
          "amount",
          "nonce",
          "foreignTxSpec",
        ],
      },
      handler: async (args) => kernel.initiateIntent(args),
    },
    {
      name: "emet_get_budget_ledger",
      description:
        "Returns the double-entry agent wallet ledger (available, in_flight_locked, settled_spent, refunded_saved).",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
        },
        required: ["agentId"],
      },
      handler: async ({ agentId }) => kernel.getAgentLedger(agentId),
    },
  ];
}
