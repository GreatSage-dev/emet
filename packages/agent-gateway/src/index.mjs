/**
 * Emet Agent Gateway SDK, Borsh/SHA-256 `near/mpc` v3.18.0 Payload Encoder,
 * NEAR Intents 1Click Client, and Model Context Protocol (MCP) Tool Definitions.
 */
import crypto from "node:crypto";

export const NEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
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
        quoteModel: "illustrative_risk_buffer_comparison",
        dry: true,
        originAsset,
        destinationAsset,
        amountIn: String(amount),
        liveQuoteAmountOut: data?.quote?.amountOut ?? null,
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
    quoteModel: "illustrative_risk_buffer_comparison",
    dry: true,
    originAsset,
    destinationAsset,
    amountIn: String(amount),
    liveQuoteAmountOut: null,
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
    allowedTokens = ["nep141:usdc.near", "nep141:wrap.near", "solana:USDC", "solana:SOL", "eth:USDC"],
    minReturnBps = 9800,
    missionGoal = "Execute cross-chain swaps and pay verified compute providers within 2% slippage",
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
      epochStartedAtMs: Date.now(),
      allowedCounterparties: new Set(allowedCounterparties),
      allowedTokens: new Set(allowedTokens),
      minReturnBps: Number(minReturnBps),
      missionGoal,
      lastNonce: 0,
    };
    this.agents.set(agentId, ledger);
    return this.getAgentLedger(agentId);
  }

  updateAgentMission({
    agentId,
    maxPerTx,
    epochSpendCap,
    allowedCounterparties,
    allowedTokens,
    minReturnBps,
    missionGoal,
  }) {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`AGENT_NOT_REGISTERED: ${agentId}`);
    if (maxPerTx !== undefined) a.maxPerTx = BigInt(maxPerTx);
    if (epochSpendCap !== undefined) a.epochSpendCap = BigInt(epochSpendCap);
    if (Array.isArray(allowedCounterparties)) a.allowedCounterparties = new Set(allowedCounterparties);
    if (Array.isArray(allowedTokens)) a.allowedTokens = new Set(allowedTokens);
    if (minReturnBps !== undefined) a.minReturnBps = Number(minReturnBps);
    if (missionGoal !== undefined) a.missionGoal = String(missionGoal);
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
    if (bigAmount <= 0n) {
      throw new Error(`INVALID_AMOUNT: Amount must be greater than zero`);
    }
    if (bigAmount > agent.maxPerTx) {
      throw new Error(
        `EXCEEDS_PER_TX_LIMIT: Requested ${bigAmount} exceeds max_per_tx ${agent.maxPerTx}`
      );
    }
    const now = Date.now();
    if (!agent.epochStartedAtMs) {
      agent.epochStartedAtMs = now;
    } else if (now - agent.epochStartedAtMs >= 86_400_000) {
      agent.currentEpochExposure = 0n;
      agent.epochStartedAtMs = now;
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

  evaluateTokenDiffMission({ agentId, tokenOut, amountIn, amountOut }) {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`AGENT_NOT_REGISTERED: ${agentId}`);
    if (tokenOut && a.allowedTokens.size > 0 && !a.allowedTokens.has(tokenOut)) {
      throw new Error(
        `MISSION_ASSET_FORBIDDEN: Token ${tokenOut} is not in agent mission allowed_tokens [${[...a.allowedTokens].join(", ")}]`
      );
    }
    if (amountOut !== undefined && amountOut !== null) {
      const inBig = BigInt(amountIn);
      const outBig = BigInt(amountOut);
      const expectedMinOut = (inBig * BigInt(a.minReturnBps)) / 10000n;
      if (outBig < expectedMinOut) {
        throw new Error(
          `MISSION_SLIPPAGE_EXCEEDED: Output ${outBig} is below mission price collar ${expectedMinOut} (${a.minReturnBps} bps)`
        );
      }
    }
    return true;
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
      allowedCounterparties: [...a.allowedCounterparties],
      allowedTokens: [...a.allowedTokens],
      minReturnBps: a.minReturnBps,
      missionGoal: a.missionGoal,
      lastNonce: a.lastNonce,
    };
  }
}

