# Spec: Emet — Outcome-Verified Agent Budget & Cross-Chain Settlement Kernel on NEAR

## 0. Capability Map & Framing Architecture

### The Framing Synthesis (Multi-Track Alignment: `["security", "defi", "agents"]`)
Instead of building a narrow escrow wrapper, this system is framed and engineered as **the Outcome-Verified Double-Entry Budget & Settlement Kernel for Autonomous Agents on NEAR**:

1. **Why `security` (AI Security & Defense — *"Trust, but verify"*):**
   - **Pre-Signing Scope Enforcement:** Autonomous agents never hold a `FullAccess` key. They operate exclusively through a **NEAR Function-Call Access Key** (`AccessKeyPermission::FunctionCall`) scoped strictly to this contract's `initiate_intent` method with a hard per-epoch and per-tx budget ceiling.
   - **Post-Signing Outcome Reconciliation:** Unlike pre-signing policy wrappers (e.g., OutLayer) that go blind the moment a signature leaves NEAR, our contract holds the agent's budget in an `InFlight` lock and refuses to finalize settlement or release counter-funds until **NEAR MPC (`v1.signer-prod.testnet`)** cryptographically verifies the destination chain outcome (`verify_foreign_transaction` with `SvmFinality::Finalized` on Solana or block depth on Bitcoin/EVM).
   - **Adversarial & Exploit Immunity:** Stops both the **\$3.8M Ghost-Deposit Exploit** (where a failed foreign chain deposit tricks an unverified notifier into releasing NEAR funds) and **Runaway Agent Retry Drain** (where an LLM agent retries a stalled bridge transfer 10x and drains its wallet).

2. **Why `defi` (Unstoppable DeFi — *"Markets that never close"*):**
   - Integrates **NEAR Intents 1Click REST API** (`dry: true` live quote preview + `dry: false` execution tracking) with a NEAR smart contract vault that derives foreign chain addresses directly via **NEAR Chain Signatures (`sign`)**.
   - **Formula 1 Two-Stroke Unlock:** Because counterparty default and ghost-deposit risks are eliminated deterministically at the protocol layer, solvers can quote 10x tighter spreads without holding 30% hazard buffers.

3. **Why `agents` (Agent Economy — *"Give AI a wallet"*):**
   - Exposes an **MCP Server & Agent Skill** (`agent-gateway`) compatible with `nearai/near-mcp` and `Agent Connect` (`agentsonintents.com`), issuing a tamper-proof cryptographic receipt (`SettlementReceipt`) for every cross-chain action.

---

### Capability Map

| Module ID | Responsibility | Depends On |
| :--- | :--- | :--- |
| `mpc-verifier` | Rust types, Borsh/JSON DTOs, and verification logic for `v1.signer-prod.testnet` (`verify_foreign_transaction`, `sign`, `SvmFinality::Finalized`, `Verdict<V>`) + deterministic local mock MPC contract for sandbox testing | — |
| `settlement-contract` | Core NEAR Rust smart contract implementing the 4-state settlement machine (`Initiated` → `FundsEscrowed` → `VerifyingOutcome` → `Settled` / `Refunded`), agent double-entry budget ledger, and Function-Call Key guards | `mpc-verifier` |
| `agent-gateway` | TypeScript SDK, MCP Server, NEAR Intents 1Click API client (`dry: true` live quotes), and runnable adversarial attack/exploit CLI verification suite (`near-kit/sandbox`) | `settlement-contract` |
| `cockpit-ui` | 15-second split-screen verification web interface (`@near-kit/react` + Next.js/Vite) comparing Naive Unverified Execution (loss) vs. MPC-Verified Settlement (deterministic recovery) with zero-login sandbox mode | `agent-gateway` |

**Build Order:** `mpc-verifier` → `settlement-contract` → `agent-gateway` → `cockpit-ui`

---

## 1. Objective

Build a production-grade, open-source NEAR smart contract and autonomous agent settlement toolkit that prevents cross-chain ghost funds, stalled relayer desynchronization, and runaway agent budget drain.

### Concrete Acceptance Criteria ("Do X → See Y" for Screening Bots & Human Judges)
1. **Deterministic Contract Compilation & Audit Compliance:**
   - Running `cargo test --workspace` compiles `mpc-verifier` and `settlement-contract` cleanly and passes 100% of unit and state-machine property tests with `exit code 0`.
   - Zero violations across all 15 detectors in `near-contract-audit` (`#[private]` callbacks, CEI reentrancy protection, `U128` JSON serialization, `assert_one_yocto` on administrative mutations, explicit gas reservation).
