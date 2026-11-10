# Contributing to Emet

Thank you for contributing to **Emet**, the open-source outcome-verified budget and cross-chain settlement kernel for autonomous agents on NEAR.

## Local Development Setup

1. **Prerequisites:**
   * Rust `1.85+` with the `wasm32-unknown-unknown` target installed (`rustup target add wasm32-unknown-unknown`)
   * Node.js `v20+`

2. **Build & Verify:**
   ```bash
   cargo check --workspace
   npm run build:wasm
   npm run build
   npm test
   npm run demo:attack
   ```

## Pull Request Checklist

- [ ] All new contract methods follow strict **Checks-Effects-Interactions (CEI)** ordering.
- [ ] All cross-contract callbacks enforce `assert_private_callback`.
- [ ] Any change to `crates/mpc-verifier` maintains byte-for-byte hash parity with the `near/mpc` v3.18.0 snapshot tests.
- [ ] `npm test` and `npm run demo:attack` exit with `code === 0`.

## Open Roadmap Issues (`good first issue` / `help wanted`)

1. **`[good first issue]` Add Starknet (`StarknetFinality::AcceptedOnL1`) and Sui (`SuiFinality::Checkpointed`) extractor helpers** in `crates/mpc-verifier/src/lib.rs`.
2. **`[help wanted]` Wire x402 HTTP 402 PingPay Agent Pay receipt headers** into `packages/agent-gateway/src/index.mjs` so agents can attach an Emet `SettlementReceipt` directly to HTTP 402 API calls.
3. **`[good first issue]` Add NEP-413 signed message verification** for off-chain human approval of `CounterpartyDecision::Warn` quarantines.
