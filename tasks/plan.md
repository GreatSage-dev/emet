# Implementation Plan: Emet (Outcome-Verified Agent Budget & Cross-Chain Settlement Kernel on NEAR)

## Overview
We are building **Emet**, the Outcome-Verified Double-Entry Budget & Cross-Chain Settlement Kernel for Autonomous Agents on NEAR (`tracks: ["security", "defi", "agents"]`). Emet combines **NEAR Function-Call Access Key** budget policies before signing with **NEAR MPC (`v1.signer-prod.testnet`)** `verify_foreign_transaction` (`ForeignTxSignPayload::V1`, `SvmFinality::Finalized`, `EvmFinality::Finalized`) outcome reconciliation after signing—preventing both the **\$3.8M NEAR Intents Ghost-Deposit Exploit** and **Runaway Agent Retry Drain**.

## Architecture Decisions
- **100% Binary Wire Compatibility with `near/mpc` v3.18.0:** `crates/mpc-verifier` implements the exact Borsh/JSON wire format of `VerifyForeignTransactionRequestArgs`, `ForeignChainRpcRequest`, `ForeignTxSignPayload::V1`, and `Verdict` from `near-mpc-contract-interface`, verified against the official `near/mpc` SHA-256 snapshot hashes (`f53a1a86...` for Solana, `2ab97999...` for Ethereum, `08e426dc...` for Bitcoin).
- **Double-Entry Agent Budget Ledger (`available` / `in_flight` / `settled_spent`):** In `crates/settlement-contract`, initiating an intent moves funds from `available` to `in_flight` (strictly following Checks-Effects-Interactions). Only a verified `#[private]` callback from `v1.signer-prod.testnet` with matching `payload_hash` settles the trade (`EMET`); any `TransactionFailed`, `NonCanonicalBlock`, or mismatched hash atomically refunds `in_flight` back to `available` (`MET`).
- **Ponytail Simplicity Discipline:** Zero bloated abstractions or unused config layers. Every file does one job cleanly and has direct deterministic tests (`cargo test` and `npm test` exiting `code === 0`).

## Task List

### Phase 1: Foundation & Rust MPC Wire Primitives (`mpc-verifier`)
- [ ] Task 1: Initialize Git repository, `.gitignore`, Cargo workspace, and `crates/mpc-verifier` with `near/mpc` v3.18.0 snapshot parity tests.

### Checkpoint: Foundation
- [ ] `cargo test -p emet-mpc-verifier` passes with 100% snapshot hash parity (`exit code 0`).

### Phase 2: Core NEAR Smart Contract (`settlement-contract`)
- [ ] Task 2: Implement `crates/settlement-contract` with double-entry agent budget policies, Function-Call Access Key guards, 4-state intent lifecycle, `#[private]` MPC callback, and 15-detector `near-contract-audit` test suite.

### Checkpoint: Smart Contract
- [ ] `cargo test --workspace` passes all unit, state-machine, and adversarial security tests (`exit code 0`).

### Phase 3: Agent Gateway, 1Click Intents Client, MCP Server & Attack Demo (`agent-gateway`)
- [ ] Task 3: Build `packages/agent-gateway` with TypeScript SDK, live/deterministic NEAR Intents 1Click quote client (`dry: true`), MCP Server tool definitions, and `npm run demo:attack` adversarial exploit simulation.

### Checkpoint: Agent Gateway & Attack Demo
- [ ] `npm test` and `npm run demo:attack` pass deterministically (`exit code 0`).

### Phase 4: 15-Second Split-Screen Cockpit UI & 5-Second Hero README (`cockpit-ui`)
- [ ] Task 4: Build `packages/cockpit-ui` (Split-Screen Naive Status Quo vs. Emet MPC Kernel) and author the machine+human optimized `README.md`.

### Checkpoint: Complete
- [ ] All acceptance criteria met (`cargo test`, `npm test`, `npm run demo:attack`, `npm run build` all `exit code 0`).

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| External RPC rate limits during automated screening (Q-017) | High | All `cargo test`, `npm test`, and `demo:attack` runs execute deterministically against embedded byte-accurate `near/mpc` fixtures while supporting live testnet/1Click queries when online. |
| Borsh enum variant ordering mismatch with `v1.signer-prod.testnet` | High | Pin enum variant indices and verify SHA-256 output against official `near/mpc` v3.18.0 insta snapshots in unit tests. |
| Reentrancy or unguarded callback mutation | High | Enforce strict CEI ordering, `#[private]` macro on callbacks, and explicit unit tests for all 15 `near-contract-audit` detectors. |