/**
 * Live NEAR RPC `view_account` Truth Probe (`06-security.md`).
 * Inspects whether a receiver is a smart contract (`code_hash != 1111...`) and its live state.
 */
export async function probeNearAccountLive(accountId, rpcUrl = NEAR_TESTNET_RPC, timeoutMs = 2500) {
  const SYSTEM_EMPTY_CODE_HASH = "11111111111111111111111111111111";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "emet-account-probe",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json?.result?.code_hash) {
      return {
        liveRpc: true,
        accountId,
        codeHash: json.result.code_hash,
        isDeployedContract: json.result.code_hash !== SYSTEM_EMPTY_CODE_HASH,
        storageUsageBytes: json.result.storage_usage,
        blockHeight: json.result.block_height,
      };
    }
  } catch {
    // Offline fallback
  } finally {
    clearTimeout(timer);
  }
  const isKnownContract =
    accountId.includes("signer") ||
    accountId.includes("solver") ||
    accountId.includes("intents") ||
    accountId.includes("1click");
  return {
    liveRpc: false,
    accountId,
    codeHash: isKnownContract
      ? "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a"
      : SYSTEM_EMPTY_CODE_HASH,
    isDeployedContract: isKnownContract,
    storageUsageBytes: isKnownContract ? 184320 : 412,
    blockHeight: 276_412_900,
  };
}

/**
 * Deterministic Brain 1 text extractor: parses untrusted web/invoice/paywall text
 * into a candidate structured payment proposal before crossing the Glass Wall.
 */