2. **Sandbox Integration & Adversarial Attack Simulation (`npm test` & `npm run demo:attack`):**
   - Spins up a real local NEAR node via `near-kit/sandbox` (or deterministic WASM VM harness) and executes three end-to-end scenarios with byte-for-byte historical transaction fixtures:
     - **Scenario A (Valid Finalized Solana Swap):** `v1.signer` returns `Verdict::Extracted` with `SvmFinality::Finalized` → Escrow settles, agent `in_flight` debit converts to `settled_spent`, cryptographic receipt emitted.
     - **Scenario B (The \$3.8M Ghost-Deposit Exploit Attempt):** Adversarial caller submits a reverted/failed foreign tx (`Verdict::TransactionFailed`) or unfinalized fork (`Verdict::NonCanonicalBlock`) → Contract rejects settlement, slashes bad solver bond (if applicable), and atomically refunds the agent's budget ledger.
     - **Scenario C (Prompt-Injected Agent Budget Overflow & Key Scope Violation):** Compromised agent attempts to exceed its epoch spending cap, pay a blocked counterparty, or replay a pending intent nonce → Blocked deterministically before cross-contract signing.
3. **Live Testnet Deployment & Dry-Run 1Click Quote Verification:**
   - Contract deployed to NEAR Testnet, wired to `v1.signer-prod.testnet`.
   - Live CLI and UI dry-run mode fetches real cross-chain quotes from NEAR Intents 1Click API (`https://1click.chaindefuser.com/v0/quote` with `dry: true`) so judges can test with zero wallet setup.
4. **15-Second Split-Screen Cockpit UI:**
   - Interactive web dashboard showing side-by-side execution of a Naive Agent Wallet vs. Our Protected Settlement Kernel, displaying real-time ledger states (`available`, `in_flight`, `settled`), gas receipts, and verification proofs.

---

## 2. Tech Stack

- **Smart Contracts:** Rust (`rustc 1.98.0`), `near-sdk = "5.7.0"`, `borsh`, `serde`, `serde_json`, `schemars`
- **NEAR MPC Interface:** Exact DTO definitions grounded in `near/mpc` (`v3.18.0` / `v1.signer-prod.testnet`): `ForeignChain`, `SvmFinality`, `VerifyForeignTransactionRequest`, `Verdict`
- **SDK & Integration Harness:** TypeScript (`Node.js v24.18.0`), `near-kit`, `@modelcontextprotocol/sdk` (for the Agent MCP server), Vitest
- **Frontend Cockpit:** React 19 + Vite + TypeScript + Tailwind CSS (high-density technical terminal aesthetic, `JetBrains Mono` for hashes/ledgers + `Inter`/`Plus Jakarta Sans` for UI)

---

## 3. Commands

```bash
# Rust Smart Contracts & Verifier Primitives
cargo check --workspace
cargo test --workspace -- --nocapture
cargo build --target wasm32-unknown-unknown --release

# TypeScript Agent Gateway, Sandbox Tests & Adversarial Demo
npm test
npm run demo:attack
npm run demo:quote

# Interactive Split-Screen Cockpit UI
npm run build
npm run dev
```

---

## 4. Project Structure

```text
.
├── Cargo.toml                     # Rust workspace manifest
├── package.json                   # Node.js workspace manifest (agent-gateway + cockpit-ui)
├── HACKATHON.md                   # Official NEAR Hackathon rules & submission schema
├── SPEC.md                        # This master specification
├── crates/
│   ├── mpc-verifier/              # ForeignChainInspector DTOs, SvmFinality, Verdict, & mock signer
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── settlement-contract/       # Core NEAR smart contract (Budget ledger + 4-state escrow)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs             # Contract entrypoints & #[private] MPC callbacks
│           ├── budget.rs          # Double-entry agent wallet budget & policy engine
│           ├── state.rs           # IntentState machine (Initiated -> Escrowed -> Verifying -> Settled/Refunded)
│           └── audit_tests.rs     # Deterministic unit + adversarial security tests
├── packages/
│   ├── agent-gateway/             # TypeScript SDK, 1Click API client, MCP tool server, attack demo CLI
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── intents-client.ts  # NEAR Intents 1Click API (dry-run & wet quotes)
│   │   │   ├── mcp-server.ts      # Model Context Protocol tool definitions for AI agents
│   │   │   └── demo-attack.ts     # Reproducible adversarial exploit & defense script
│   │   └── tests/
│   │       └── settlement.test.ts # Deterministic verification suite
│   └── cockpit-ui/                # 15-Second Split-Screen Interactive Verification Sandbox
│       ├── src/
│       └── index.html
└── README.md                      # 5-Second Hero README (Machine & Human optimized)
```

---

## 5. Code Style

Every contract method enforces **Checks-Effects-Interactions (CEI)**, uses `U128` at JSON boundaries, and isolates callback mutation behind `#[private]`:

