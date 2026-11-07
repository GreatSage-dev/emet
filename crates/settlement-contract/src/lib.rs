//! Emet — Outcome-Verified Agent Budget & Cross-Chain Settlement Kernel on NEAR.
//!
//! Enforces all 15 `near-contract-audit` security invariants:
//! 1. Private callback enforcement (`assert_private_callback` / `#[private]`)
//! 2. Checks-Effects-Interactions (CEI) reentrancy immunity
//! 3. String-safe `U128String` at JSON boundaries to prevent IEEE-754 precision loss
//! 4. Persistent state mutation verification
//! 5. Explicit owner & registered agent caller checks
//! 6. 1-yoctoNEAR deposit assertion (`assert_one_yocto`) on administrative mutations
//! 7. Distinct storage collection prefixes
//! 8. Explicit initialization guard (`initialized` flag)
//! 9. Bounded per-call iteration (anti-gas-griefing)
//! 10. Zero reliance on predictable block randomness
//! 11. Explicit minimum prepaid gas reservation for MPC cross-contract call + callback
//! 12. Storage deposit coverage check
//! 13. Checked arithmetic (`checked_add`, `checked_sub`)
//! 14. Zero floating-point arithmetic (`u128` integer basis points only)
//! 15. Function-Call Access Key scope verification (blocks `FullAccess` keys for autonomous agents)

pub use emet_mpc_verifier::{
    verify_near_mpc_snapshots, DomainId, ForeignChain, ForeignChainRpcRequest,
    ForeignTxPayloadVersion, ForeignTxSignPayload, Hash256, InspectorVerdict,
    VerifyForeignTransactionRequestArgs,
};
use std::collections::{BTreeMap, BTreeSet};

pub mod audit_tests;
#[cfg(target_arch = "wasm32")]
pub mod near_runtime;

/// Gas constants (in NEAR Tgas units: 1 Tgas = 10^12 gas).
pub const MPC_VERIFY_GAS: u64 = 100_000_000_000_000; // 100 Tgas for `v1.signer-prod.testnet`
pub const CALLBACK_GAS: u64 = 50_000_000_000_000;    // 50 Tgas for `on_foreign_tx_verified`
pub const MIN_REQUIRED_PREPAID_GAS: u64 = MPC_VERIFY_GAS + CALLBACK_GAS + 20_000_000_000_000;

/// Maximum intents returned in a single paginated view call (`near-contract-audit`: anti-gas-griefing).
pub const MAX_PAGE_LIMIT: usize = 50;

/// JSON-safe string wrapper for `u128` yoctoNEAR/token amounts (`near-contract-audit`: `incorrect-argument-or-return-types`).
#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct U128String(pub u128);

impl U128String {
    pub fn to_json_string(&self) -> String {
        format!("\"{}\"", self.0)
    }

    pub fn from_json_string(s: &str) -> Result<Self, &'static str> {
        let trimmed = s.trim_matches('"');
        let val = trimmed.parse::<u128>().map_err(|_| "Invalid u128 string")?;
        Ok(Self(val))
    }
}

/// Access key type used by the caller (`06-security.md`).
#[derive(Debug, Clone, Eq, PartialEq)]
pub enum CallerKeyPermission {
    FunctionCall {
        receiver_id: String,
        method_names: Vec<String>,
        allowance_yocto: U128String,
    },
    FullAccess,
}

/// Execution context injected by the NEAR runtime or deterministic sandbox test harness.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ExecutionContext {
    pub current_account_id: String,
    pub predecessor_account_id: String,
    pub signer_account_id: String,
    pub attached_deposit: u128,
    pub prepaid_gas: u64,
    pub block_timestamp_ms: u64,
    pub key_permission: CallerKeyPermission,
}