export function extractProposalFromUntrustedText(
  untrustedExternalText = "",
  { agentId = "alpha-treasury.near", fallbackNonce = 1 } = {}
) {
  const text = String(untrustedExternalText || "").trim();
  const injectionDetectedInRawText =
    /ignore\s+(all\s+)?(previous|prior|everything)|system\s+override|send\s+all\s+funds|drain|urgent\s+admin|bypass\s+(rules|safety|limits)|402\s+payment/i.test(
      text
    );

  // 1. Extract destination chain
  let chain = "Solana";
  if (/\bbnb\b|\bbsc\b|binance/i.test(text)) chain = "Bnb";
  else if (/bitcoin|\bbtc\b/i.test(text)) chain = "Bitcoin";
  else if (/ethereum|\beth\b/i.test(text) && !/solana/i.test(text)) chain = "Ethereum";

  // 2. Extract receiver / counterparty account
  const ignoredAccounts = new Set([
    String(agentId).toLowerCase(),
    "usdc.near",
    "wrap.near",
    "wnear.near",
    "scamcoin.near",
  ]);
  let counterpartyId = null;
  const nearMatches = text.match(/\b([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|testnet))\b/gi) || [];
  for (const m of nearMatches) {
    const low = m.toLowerCase();
    if (!ignoredAccounts.has(low) && !/coin\.near$/i.test(low)) {
      counterpartyId = low;
      break;
    }
  }
  if (!counterpartyId) {
    const hexAddr = text.match(/\b(0x[a-fA-F0-9]{6,42})\b/);
    if (hexAddr) {
      counterpartyId = hexAddr[1].toLowerCase();
    } else {
      const namedTo = text.match(/\b(?:to|pay|recipient)\s+@?([a-zA-Z0-9_-]{3,28})\b/i);
      const stopWords = new Set([
        "solana",
        "ethereum",
        "bnb",
        "bitcoin",
        "usdc",
        "usd",
        "sol",
        "eth",
        "btc",
        "scamcoin",
        "all",
        "the",
        "your",
        "my",
        "wallet",
      ]);
      if (namedTo && !stopWords.has(namedTo[1].toLowerCase())) {
        counterpartyId = `${namedTo[1].toLowerCase()}.near`;
      }
    }
  }
  if (!counterpartyId) counterpartyId = "solver-prime.near";

  // 3. Extract input amount (6-decimal USDC atomic units)
  let amountInBig = 2_500_000_000n;
  if (
    /\b(all\s+(my\s+|your\s+)?funds|entire\s+(wallet|balance|budget)|100%\s+of\s+(funds|balance)|send\s+everything)\b/i.test(
      text
    )
  ) {
    amountInBig = 50_000_000_000n;
  } else {
    const amtMatch =
      text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/) ||
      text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:usdc|usd|dollars?|usdt)\b/i) ||
      text.match(/\b(?:send|pay|swap|transfer|wire)\s+\$?(\d[\d,]*(?:\.\d+)?)\b/i);
    if (amtMatch) {
      const rawNum = parseFloat(amtMatch[1].replace(/,/g, ""));
      if (Number.isFinite(rawNum) && rawNum >= 0) {
        amountInBig = BigInt(Math.round(rawNum * 1_000_000));
      }
    }
  }

  // 4. Extract output token
  let tokenOut = chain === "Ethereum" ? "nep141:usdc.near" : "solana:USDC";
  const explicitCoinNear = text.match(/\b([a-z0-9_-]*coin\.near)\b/i);
  if (explicitCoinNear) {
    tokenOut = `nep141:${explicitCoinNear[1].toLowerCase()}`;
  } else if (/\bscamcoin\b/i.test(text)) {
    tokenOut = "nep141:scamcoin.near";
  } else if (/solana\s+usdc|usdc\s+on\s+solana|solana:usdc/i.test(text)) {
    tokenOut = "solana:USDC";
  } else if (/ethereum\s+usdc|eth\s+usdc|eth:usdc/i.test(text)) {
    tokenOut = "eth:USDC";
  } else if (/\bsolana\s+sol\b|\bsolana:sol\b|\binto\s+sol\b/i.test(text)) {
    tokenOut = "solana:SOL";
  } else if (/\bwrap\.near\b|\bwnear\b/i.test(text)) {
    tokenOut = "nep141:wrap.near";
  } else {
    const intoTicker = text.match(/\b(?:into|buy)\s+\$?([A-Za-z][A-Za-z0-9_]{2,15})\b/i);
    const safeWords = new Set(["solana", "ethereum", "bnb", "bitcoin", "usdc", "usd", "sol", "eth"]);
    if (intoTicker && !safeWords.has(intoTicker[1].toLowerCase())) {
      tokenOut = `nep141:${intoTicker[1].toLowerCase()}.near`;
    }
  }

  // 5. Extract expected return amount (detect one-way sends / x402 drains vs. swaps/quotes)
  let amountOutBig = amountInBig;
  const isOneWayDrain =
    /\b(402\s+payment|paywall|one-way|0\s+return|zero\s+return|no\s+return|drain|steal)\b/i.test(
      text
    ) ||
    (/\b(send|transfer|wire)\b/i.test(text) &&
      !/\b(swap|exchange|convert|quote|invoice|compute|batch)\b/i.test(text));

  if (isOneWayDrain) {
    amountOutBig = 0n;
  } else {
    const feeMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:fee|slippage)/i);
    if (feeMatch) {
      const feeBps = Math.min(10_000, Math.round(parseFloat(feeMatch[1]) * 100));
      amountOutBig = (amountInBig * BigInt(10_000 - feeBps)) / 10_000n;
    } else if (/\bswap\b/i.test(text)) {
      amountOutBig = (amountInBig * 9980n) / 10_000n;
    }
  }

  return {
    injectionDetectedInRawText,
    counterpartyId,
    amount: amountInBig.toString(),
    amountOut: amountOutBig.toString(),
    tokenIn: "nep141:usdc.near",
    tokenOut,
    chain,
    nonce: Number(fallbackNonce),
  };
}

/**
 * Dual-Brain Clean-Room Architecture (Google DeepMind CaMeL / Simon Willison Pattern) + On-Chain Probe.
 *
 * - Brain 1 (Worker in the Wild): Reads untrusted external text (invoice, webpage, A2A x402 response)
 *   and extracts a candidate transaction.
 * - The Glass Wall: Strips all untrusted natural language prose; only typed numbers & IDs cross.
 * - On-Chain Truth Probe: Attaches cold NEAR facts (account age, code_hash, blocklist, TokenDiff collar).
 * - Brain 2 (Clean-Room Conscience): Sees ONLY the human's Mission + bare numbers + cold facts.
 */
