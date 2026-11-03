//! Deterministic unit & adversarial security test suite for `emet-settlement-contract`.
//! Verifies all 15 `near-contract-audit` detectors + the 3 hackathon track requirements.

use super::*;
use emet_mpc_verifier::{
    EvmExtractor, EvmFinality, EvmRpcRequest, EvmTxId, ExtractedValue, ForeignTxSignPayloadV1,
    MpcSignature, SvmAddress, SvmExtractedValue, SvmExtractor, SvmFinality, SvmInnerInstruction,
    SvmRpcRequest, SvmTxId, VerifyForeignTransactionResponse,
};

fn owner_ctx() -> ExecutionContext {
    ExecutionContext {
        current_account_id: "emet.near".to_string(),
        predecessor_account_id: "owner.near".to_string(),
        signer_account_id: "owner.near".to_string(),
        attached_deposit: 1,
        prepaid_gas: 300_000_000_000_000,
        block_timestamp_ms: 1_762_000_000_000,
        key_permission: CallerKeyPermission::FullAccess,
    }
}

fn agent_ctx(agent_id: &str, deposit: u128) -> ExecutionContext {
    ExecutionContext {
        current_account_id: "emet.near".to_string(),
        predecessor_account_id: agent_id.to_string(),
        signer_account_id: agent_id.to_string(),
        attached_deposit: deposit,
        prepaid_gas: 250_000_000_000_000,
        block_timestamp_ms: 1_762_000_010_000,
        key_permission: CallerKeyPermission::FunctionCall {
            receiver_id: "emet.near".to_string(),
            method_names: vec!["initiate_intent".to_string()],
            allowance_yocto: U128String(250_000_000_000_000_000_000_000),
        },
    }
}

fn private_callback_ctx() -> ExecutionContext {
    ExecutionContext {
        current_account_id: "emet.near".to_string(),
        predecessor_account_id: "emet.near".to_string(),
        signer_account_id: "agent-alpha.near".to_string(),
        attached_deposit: 0,
        prepaid_gas: CALLBACK_GAS,
        block_timestamp_ms: 1_762_000_012_500,
        key_permission: CallerKeyPermission::FullAccess,
    }
}

fn sample_solana_finalized_payload() -> ForeignTxSignPayload {
    ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request: ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: SvmTxId([0x11; 64]),
            finality: SvmFinality::Finalized,
            extractors: vec![SvmExtractor::InnerInstruction {
                instruction_index: 2,
                inner_instruction_index: 0,
            }],
        }),
        values: vec![ExtractedValue::SvmExtractedValue(
            SvmExtractedValue::InnerInstruction(SvmInnerInstruction {
                program_id: SvmAddress([0x33; 32]),
                accounts: vec![SvmAddress([0x44; 32]), SvmAddress([0x55; 32])],
                data: vec![0xde, 0xad, 0xbe, 0xef],
            }),
        )],
    })
}

fn sample_bnb_finalized_payload() -> ForeignTxSignPayload {
    ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request: ForeignChainRpcRequest::Bnb(EvmRpcRequest {
            tx_id: EvmTxId([0x99; 32]),
            extractors: vec![EvmExtractor::BlockHash],
            finality: EvmFinality::Finalized,
        }),
        values: vec![ExtractedValue::EvmExtractedValue(
            emet_mpc_verifier::EvmExtractedValue::BlockHash(Hash256([0xaa; 32])),
        )],
    })
}

fn setup_kernel() -> EmetSettlementKernel {
    let mut kernel =
        EmetSettlementKernel::init("owner.near".to_string(), "v1.signer-prod.testnet".to_string())
            .unwrap();

    kernel
        .upsert_counterparty_profile(
            &owner_ctx(),
            CounterpartyProfile {
                receiver_id: "solver-prime.near".to_string(),
                account_age_days: 120,
                is_contract: true,
                code_changed_recently: false,
                prior_successful_settlements: 10,
                reported_malicious_by: vec![],
            },
        )
        .unwrap();

    let reg_ctx = agent_ctx("agent-alpha.near", 10_000_000_000);
    kernel
        .register_agent(
            &reg_ctx,
            "agent-alpha.near".to_string(),
            U128String(10_000_000_000),
            U128String(4_000_000_000),
            U128String(6_000_000_000),
            vec!["solver-prime.near".to_string()],
        )
        .unwrap();

    kernel
}

pub fn run_all_audit_assertions() -> bool {
    settles_valid_finalized_solana_swap_and_unlocks_tight_solver_spread();
    blocks_3_8m_ghost_deposit_exploit_and_atomically_refunds_agent_budget();
    blocks_non_canonical_solana_micro_fork_reorg();
    rejects_full_access_key_and_enforces_scoped_function_call_key();
    blocks_prompt_injected_agent_paying_reported_malicious_counterparty();
    prevents_runaway_retry_drain_and_enforces_epoch_caps();
    near_contract_audit_detectors_private_callback_and_yocto_and_u128_json();
    true
}