```rust
#[near]
impl SettlementKernel {
    /// Initiates a cross-chain intent if and only if the agent's reconciled budget
    /// and counterparty policy permit the debit.
    pub fn initiate_intent(
        &mut self,
        intent_id: String,
        amount: U128,
        target_chain: ForeignChain,
        expected_tx_hash: [u8; 32],
    ) -> Promise {
        let caller = env::predecessor_account_id();
        // 1. CHECKS: Verify agent registration, counterparty rules, and available budget
        let mut policy = self.agent_policies.get(&caller).expect("ERR_AGENT_NOT_REGISTERED").clone();
        policy.assert_can_spend(amount.0, env::block_timestamp_ms());

        // 2. EFFECTS: Move funds from `available` to `in_flight` before external call
        policy.lock_in_flight(amount.0);
        self.agent_policies.insert(caller.clone(), policy);
        self.intents.insert(intent_id.clone(), IntentRecord::new_verifying(caller, amount.0, target_chain.clone(), expected_tx_hash));

        // 3. INTERACTIONS: Invoke NEAR MPC Foreign Chain Verifier with explicit gas reservation
        ext_mpc_signer::ext(self.mpc_contract_id.clone())
            .with_static_gas(MPC_VERIFY_GAS)
            .verify_foreign_transaction(VerifyForeignTransactionRequest {
                chain: target_chain,
                tx_hash: expected_tx_hash,
                finality: ForeignFinality::Svm(SvmFinality::Finalized),
            })
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_foreign_tx_verified(intent_id),
            )
    }
}
```

---

## 6. Testing Strategy

1. **Level 1 — Rust Contract Unit & Property Tests (`cargo test`):**
   - Tests every state transition (`Initiated`, `FundsEscrowed`, `VerifyingOutcome`, `Settled`, `Refunded`).
   - Tests every adversarial vector from `near-contract-audit` (unauthorized callback invocation, integer overflow, double-settlement replay, non-canonical Solana fork rejection, budget cap bypass).
2. **Level 2 — Deterministic Cross-Contract & Exploit Replay (`npm test` / `npm run demo:attack`):**
   - Executes real historical Solana/BNB transaction fixtures against the state machine and outputs human-readable and machine-parseable verification receipts (`exit code 0`).
3. **Level 3 — Live Network & Zero-Cold-Start UI Verification:**
   - Queries live `v1.signer-prod.testnet` on NEAR Testnet + live NEAR Intents 1Click API (`dry: true`), with pre-seeded deterministic fallback fixtures so the UI works in <50ms even if external RPCs rate-limit during judging.

---

## 7. Boundaries

- **Always do:**
  - Run `cargo test` and `npm test` after every slice and verify `exit code === 0`.
  - Follow `near-contract-audit` rules (all callbacks `#[private]`, all JSON amounts `U128`, strict CEI ordering).
  - Document why Function-Call Access Keys are used and their gas/transfer limits in `README.md`.
- **Ask first:**
  - Changing the core 4-state settlement state machine or adding external heavyweight dependencies.
  - Deploying to live testnet/mainnet accounts or submitting the final application payload.
- **Never do:**
  - Commit private keys, `.env` secrets, `// TODO` comments, fake `mockData` frontend arrays, or dead UI buttons.
  - Send the final hackathon submission POST request without printing the payload and receiving explicit human confirmation.

---

## 8. Success Criteria

- [ ] `cargo test --workspace` passes 100% of unit and adversarial tests with `exit code 0`.
- [ ] `npm run demo:attack` reproduces and blocks (1) the \$3.8M ghost-deposit exploit, (2) a non-canonical Solana micro-fork, and (3) a prompt-injected agent budget overrun.
- [ ] `npm test` passes all SDK, 1Click dry-run quote, and MCP tool server assertions with `exit code 0`.
- [ ] `cockpit-ui` builds cleanly (`npm run build`) and demonstrates the 15-second split-screen comparison with real interactive state transitions.
- [ ] `README.md` satisfies both the 5-Second Hero Standard and the `HACKATHON.md` Q-017 machine-screening standard ("Do X → See Y").

---

## 9. Open Questions for Human Confirmation

1. **Final Project Name:** Let's lock the official name right now so all crate names, contract structs, CLI commands, and UI headers match:
   - **Option A: `Ironclad`** (*"Ironclad: Outcome-verified budget & cross-chain settlement kernel for autonomous agents on NEAR"*)
   - **Option B: `Tally`** (*"Tally: Deterministic double-entry cross-chain settlement for NEAR agents"*)
   - **Option C: `Emet`** (*"Emet: Cryptographic truth & settlement verification on NEAR"*)
2. **Spec & Framing Approval:** Does the 3-track framing (`["security", "defi", "agents"]`) and 4-module capability map (`mpc-verifier` → `settlement-contract` → `agent-gateway` → `cockpit-ui`) look good to proceed to implementation?