/// Double-entry budget & policy state for an autonomous agent wallet.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct AgentBudgetLedger {
    pub agent_id: String,
    pub owner_id: String,
    pub available_balance: U128String,
    pub in_flight_locked: U128String,
    pub settled_spent: U128String,
    pub refunded_saved: U128String,
    pub max_per_tx: U128String,
    pub epoch_spend_cap: U128String,
    pub current_epoch_exposure: U128String,
    pub epoch_started_at_ms: u64,
    pub allowed_counterparties: BTreeSet<String>,
    pub last_nonce: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum CounterpartyDecision {
    Allow {
        risk_bps: u16,
        solver_spread_bps: u16,
        reason: String,
    },
    Warn {
        risk_bps: u16,
        reason: String,
    },
    Block {
        reason: String,
        evidence_tx_hash: Option<String>,
    },
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CounterpartyProfile {
    pub receiver_id: String,
    pub account_age_days: u32,
    pub is_contract: bool,
    pub code_changed_recently: bool,
    pub prior_successful_settlements: u32,
    pub reported_malicious_by: Vec<(String, String)>,
}

/// 4-State Deterministic Intent Lifecycle.
#[derive(Debug, Clone, Eq, PartialEq)]
pub enum IntentStatus {
    Initiated,
    FundsEscrowed,
    VerifyingOutcome,
    Settled {
        verified_at_ms: u64,
        mpc_payload_hash: String,
        mpc_signature_hex: String,
    },
    Refunded {
        refunded_at_ms: u64,
        reason: String,
    },
}

/// Tamper-proof cryptographic receipt issued upon settlement or refund (`07-agents.md`).
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SettlementReceipt {
    pub receipt_id: String,
    pub intent_id: String,
    pub agent_id: String,
    pub counterparty_id: String,
    pub target_chain: ForeignChain,
    pub amount: U128String,
    pub solver_spread_bps: u16,
    pub naive_unverified_spread_bps: u16,
    pub expected_payload_hash: String,
    pub status: IntentStatus,
    pub issued_at_ms: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CrossChainIntent {
    pub intent_id: String,
    pub agent_id: String,
    pub counterparty_id: String,
    pub amount: U128String,
    pub nonce: u64,
    pub target_chain: ForeignChain,
    pub mpc_request: VerifyForeignTransactionRequestArgs,
    pub expected_payload_hash: Hash256,
    pub status: IntentStatus,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum KernelError {
    AlreadyInitialized,
    NotInitialized,
    UnauthorizedOwner,
    RequiresOneYoctoDeposit,
    AgentNotRegistered(String),
    FullAccessKeyForbiddenForAgent,
    InvalidFunctionCallScope(String),
    InsufficientPrepaidGas { provided: u64, required: u64 },
    NonMonotonicNonce { provided: u64, last_nonce: u64 },
    IntentAlreadyExists(String),
    IntentNotFound(String),
    IntentNotVerifying(String),
    ExceedsPerTxLimit { requested: u128, max_per_tx: u128 },
    ExceedsEpochCap { requested_exposure: u128, cap: u128 },
    InsufficientAvailableBudget { requested: u128, available: u128 },
    CounterpartyBlocked { counterparty: String, reason: String },
    CounterpartyRequiresHumanApproval { counterparty: String, reason: String },
    MissionAssetForbidden { token_out: String },
    MissionSlippageExceeded { expected_min_out: u128, actual_out: u128 },
    FinalityPolicyViolation(String),
    PrivateCallbackOnly,
    ArithmeticOverflow,
}

#[derive(Debug, Clone)]
pub struct EmetSettlementKernel {
    pub initialized: bool,
    pub owner_id: String,
    pub mpc_signer_contract_id: String,
    pub default_domain_id: DomainId,
    pub agents: BTreeMap<String, AgentBudgetLedger>,
    pub intents: BTreeMap<String, CrossChainIntent>,
    pub receipts: BTreeMap<String, SettlementReceipt>,
    pub counterparties: BTreeMap<String, CounterpartyProfile>,
}

impl EmetSettlementKernel {
    pub fn init(owner_id: String, mpc_signer_contract_id: String) -> Result<Self, KernelError> {
        Ok(Self {
            initialized: true,
            owner_id,
            mpc_signer_contract_id,
            default_domain_id: DomainId(3),
            agents: BTreeMap::new(),
            intents: BTreeMap::new(),
            receipts: BTreeMap::new(),
            counterparties: BTreeMap::new(),
        })
    }

    fn assert_initialized(&self) -> Result<(), KernelError> {
        if !self.initialized {
            return Err(KernelError::NotInitialized);
        }
        Ok(())
    }

    fn assert_owner(&self, ctx: &ExecutionContext) -> Result<(), KernelError> {
        self.assert_initialized()?;
        if ctx.predecessor_account_id != self.owner_id {
            return Err(KernelError::UnauthorizedOwner);
        }
        if ctx.attached_deposit != 1 {
            return Err(KernelError::RequiresOneYoctoDeposit);
        }
        Ok(())
    }

    fn assert_private_callback(&self, ctx: &ExecutionContext) -> Result<(), KernelError> {
        self.assert_initialized()?;
        if ctx.predecessor_account_id != ctx.current_account_id {
            return Err(KernelError::PrivateCallbackOnly);
        }
        Ok(())
    }

    pub fn register_agent(
        &mut self,
        ctx: &ExecutionContext,
        agent_id: String,
        initial_budget: U128String,
        max_per_tx: U128String,
        epoch_spend_cap: U128String,
        allowed_counterparties: Vec<String>,
    ) -> Result<AgentBudgetLedger, KernelError> {
        self.assert_initialized()?;
        if ctx.attached_deposit < initial_budget.0 {
            return Err(KernelError::InsufficientAvailableBudget {
                requested: initial_budget.0,
                available: ctx.attached_deposit,
            });
        }

        let ledger = AgentBudgetLedger {
            agent_id: agent_id.clone(),
            owner_id: ctx.predecessor_account_id.clone(),
            available_balance: initial_budget,
            in_flight_locked: U128String(0),
            settled_spent: U128String(0),
            refunded_saved: U128String(0),
            max_per_tx,
            epoch_spend_cap,
            current_epoch_exposure: U128String(0),
            epoch_started_at_ms: ctx.block_timestamp_ms,
            allowed_counterparties: allowed_counterparties.into_iter().collect(),
            last_nonce: 0,
        };
        self.agents.insert(agent_id, ledger.clone());
        Ok(ledger)
    }

    pub fn upsert_counterparty_profile(
        &mut self,
        ctx: &ExecutionContext,
        profile: CounterpartyProfile,
    ) -> Result<(), KernelError> {
        self.assert_owner(ctx)?;
        self.counterparties
            .insert(profile.receiver_id.clone(), profile);
        Ok(())
    }

    pub fn report_malicious_counterparty(
        &mut self,
        ctx: &ExecutionContext,
        counterparty_id: String,
        evidence_tx_hash: String,
    ) -> Result<(), KernelError> {
        self.assert_initialized()?;
        if !self.agents.contains_key(&ctx.predecessor_account_id) {
            return Err(KernelError::AgentNotRegistered(
                ctx.predecessor_account_id.clone(),
            ));
        }

        let entry = self
            .counterparties
            .entry(counterparty_id.clone())
            .or_insert(CounterpartyProfile {
                receiver_id: counterparty_id,
                account_age_days: 0,
                is_contract: false,
                code_changed_recently: false,
                prior_successful_settlements: 0,
                reported_malicious_by: Vec::new(),
            });
        entry
            .reported_malicious_by
            .push((ctx.predecessor_account_id.clone(), evidence_tx_hash));
        Ok(())
    }

    pub fn evaluate_counterparty(&self, counterparty_id: &str) -> CounterpartyDecision {
        let Some(profile) = self.counterparties.get(counterparty_id) else {
            return CounterpartyDecision::Warn {
                risk_bps: 500,
                reason: "Unknown counterparty with zero settlement history".to_string(),
            };
        };

        if let Some((reporter, evidence)) = profile.reported_malicious_by.first() {
            return CounterpartyDecision::Block {
                reason: format!("Flagged on shared agent blocklist by {reporter}"),
                evidence_tx_hash: Some(evidence.clone()),
            };
        }

        if profile.is_contract && profile.code_changed_recently {
            return CounterpartyDecision::Warn {
                risk_bps: 350,
                reason: "Receiver contract WASM code modified within 24h quarantine window"
                    .to_string(),
            };
        }

        if profile.account_age_days < 3 && profile.prior_successful_settlements == 0 {
            return CounterpartyDecision::Warn {
                risk_bps: 250,
                reason: "Newly created account (<3 days) with no prior verified settlements"
                    .to_string(),
            };
        }

        let solver_spread_bps = if profile.prior_successful_settlements >= 5 {
            10
        } else {
            15
        };

        CounterpartyDecision::Allow {
            risk_bps: 5,
            solver_spread_bps,
            reason: format!(
                "Verified counterparty ({} prior MPC settlements, {}d age)",
                profile.prior_successful_settlements, profile.account_age_days
            ),
        }
    }

    pub fn evaluate_token_diff_mission(
        &self,
        allowed_tokens: &BTreeSet<String>,
        token_out: &str,
        amount_in: u128,
        amount_out: u128,
        min_return_bps: u16,
    ) -> Result<(), KernelError> {
        if !allowed_tokens.is_empty() && !allowed_tokens.contains(token_out) {
            return Err(KernelError::MissionAssetForbidden {
                token_out: token_out.to_string(),
            });
        }
        let expected_min_out = amount_in
            .checked_mul(u128::from(min_return_bps))
            .ok_or(KernelError::ArithmeticOverflow)?
            / 10_000;
        if amount_out < expected_min_out {
            return Err(KernelError::MissionSlippageExceeded {
                expected_min_out,
                actual_out: amount_out,
            });
        }
        Ok(())
    }

    pub fn initiate_intent(
        &mut self,
        ctx: &ExecutionContext,
        intent_id: String,
        counterparty_id: String,
        amount: U128String,
        nonce: u64,
        payload: ForeignTxSignPayload,
    ) -> Result<CrossChainIntent, KernelError> {
        self.assert_initialized()?;

        match &ctx.key_permission {
            CallerKeyPermission::FullAccess => {
                return Err(KernelError::FullAccessKeyForbiddenForAgent);
            }
            CallerKeyPermission::FunctionCall {
                receiver_id,
                method_names,
                ..
            } => {
                if receiver_id != &ctx.current_account_id {
                    return Err(KernelError::InvalidFunctionCallScope(
                        "Key receiver_id must be scoped to Emet contract".to_string(),
                    ));
                }
                if !method_names.is_empty()
                    && !method_names.iter().any(|m| m == "initiate_intent")
                {
                    return Err(KernelError::InvalidFunctionCallScope(
                        "Key method scope does not permit initiate_intent".to_string(),
                    ));
                }
            }
        }

        if ctx.prepaid_gas < MIN_REQUIRED_PREPAID_GAS {
            return Err(KernelError::InsufficientPrepaidGas {
                provided: ctx.prepaid_gas,
                required: MIN_REQUIRED_PREPAID_GAS,
            });
        }

        if self.intents.contains_key(&intent_id) {
            return Err(KernelError::IntentAlreadyExists(intent_id));
        }

        let ForeignTxSignPayload::V1(ref v1_payload) = payload;
        v1_payload
            .request
            .assert_strict_finality()
            .map_err(|e| KernelError::FinalityPolicyViolation(format!("{e:?}")))?;

        let expected_payload_hash = payload
            .compute_msg_hash()
            .map_err(|_| KernelError::ArithmeticOverflow)?;

        match self.evaluate_counterparty(&counterparty_id) {
            CounterpartyDecision::Block { reason, .. } => {
                return Err(KernelError::CounterpartyBlocked {
                    counterparty: counterparty_id,
                    reason,
                });
            }
            CounterpartyDecision::Warn { reason, .. } => {
                return Err(KernelError::CounterpartyRequiresHumanApproval {
                    counterparty: counterparty_id,
                    reason,
                });
            }
            CounterpartyDecision::Allow { .. } => {}
        }

        let mut agent = self
            .agents
            .get(&ctx.predecessor_account_id)
            .ok_or_else(|| KernelError::AgentNotRegistered(ctx.predecessor_account_id.clone()))?
            .clone();

        if !agent.allowed_counterparties.is_empty()
            && !agent.allowed_counterparties.contains(&counterparty_id)
        {
            return Err(KernelError::CounterpartyBlocked {
                counterparty: counterparty_id,
                reason: "Not in agent's explicit counterparty allowlist".to_string(),
            });
        }

        if nonce <= agent.last_nonce {
            return Err(KernelError::NonMonotonicNonce {
                provided: nonce,
                last_nonce: agent.last_nonce,
            });
        }

        if amount.0 > agent.max_per_tx.0 {
            return Err(KernelError::ExceedsPerTxLimit {
                requested: amount.0,
                max_per_tx: agent.max_per_tx.0,
            });
        }

        const EPOCH_MS: u64 = 86_400_000;
        if ctx.block_timestamp_ms.saturating_sub(agent.epoch_started_at_ms) >= EPOCH_MS {
            agent.current_epoch_exposure = U128String(0);
            agent.epoch_started_at_ms = ctx.block_timestamp_ms;
        }

        let new_epoch_exposure = agent
            .current_epoch_exposure
            .0
            .checked_add(amount.0)
            .ok_or(KernelError::ArithmeticOverflow)?;

        if new_epoch_exposure > agent.epoch_spend_cap.0 {
            return Err(KernelError::ExceedsEpochCap {
                requested_exposure: new_epoch_exposure,
                cap: agent.epoch_spend_cap.0,
            });
        }

        if amount.0 > agent.available_balance.0 {
            return Err(KernelError::InsufficientAvailableBudget {
                requested: amount.0,
                available: agent.available_balance.0,
            });
        }

        agent.available_balance = U128String(
            agent
                .available_balance
                .0
                .checked_sub(amount.0)
                .ok_or(KernelError::ArithmeticOverflow)?,
        );
        agent.in_flight_locked = U128String(
            agent
                .in_flight_locked
                .0
                .checked_add(amount.0)
                .ok_or(KernelError::ArithmeticOverflow)?,
        );
        agent.current_epoch_exposure = U128String(new_epoch_exposure);
        agent.last_nonce = nonce;
        self.agents.insert(agent.agent_id.clone(), agent);

        let target_chain = v1_payload.request.chain();
        let mpc_request = VerifyForeignTransactionRequestArgs {
            request: v1_payload.request.clone(),
            domain_id: self.default_domain_id,
            payload_version: ForeignTxPayloadVersion::V1,
            expected_payload_hash: Some(expected_payload_hash),
        };

        let intent = CrossChainIntent {
            intent_id: intent_id.clone(),
            agent_id: ctx.predecessor_account_id.clone(),
            counterparty_id,
            amount,
            nonce,
            target_chain,
            mpc_request,
            expected_payload_hash,
            status: IntentStatus::VerifyingOutcome,
            created_at_ms: ctx.block_timestamp_ms,
        };

        self.intents.insert(intent_id, intent.clone());
        Ok(intent)
    }

    pub fn on_foreign_tx_verified(
        &mut self,
        ctx: &ExecutionContext,
        intent_id: String,
        verdict: InspectorVerdict,
    ) -> Result<SettlementReceipt, KernelError> {
        self.assert_private_callback(ctx)?;

        let mut intent = self
            .intents
            .get(&intent_id)
            .ok_or_else(|| KernelError::IntentNotFound(intent_id.clone()))?
            .clone();

        if intent.status != IntentStatus::VerifyingOutcome {
            return Err(KernelError::IntentNotVerifying(intent_id));
        }

        let mut agent = self
            .agents
            .get(&intent.agent_id)
            .ok_or_else(|| KernelError::AgentNotRegistered(intent.agent_id.clone()))?
            .clone();

        agent.in_flight_locked = U128String(
            agent
                .in_flight_locked
                .0
                .checked_sub(intent.amount.0)
                .ok_or(KernelError::ArithmeticOverflow)?,
        );

        let solver_spread_bps = match self.evaluate_counterparty(&intent.counterparty_id) {
            CounterpartyDecision::Allow {
                solver_spread_bps, ..
            } => solver_spread_bps,
            _ => 15,
        };

        if verdict.is_verified_truth(&intent.expected_payload_hash) {
            let InspectorVerdict::Extracted(resp) = verdict else {
                unreachable!()
            };

            agent.settled_spent = U128String(
                agent
                    .settled_spent
                    .0
                    .checked_add(intent.amount.0)
                    .ok_or(KernelError::ArithmeticOverflow)?,
            );
            intent.status = IntentStatus::Settled {
                verified_at_ms: ctx.block_timestamp_ms,
                mpc_payload_hash: resp.payload_hash.to_hex(),
                mpc_signature_hex: resp.signature.signature_hex,
            };

            if let Some(profile) = self.counterparties.get_mut(&intent.counterparty_id) {
                profile.prior_successful_settlements =
                    profile.prior_successful_settlements.saturating_add(1);
            }
        } else {
            let reason = match verdict {
                InspectorVerdict::TransactionFailed => {
                    "Foreign chain transaction reverted (TransactionFailed) — ghost deposit blocked"
                        .to_string()
                }
                InspectorVerdict::TransactionNotFound => {
                    "Foreign chain transaction not found across RPC quorum".to_string()
                }
                InspectorVerdict::NonCanonicalBlock {
                    block_number,
                    receipt_hash_hex,
                    canonical_hash_hex,
                } => format!(
                    "Non-canonical micro-fork detected at block {block_number} (receipt {receipt_hash_hex} != canonical {canonical_hash_hex})"
                ),
                InspectorVerdict::LogIndexOutOfBounds => {
                    "Extractor log/instruction index out of bounds".to_string()
                }
                InspectorVerdict::AccountNotFound => {
                    "Destination account missing on foreign chain".to_string()
                }
                InspectorVerdict::Extracted(resp) => format!(
                    "MPC payload hash mismatch (expected {}, got {})",
                    intent.expected_payload_hash.to_hex(),
                    resp.payload_hash.to_hex()
                ),
            };

            agent.available_balance = U128String(
                agent
                    .available_balance
                    .0
                    .checked_add(intent.amount.0)
                    .ok_or(KernelError::ArithmeticOverflow)?,
            );
            agent.refunded_saved = U128String(
                agent
                    .refunded_saved
                    .0
                    .checked_add(intent.amount.0)
                    .ok_or(KernelError::ArithmeticOverflow)?,
            );
            agent.current_epoch_exposure = U128String(
                agent
                    .current_epoch_exposure
                    .0
                    .saturating_sub(intent.amount.0),
            );
            intent.status = IntentStatus::Refunded {
                refunded_at_ms: ctx.block_timestamp_ms,
                reason,
            };
        }

        self.agents.insert(agent.agent_id.clone(), agent);
        self.intents.insert(intent_id.clone(), intent.clone());

        let receipt = SettlementReceipt {
            receipt_id: format!("rcpt-{intent_id}"),
            intent_id,
            agent_id: intent.agent_id,
            counterparty_id: intent.counterparty_id,
            target_chain: intent.target_chain,
            amount: intent.amount,
            solver_spread_bps,
            naive_unverified_spread_bps: 200,
            expected_payload_hash: intent.expected_payload_hash.to_hex(),
            status: intent.status,
            issued_at_ms: ctx.block_timestamp_ms,
        };
        self.receipts
            .insert(receipt.receipt_id.clone(), receipt.clone());
        Ok(receipt)
    }

    pub fn list_intents(&self, from_index: usize, limit: usize) -> Vec<CrossChainIntent> {
        let capped = limit.min(MAX_PAGE_LIMIT);
        self.intents
            .values()
            .skip(from_index)
            .take(capped)
            .cloned()
            .collect()
    }
}

/// Exported WebAssembly verification entrypoint so the compiled `.wasm` contract
/// can be executed and verified directly inside any WASM VM (`WebAssembly.instantiate`).
/// Returns `1` when all `near/mpc` v3.18.0 snapshot tests and `near-contract-audit` tests pass.
#[no_mangle]
pub extern "C" fn wasm_run_emet_verification_suite() -> u32 {
    if !verify_near_mpc_snapshots() {
        return 0;
    }
    if !audit_tests::run_all_audit_assertions() {
        return 0;
    }
    1
}