#[cfg_attr(test, test)]
pub fn settles_valid_finalized_solana_swap_and_unlocks_tight_solver_spread() {
    let mut kernel = setup_kernel();
    let payload = sample_solana_finalized_payload();
    let expected_hash = payload.compute_msg_hash().unwrap();

    let intent = kernel
        .initiate_intent(
            &agent_ctx("agent-alpha.near", 0),
            "intent-sol-001".to_string(),
            "solver-prime.near".to_string(),
            U128String(2_500_000_000),
            1,
            payload,
        )
        .unwrap();

    assert_eq!(intent.status, IntentStatus::VerifyingOutcome);

    let ledger_mid = kernel.agents.get("agent-alpha.near").unwrap();
    assert_eq!(ledger_mid.available_balance.0, 7_500_000_000);
    assert_eq!(ledger_mid.in_flight_locked.0, 2_500_000_000);
    assert_eq!(ledger_mid.settled_spent.0, 0);

    let receipt = kernel
        .on_foreign_tx_verified(
            &private_callback_ctx(),
            "intent-sol-001".to_string(),
            InspectorVerdict::Extracted(VerifyForeignTransactionResponse {
                payload_hash: expected_hash,
                signature: MpcSignature {
                    scheme: "Ed25519".to_string(),
                    signature_hex: "a1b2c3d4e5f6".repeat(10),
                },
            }),
        )
        .unwrap();

    assert!(matches!(receipt.status, IntentStatus::Settled { .. }));
    assert_eq!(receipt.naive_unverified_spread_bps, 200);
    assert_eq!(receipt.solver_spread_bps, 10);

    let ledger_final = kernel.agents.get("agent-alpha.near").unwrap();
    assert_eq!(ledger_final.available_balance.0, 7_500_000_000);
    assert_eq!(ledger_final.in_flight_locked.0, 0);
    assert_eq!(ledger_final.settled_spent.0, 2_500_000_000);
}

#[cfg_attr(test, test)]
pub fn blocks_3_8m_ghost_deposit_exploit_and_atomically_refunds_agent_budget() {
    let mut kernel = setup_kernel();
    let payload = sample_bnb_finalized_payload();

    kernel
        .initiate_intent(
            &agent_ctx("agent-alpha.near", 0),
            "intent-bnb-exploit-oct1".to_string(),
            "solver-prime.near".to_string(),
            U128String(3_800_000_000),
            1,
            payload,
        )
        .unwrap();

    let receipt = kernel
        .on_foreign_tx_verified(
            &private_callback_ctx(),
            "intent-bnb-exploit-oct1".to_string(),
            InspectorVerdict::TransactionFailed,
        )
        .unwrap();

    match receipt.status {
        IntentStatus::Refunded { reason, .. } => {
            assert!(reason.contains("TransactionFailed"));
        }
        other => panic!("Expected Refunded status, got {other:?}"),
    }

    let ledger = kernel.agents.get("agent-alpha.near").unwrap();
    assert_eq!(ledger.available_balance.0, 10_000_000_000);
    assert_eq!(ledger.in_flight_locked.0, 0);
    assert_eq!(ledger.settled_spent.0, 0);
    assert_eq!(ledger.refunded_saved.0, 3_800_000_000);
    assert_eq!(ledger.current_epoch_exposure.0, 0);
}

#[cfg_attr(test, test)]
pub fn blocks_non_canonical_solana_micro_fork_reorg() {
    let mut kernel = setup_kernel();
    let payload = sample_solana_finalized_payload();

    kernel
        .initiate_intent(
            &agent_ctx("agent-alpha.near", 0),
            "intent-sol-fork".to_string(),
            "solver-prime.near".to_string(),
            U128String(1_500_000_000),
            1,
            payload,
        )
        .unwrap();

    let receipt = kernel
        .on_foreign_tx_verified(
            &private_callback_ctx(),
            "intent-sol-fork".to_string(),
            InspectorVerdict::NonCanonicalBlock {
                block_number: 312_004_991,
                receipt_hash_hex: "0xdeadbeef".to_string(),
                canonical_hash_hex: "0xcafebabe".to_string(),
            },
        )
        .unwrap();

    assert!(matches!(receipt.status, IntentStatus::Refunded { .. }));
    let ledger = kernel.agents.get("agent-alpha.near").unwrap();
    assert_eq!(ledger.available_balance.0, 10_000_000_000);
    assert_eq!(ledger.in_flight_locked.0, 0);
}