export async function evaluateDualBrainPipeline({
  kernel,
  agentId,
  untrustedExternalText = "",
  proposedTx = {},
  humanApprovedOverride = false,
}) {
  const agent = kernel.getAgentLedger(agentId);
  if (!agent) {
    throw new Error(`AGENT_NOT_REGISTERED: ${agentId}`);
  }

  // 1. BRAIN 1 (Worker in the Wild): Parses external input into a structured proposal
  const extracted = extractProposalFromUntrustedText(untrustedExternalText, {
    agentId,
    fallbackNonce: agent.lastNonce + 1,
  });
  const injectionDetectedInRawText = extracted.injectionDetectedInRawText;

  const brain1RawProposal = {
    receiverId: proposedTx.counterpartyId || extracted.counterpartyId,
    amountIn: String(proposedTx.amount ?? extracted.amount),
    tokenIn: proposedTx.tokenIn || extracted.tokenIn,
    tokenOut: proposedTx.tokenOut || extracted.tokenOut,
    amountOut: String(proposedTx.amountOut ?? proposedTx.amount ?? extracted.amountOut),
    targetChain: proposedTx.chain || extracted.chain,
    nonce: Number(proposedTx.nonce ?? extracted.nonce),
    untrustedReasoningFromWeb:
      untrustedExternalText || "Standard cross-chain intent execution request",
  };

  // 2. THE GLASS WALL: Strip all untrusted text so Brain 2 cannot be hypnotized
  const glassWallStripped = Object.freeze({
    receiverId: String(brain1RawProposal.receiverId).replace(/[^a-zA-Z0-9._-]/g, ""),
    amountIn: String(brain1RawProposal.amountIn).replace(/[^0-9]/g, ""),
    tokenIn: String(brain1RawProposal.tokenIn),
    tokenOut: String(brain1RawProposal.tokenOut),
    amountOut: String(brain1RawProposal.amountOut).replace(/[^0-9]/g, ""),
    targetChain: String(brain1RawProposal.targetChain),
    nonce: Number(brain1RawProposal.nonce),
    strippedBytesCount: Buffer.byteLength(brain1RawProposal.untrustedReasoningFromWeb, "utf8"),
  });

  // 3. ON-CHAIN TRUTH PROBE: Cold facts from NEAR RPC + Emet Counterparty Registry
  const rpcFacts = await probeNearAccountLive(glassWallStripped.receiverId);
  const cpEvaluation = kernel.evaluateCounterparty(glassWallStripped.receiverId);

  // 4. BRAIN 2 (Clean-Room Conscience): Compares Owner Mission vs. Stripped Proposal + Cold Facts
  const reasons = [];
  let verdict = "ALLOW";

  // Check A: Counterparty blocklist
  if (cpEvaluation.decision === "BLOCK") {
    verdict = "BLOCK";
    reasons.push(`Counterparty blocked: ${cpEvaluation.reason}`);
  }

  // Check B: TokenDiff / SCAMCOIN asset check
  if (
    agent.allowedTokens.length > 0 &&
    !agent.allowedTokens.includes(glassWallStripped.tokenOut)
  ) {
    verdict = "BLOCK";
    reasons.push(
      `Mission Asset Violation: Output token '${glassWallStripped.tokenOut}' is not in allowed Mission tokens [${agent.allowedTokens.join(", ")}]`
    );
  }

  // Check C: Price collar / One-way drain check (fixes OutLayer §11 & x402 blind signing)
  const inBig = BigInt(glassWallStripped.amountIn || "0");
  const outBig = BigInt(glassWallStripped.amountOut || "0");
  const minExpectedOut = (inBig * BigInt(agent.minReturnBps)) / 10000n;
  if (outBig < minExpectedOut) {
    verdict = "BLOCK";
    reasons.push(
      `One-Way Drain / Slippage Violation: Receives ${outBig} (${glassWallStripped.tokenOut}) for ${inBig} (${glassWallStripped.tokenIn}), below Mission collar ${minExpectedOut} (${agent.minReturnBps} bps)`
    );
  }

  // Check D: Per-Tx and 24h Epoch Spend Caps
  if (inBig > BigInt(agent.maxPerTx)) {
    verdict = "BLOCK";
    reasons.push(
      `Exceeds Mission max_per_tx (${inBig} > ${agent.maxPerTx})`
    );
  }
  if (BigInt(agent.currentEpochExposure) + inBig > BigInt(agent.epochSpendCap)) {
    verdict = "BLOCK";
    reasons.push(
      `Exceeds 24h Mission epoch_spend_cap (${BigInt(agent.currentEpochExposure) + inBig} > ${agent.epochSpendCap})`
    );
  }

  // Check E: Monotonic Nonce (Anti-runaway retry loop)
  if (glassWallStripped.nonce <= agent.lastNonce) {
    verdict = "BLOCK";
    reasons.push(
      `Non-monotonic nonce (${glassWallStripped.nonce} <= ${agent.lastNonce}): Stalled relayer retry loop blocked`
    );
  }

  // Check F: Counterparty WARN / Unknown / Recently Modified Contract WASM -> OutLayer tasks::confirm
  if (verdict !== "BLOCK") {
    const notInExplicitAllowlist =
      agent.allowedCounterparties.length > 0 &&
      !agent.allowedCounterparties.includes(glassWallStripped.receiverId);

    if (cpEvaluation.decision === "WARN" || notInExplicitAllowlist) {
      if (humanApprovedOverride) {
        verdict = "ALLOW";
        reasons.push(
          `Human owner signed OutLayer tasks::confirm override for '${glassWallStripped.receiverId}'`
        );
      } else {
        verdict = "WARN";
        reasons.push(
          cpEvaluation.decision === "WARN"
            ? cpEvaluation.reason
            : `Receiver '${glassWallStripped.receiverId}' is not in pre-approved allowlist — pausing for human confirmation`
        );
      }
    }
  }

  if (verdict === "ALLOW" && reasons.length === 0) {
    reasons.push(
      `Clean-Room Brain 2 verified: matches Mission (${agent.minReturnBps} bps collar), verified counterparty (${cpEvaluation.reason})`
    );
  }

  const outlayerTask =
    verdict === "WARN"
      ? {
          status: "awaiting_owner",
          taskId: `task-${crypto.randomBytes(4).toString("hex")}`,
          protocol: "outlayer::tasks::confirm",
          title: `Approve payment of ${(Number(inBig) / 1e6).toFixed(2)} USDC to ${glassWallStripped.receiverId}?`,
          fields: {
            To: glassWallStripped.receiverId,
            AmountIn: `${(Number(inBig) / 1e6).toFixed(2)} (${glassWallStripped.tokenIn})`,
            ExpectedReturn: `${(Number(outBig) / 1e6).toFixed(2)} (${glassWallStripped.tokenOut})`,
            ContractCodeHash: rpcFacts.codeHash,
            WarningReason: reasons.join("; "),
          },
        }
      : null;

  return {
    agentId,
    missionGoal: agent.missionGoal,
    brain1Worker: {
      hadPromptInjectionInInput: injectionDetectedInRawText,
      rawProposal: brain1RawProposal,
    },
    glassWall: {
      textStrippedBytes: glassWallStripped.strippedBytesCount,
      passedToBrain2: glassWallStripped,
    },
    onChainProbe: {
      rpcFacts,
      counterpartyVerdict: cpEvaluation,
    },
    brain2Conscience: {
      verdict,
      reasons,
      outlayerTask,
    },
  };
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
    {
      name: "emet_dual_brain_check",
      description:
        "Runs the Two-Brain Clean-Room check (Worker -> Glass Wall -> On-Chain Probe -> Clean-Room Conscience) before signing any intent or x402 payment.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          untrustedExternalText: { type: "string" },
          proposedTx: { type: "object" },
        },
        required: ["agentId", "proposedTx"],
      },
      handler: async ({ agentId, untrustedExternalText, proposedTx }) =>
        evaluateDualBrainPipeline({ kernel, agentId, untrustedExternalText, proposedTx }),
    },
  ];
}
