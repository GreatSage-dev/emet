# Emet Task Breakdown & Verification Ledger

## Task 1: Workspace Foundation & `emet-mpc-verifier` Crate
**Description:** Initialize clean Git repository (ignoring reference clones), root `Cargo.toml`, and `crates/mpc-verifier` implementing `ForeignChainRpcRequest`, `SvmFinality`, `EvmFinality`, `ForeignTxSignPayload::V1`, `VerifyForeignTransactionRequestArgs`, and `InspectorVerdict`.
**Acceptance criteria:**
- [x] `ForeignTxSignPayload::V1::compute_msg_hash()` matches official `near/mpc` v3.18.0 SHA-256 snapshot hashes byte-for-byte for Solana (`f53a1a864fa9ce51d50349b2e5fe38ff23e45b25b20038d405c12316f9bf05b1`), Ethereum (`2ab97999d1e015730271c7d6cbb298af76fd1de7af81926b42a8877bc4f5794e`), and Bitcoin (`08e426dcd6eb98cc5eb5280d50f9c14e024f4a531bd5e09314ac4ae8bb07c9be`).
- [x] Enforces `SvmFinality::Finalized` and `EvmFinality::Finalized` policy validation (rejecting unfinalized `Confirmed`/`Latest` states for settlement).
**Verification:**
- [x] Tests pass: `cargo check --workspace` & WASM in-VM execution

## Task 2: `emet-settlement-contract` Smart Contract & `near-contract-audit` Suite
**Description:** Implement the NEAR smart contract (`crates/settlement-contract`) with double-entry agent wallet budget ledger (`available`, `in_flight`, `settled_spent`), Function-Call Key allowance/method guards, 4-state intent lifecycle (`Initiated` → `FundsEscrowed` → `VerifyingOutcome` → `Settled` / `Refunded`), and `#[private]` MPC callback.
**Acceptance criteria:**
- [x] Valid MPC `VerifyForeignTransactionResponse` with matching `payload_hash` transitions intent to `Settled`, moves `in_flight` to `settled_spent`, and emits `SettlementReceipt`.
- [x] Reverted foreign tx, non-canonical fork, or mismatched `payload_hash` transitions intent to `Refunded` and restores `in_flight` to `available`.
- [x] Passes 100% of unit and adversarial tests covering the $3.8M ghost-deposit exploit, runaway retry drain, unauthorized callback access, and epoch spending limit enforcement.
**Verification:**
- [x] Tests pass: `cargo build --target wasm32-unknown-unknown --release` + `wasm_run_emet_verification_suite() === 1`

## Checkpoint: After Tasks 1-2 (Rust Core Verified)
- [x] Rust WASM contract compiles and passes all assertions with `exit code 0`
- [x] Atomic git commits recorded

## Task 3: `agent-gateway` SDK, 1Click API Client, MCP Server & Adversarial Attack Demo
**Description:** Build the TypeScript/ESM package (`packages/agent-gateway`) providing the Emet Agent SDK, NEAR Intents 1Click API client (`dry: true` live preview + deterministic fallback), MCP tool definitions (`emet_evaluate_counterparty`, `emet_initiate_verified_intent`, `emet_get_budget_ledger`), and runnable `demo:attack` script.
**Acceptance criteria:**
- [x] `npm test` verifies budget policy checks, payload hash calculation parity with Rust, 1Click quote parsing, and MCP tool handlers.
- [x] `npm run demo:attack` executes 5 adversarial & control scenarios and prints structured verification receipts.
**Verification:**
- [x] Tests pass: `npm test` and `npm run demo:attack`

## Task 4: Split-Screen Cockpit UI (`cockpit-ui`) & 5-Second Hero `README.md`
**Description:** Build the 15-second split-screen interactive web sandbox (`packages/cockpit-ui`) comparing Naive Agent Execution vs. Emet MPC Kernel, plus the root `README.md` and `CONTRIBUTING.md`.
**Acceptance criteria:**
- [x] Split-screen UI renders side-by-side Naive Status Quo vs. Emet Superpower with interactive 1-click scenario triggers (Valid Solana Swap, $3.8M Ghost Deposit Attack, Stalled Bridge Relayer Nonce Recovery, Prompt-Injected Overdraft).
- [x] Complete state machines and tabular monospace typography.
- [x] `npm run build` succeeds with zero bundler errors.
**Verification:**
- [x] Build succeeds: `npm run build`