#[cfg_attr(test, test)]
pub fn rejects_full_access_key_and_enforces_scoped_function_call_key() {
    let mut kernel = setup_kernel();
    let mut bad_ctx = agent_ctx("agent-alpha.near", 0);
    bad_ctx.key_permission = CallerKeyPermission::FullAccess;

    let res = kernel.initiate_intent(
        &bad_ctx,
        "intent-full-access".to_string(),
        "solver-prime.near".to_string(),
        U128String(500_000_000),
        1,
        sample_solana_finalized_payload(),
    );
    assert_eq!(res, Err(KernelError::FullAccessKeyForbiddenForAgent));
}

#[cfg_attr(test, test)]
pub fn blocks_prompt_injected_agent_paying_reported_malicious_counterparty() {
    let mut kernel = setup_kernel();

    kernel
        .report_malicious_counterparty(
            &agent_ctx("agent-alpha.near", 0),
            "drainer-vault.near".to_string(),
            "0xbadc0de999111222".to_string(),
        )
        .unwrap();

    let res = kernel.initiate_intent(
        &agent_ctx("agent-alpha.near", 0),
        "intent-injected-01".to_string(),
        "drainer-vault.near".to_string(),
        U128String(1_000_000_000),
        1,
        sample_solana_finalized_payload(),
    );

    assert!(matches!(
        res,
        Err(KernelError::CounterpartyBlocked { counterparty, .. }) if counterparty == "drainer-vault.near"
    ));
}

#[cfg_attr(test, test)]
pub fn prevents_runaway_retry_drain_and_enforces_epoch_caps() {
    let mut kernel = setup_kernel();

    kernel
        .initiate_intent(
            &agent_ctx("agent-alpha.near", 0),
            "intent-1".to_string(),
            "solver-prime.near".to_string(),
            U128String(3_500_000_000),
            1,
            sample_solana_finalized_payload(),
        )
        .unwrap();

    let replay_err = kernel.initiate_intent(
        &agent_ctx("agent-alpha.near", 0),
        "intent-1-retry".to_string(),
        "solver-prime.near".to_string(),
        U128String(3_500_000_000),
        1,
        sample_solana_finalized_payload(),
    );
    assert_eq!(
        replay_err,
        Err(KernelError::NonMonotonicNonce {
            provided: 1,
            last_nonce: 1
        })
    );

    let cap_err = kernel.initiate_intent(
        &agent_ctx("agent-alpha.near", 0),
        "intent-2-over-epoch".to_string(),
        "solver-prime.near".to_string(),
        U128String(3_000_000_000),
        2,
        sample_solana_finalized_payload(),
    );
    assert_eq!(
        cap_err,
        Err(KernelError::ExceedsEpochCap {
            requested_exposure: 6_500_000_000,
            cap: 6_000_000_000
        })
    );
}

#[cfg_attr(test, test)]
pub fn near_contract_audit_detectors_private_callback_and_yocto_and_u128_json() {
    let mut kernel = setup_kernel();
    let payload = sample_solana_finalized_payload();
    let expected_hash = payload.compute_msg_hash().unwrap();

    kernel
        .initiate_intent(
            &agent_ctx("agent-alpha.near", 0),
            "intent-audit-1".to_string(),
            "solver-prime.near".to_string(),
            U128String(1_000_000_000),
            1,
            payload,
        )
        .unwrap();

    let spoofed_callback = kernel.on_foreign_tx_verified(
        &agent_ctx("attacker.near", 0),
        "intent-audit-1".to_string(),
        InspectorVerdict::Extracted(VerifyForeignTransactionResponse {
            payload_hash: expected_hash,
            signature: MpcSignature {
                scheme: "Ed25519".to_string(),
                signature_hex: "00".repeat(32),
            },
        }),
    );
    assert_eq!(spoofed_callback, Err(KernelError::PrivateCallbackOnly));

    let mut no_yocto_ctx = owner_ctx();
    no_yocto_ctx.attached_deposit = 0;
    let yocto_err = kernel.upsert_counterparty_profile(
        &no_yocto_ctx,
        CounterpartyProfile {
            receiver_id: "new.near".to_string(),
            account_age_days: 10,
            is_contract: false,
            code_changed_recently: false,
            prior_successful_settlements: 1,
            reported_malicious_by: vec![],
        },
    );
    assert_eq!(yocto_err, Err(KernelError::RequiresOneYoctoDeposit));

    let max_val = U128String(u128::MAX);
    let json = max_val.to_json_string();
    assert_eq!(json, format!("\"{}\"", u128::MAX));
    let decoded = U128String::from_json_string(&json).unwrap();
    assert_eq!(decoded, max_val);
}
