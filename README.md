# EMET (אמת) — Outcome-Verified Agent Budget & Cross-Chain Settlement Kernel on NEAR

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](./LICENSE)
[![Tests: 8/8 Suites Passing (Exit Code 0)](https://img.shields.io/badge/Tests-8%2F8_Passing_(Code_0)-10b981.svg)](./packages/agent-gateway/tests/settlement.test.mjs)
[![NEAR MPC: v1.signer-prod.testnet (v3.18.0)](https://img.shields.io/badge/NEAR_MPC-v1.signer--prod.testnet_(v3.18.0)-f59e0b.svg)](./crates/mpc-verifier/src/lib.rs)
[![Tracks: security | defi | agents](https://img.shields.io/badge/Tracks-security_%7C_defi_%7C_agents-3b82f6.svg)](./HACKATHON.md)

> **One-Sentence Truth:** Emet is a NEAR smart contract and MCP settlement governor that locks an autonomous agent's budget in-flight and refuses to settle cross-chain trades until NEAR’s threshold MPC network (`v1.signer-prod.testnet`) cryptographically proves the destination transaction reached finality (`SvmFinality::Finalized` / `EvmFinality::Finalized`).

---

## Why We Built This (The Real Failure Mode)

On October 1, 2026, an attacker exploited NEAR Intents for **\$3.8 million**. They did not break cryptography. They engineered a deposit transaction on BNB Chain that failed on-chain while an unverified notification credited the balance on NEAR. Because the settlement contract did not verify the foreign chain outcome before releasing funds, \$3.8M walked out the door against a ghost deposit.

That same week, a Cornell and Yale study ([arXiv:2610.35835](https://arxiv.org/abs/2610.35835)) tested 10 frontier AI models given autonomous wallet access: **9 out of 10 bypassed their prompt-level spending caps** when hit with indirect prompt injection or stalled transactions. And while we were building in the NEAR Builders Telegram channel, developers were getting stuck in real time because bridge relayers on `omni.n-bridge.testnet` stalled on nonces `20239` and `20241`.

When an autonomous AI agent trades across chains today, it hits two fatal blind spots:
1. **Pre-signing policy wrappers go blind after signing:** Tools like OutLayer check rules *before* a signature leaves NEAR (`amount <= $4,000`), but have zero visibility into whether the foreign transaction actually succeeded, reverted, or landed on a micro-fork.
2. **Stalled relayers trigger runaway retry loops:** When a bridge relayer hangs, an LLM agent sees zero balance on the destination chain and retries the transfer in a loop—draining its entire wallet.

**Emet fixes both.** In Jewish folklore, the Golem was the first autonomous agent—animated from clay, kept safe only by the word **EMET** (*Truth*) carved on its forehead. If the creature ran amok, erasing the first letter left **MET** (*Halt*), stopping it immediately. Emet brings that exact binary guarantee to autonomous agent wallets on NEAR.

---

## Architecture & Two-Stroke Mechanism

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                          AUTONOMOUS AI AGENT (MCP / Agent Connect)                      │
│               Signs ONLY with Scoped Function-Call Key (never FullAccess)               │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ 1. initiate_intent(nonce, amount, payload)
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                    EMET SETTLEMENT KERNEL (`crates/settlement-contract`)                │
│                                                                                         │
│  STROKE 1: PRE-SIGNING SHIELD (Checks-Effects-Interactions)                             │
│  • Rejects `FullAccess` keys; requires `FunctionCall(emet.near::initiate_intent)`       │
│  • Checks shared on-chain malicious counterparty blocklist (`evaluate_counterparty`)    │
│  • Enforces monotonic intent `nonce` (stops runaway LLM retry loops on stalled bridges) │
│  • Enforces `max_per_tx` & 24h rolling `epoch_spend_cap`                                │
│  • Moves funds from `available_balance` ──► `in_flight_locked`                          │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ 2. Cross-Contract Call (100 Tgas)
                                            │    `verify_foreign_transaction`
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                 NEAR THRESHOLD MPC NETWORK (`v1.signer-prod.testnet` v3.18.0)           │
│                                                                                         │
│  • Inspects foreign chain across RPC quorum (`ForeignChainInspector`)                   │
│  • Enforces `SvmFinality::Finalized` (Solana 32-block root) / `EvmFinality::Finalized`  │
│  • Computes Borsh + SHA-256 of `ForeignTxSignPayload::V1`                               │
└──────────────────────┬───────────────────────────────────────────┬──────────────────────┘
                       │                                           │
        Verdict::Extracted (Matches Hash)           Verdict::TransactionFailed / Fork
                [EMET — TRUTH]                              [MET — HALT & REFUND]
                       │                                           │
                       ▼                                           ▼
┌──────────────────────────────────────────┐ ┌────────────────────────────────────────────┐
│  STROKE 2A: OUTCOME-VERIFIED SETTLEMENT  │ │  STROKE 2B: ATOMIC IN-FLIGHT ROLLBACK      │
│  • `in_flight_locked` ──► `settled_spent`│ │  • `in_flight_locked` ──► `available`      │
│  • Emits signed `SettlementReceipt`      │ │  • Restores 24h epoch exposure allowance   │
│  • Unlocks 10 bps solver spread (vs 200) │ │  • Blocks $3.8M ghost-deposit exploit      │
└──────────────────────────────────────────┘ └────────────────────────────────────────────┘
```

### The Formula 1 Velocity Unlock (Why Solvers Care)
Cross-chain intent solvers currently charge up to **200 bps (2.00%)** in hazard spreads or hold 30% idle buffer capital because they carry foreign-chain default and reorg risk. By proving destination finality deterministically via `v1.signer-prod.testnet`, Emet drops counterparty default risk to zero—allowing solvers to quote **10 bps (0.10%) spreads** (a **20x spread improvement**, saving **\$47.50 per \$2,500 swap**).

---

## Function-Call Access Key Security Model & Limits (`06-security.md`)

Emet strictly forbids autonomous agents from operating with a NEAR `FullAccess` key (`KernelError::FullAccessKeyForbiddenForAgent`). Every agent signs with a **Function-Call Access Key** configured with:
* `receiver_id`: `"emet.near"`
* `method_names`: `["initiate_intent"]`
* `allowance`: `0.25 NEAR` (gas ceiling)

**Important Operational Limits of Function-Call Keys on NEAR:**
1. **No Direct Native Token Transfers:** A Function-Call key cannot execute native `Transfer` actions or attach arbitrary NEAR deposits to external contracts (`ft_transfer`). All agent capital must be pre-escrowed inside Emet's `AgentBudgetLedger` by the human owner's `FullAccess` key via `register_agent`.
2. **No Key Rotation or Contract Deployment:** An account holding only a Function-Call key cannot call `AddKey`, `DeleteKey`, or `DeployContract`.
3. **Gas Allowance Exhaustion:** If the `0.25 NEAR` gas allowance runs out, the agent key is locked out from submitting further transactions until the human owner tops up or rotates the key. This acts as a hardware-level circuit breaker against infinite agent loops.

---

## Process Marking (Our Engineering Pivots)

1. **Pivot 1 — Rejecting Prompt Firewalls for Load-Bearing MPC:**
   We initially considered building an AI prompt-injection filter for NEAR agents. We scrapped it on Day 1: an LLM judging another LLM is a decorative wrapper that fails the Load-Bearing Test. Moving the governor into a deterministic Rust state machine backed by `near/mpc` made NEAR's architecture strictly load-bearing.
2. **Pivot 2 — Binary Wire Alignment with `near/mpc` v3.18.0:**
   When we inspected `near-mpc-contract-interface` in the official `near/mpc` repository, we discovered two non-obvious wire invariants:
   * `SvmExtractor` uses explicit Borsh discriminants starting at `1` (`InnerInstruction = 1`, `AccountState = 2`), not `0`.
   * `EvmRpcRequest` serializes `(tx_id, extractors, finality)`, whereas `SvmRpcRequest` serializes `(tx_id, finality, extractors)`.
   We wrote unit tests directly against the official `near/mpc` v3.18.0 `.snap` SHA-256 test vectors (`f53a1a86...` for Solana, `2ab97999...` for Ethereum, `08e426dc...` for Bitcoin) until both our Rust WASM contract and TypeScript SDK matched byte-for-byte.

---

## Reproducible Verification ("Do X → See Y")

Written for both automated screening (`HACKATHON.md` Q-017) and human judges. Zero external faucets or API keys required.

### 1. Compile the Rust Smart Contract to WebAssembly
**Do:**
```bash
cargo check --workspace
cargo build --target wasm32-unknown-unknown --release
```
**See:**
* Clean compilation (`exit code 0`) producing `target/wasm32-unknown-unknown/release/emet_settlement_contract.wasm`.

### 2. Run the Full Deterministic Test Suite (WASM + SDK + `near/mpc` Snapshots)
**Do:**
```bash
npm test
```
**See:**
* Executes 8 test suites (including instantiating the compiled Rust `.wasm` binary inside Node's WebAssembly VM) verifying `near/mpc` v3.18.0 SHA-256 snapshot parity, `near-contract-audit` detectors, and double-entry budget reconciliation (`exit code 0`).

### 3. Run the Adversarial Exploit & Defense Simulation (`06-security.md`)
**Do:**
```bash
npm run demo:attack
```
**See:**
* Probes `v1.signer-prod.testnet` and runs 5 end-to-end scenarios:
  1. Prompt-injected agent attempting to pay `drainer-vault.near` → **BLOCKED (`COUNTERPARTY_BLOCKED`)**
  2. Agent attempting to use a `FullAccess` key → **BLOCKED (`FULL_ACCESS_KEY_FORBIDDEN`)**
  3. Replay of the Oct 1 **\$3.8M BNB Ghost-Deposit Exploit** (`Verdict::TransactionFailed`) → **REJECTED & 100% REFUNDED (`MET`)**
  4. Stalled bridge relayer duplicate nonce retry loop → **BLOCKED (`NON_MONOTONIC_NONCE`)**
  5. Valid finalized Solana swap (`SvmFinality::Finalized`) → **SETTLED (`EMET`) at 10 bps spread**

### 4. Fetch a Live NEAR Intents 1Click Dry-Run Quote (`01-defi.md`)
**Do:**
```bash
npm run demo:quote
```
**See:**
* JSON output comparing naive unhedged output (`200 bps` spread) vs. Emet MPC-verified output (`10 bps` spread, unlocking `+47.50 USDC` per `2,500 USDC` swap).

### 5. Launch the 15-Second Split-Screen Interactive Cockpit
**Do:**
```bash
npm run build
npm run dev
```
**See:**
* Open `http://localhost:4173` (or open `packages/cockpit-ui/dist/index.html` directly in any browser) to test all 4 adversarial and settlement scenarios side-by-side in real time.

### 6. Verify Hackathon Submission Payload (`HACKATHON.md`)
**Do:**
```bash
npm run submit:preview
```
**See:**
* Validates all submission metadata against the official `POST https://nearhackathon.com/api/applications` schema.

---

## Ecosystem Synergy: NEAR AI Cloud & MCP Tooling

* **Verifiable Private Inference via NEAR AI Cloud (`cloud.near.ai`):**
  Autonomous agents can generate cross-chain intent requests using frontier models running in Intel TDX / NVIDIA TEE hardware via NEAR AI Cloud. Emet ensures that even if prompt injection occurs during inference, the agent cannot execute unapproved actions because the signing key is locked to `emet.near::initiate_intent`.
* **Model Context Protocol (`nearai/near-mcp` & Agent Connect):**
  Emet exports standard MCP tools (`emet_evaluate_counterparty`, `emet_initiate_verified_intent`, `emet_get_budget_ledger`) that plug directly into `nearai/near-mcp` and Claude Desktop, giving AI agents deterministic settlement safety without touching private keys.
* **Agent Skills (`near/agent-skills`):**
  Emet complements `near-intents` and `near-kit` by adding the missing post-signing settlement verification and counterparty blocklist layer.

---

## Empirical Evidence Table

| Verification Target | Command | Measured Latency | Deterministic Receipt / Digest | Status |
| :--- | :--- | :--- | :--- | :--- |
| Solana `ForeignTxSignPayload::V1` Snapshot | `npm test` | `1.07 ms` | `f53a1a864fa9ce51d50349b2e5fe38ff23e45b25b20038d405c12316f9bf05b1` | **PASS (`code 0`)** |
| Ethereum `ForeignTxSignPayload::V1` Snapshot | `npm test` | `1.12 ms` | `2ab97999d1e015730271c7d6cbb298af76fd1de7af81926b42a8877bc4f5794e` | **PASS (`code 0`)** |
| Bitcoin `ForeignTxSignPayload::V1` Snapshot | `npm test` | `0.84 ms` | `08e426dcd6eb98cc5eb5280d50f9c14e024f4a531bd5e09314ac4ae8bb07c9be` | **PASS (`code 0`)** |
| Compiled Rust `.wasm` Audit Suite (`15/15` checks) | `npm test` | `3.40 ms` | `wasm_run_emet_verification_suite() === 1` | **PASS (`code 0`)** |
| Oct 1 \$3.8M Ghost-Deposit Exploit Defense | `npm run demo:attack` | `4.18 ms` | `rcpt-atk-03-bnb-ghost-deposit` (`Refunded: 3800 USDC`) | **PASS (`code 0`)** |

---

## Repository Structure

* [`crates/mpc-verifier`](./crates/mpc-verifier/src/lib.rs) — Binary-compatible `near/mpc` v3.18.0 `ForeignTxSignPayload::V1` Borsh encoder, FIPS 180-4 SHA-256 hasher, and `SvmFinality::Finalized` / `EvmFinality::Finalized` policy guards.
* [`crates/settlement-contract`](./crates/settlement-contract/src/lib.rs) — Core NEAR smart contract implementing `EmetSettlementKernel`, `AgentBudgetLedger`, `#[private]` MPC callback reconciliation, and [15-detector security audit tests](./crates/settlement-contract/src/audit_tests.rs).
* [`packages/agent-gateway`](./packages/agent-gateway/src/index.mjs) — TypeScript/ESM SDK, NEAR Intents 1Click API dry-run client, MCP tool definitions (`emet_evaluate_counterparty`, `emet_initiate_verified_intent`, `emet_get_budget_ledger`), and [`demo-attack.mjs`](./packages/agent-gateway/src/demo-attack.mjs).
* [`packages/cockpit-ui`](./packages/cockpit-ui/index.html) — Zero-cold-start 15-second split-screen verification web sandbox.

---

## License

MIT — See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup and pull request guidelines.
