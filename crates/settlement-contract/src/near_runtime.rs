//! Native NEAR VM (`wasm32-unknown-unknown`) Smart Contract Host Entrypoints for Emet.
//!
//! Binds `EmetSettlementKernel` directly to NEAR Protocol's host ABI (`env`),
//! persisting state in NEAR's Merkle-Patricia storage trie and executing live
//! cross-contract calls to `v1.signer-prod.testnet::verify_foreign_transaction` (`DomainId(3)`).

use crate::{
    AgentBudgetLedger, CallerKeyPermission, CounterpartyDecision, CounterpartyProfile,
    CrossChainIntent, EmetSettlementKernel, ExecutionContext, IntentStatus, SettlementReceipt,
    U128String, CALLBACK_GAS, MPC_VERIFY_GAS,
};
use emet_mpc_verifier::{
    hex_encode, DomainId, EvmExtractedValue, EvmExtractor, EvmFinality, EvmRpcRequest, EvmTxId,
    ExtractedValue, ForeignChain, ForeignChainRpcRequest, ForeignTxPayloadVersion,
    ForeignTxSignPayload, ForeignTxSignPayloadV1, Hash256, InspectorVerdict, MpcSignature,
    SvmAddress, SvmExtractedValue, SvmExtractor, SvmFinality, SvmInnerInstruction, SvmRpcRequest,
    SvmTxId, VerifyForeignTransactionRequestArgs, VerifyForeignTransactionResponse,
};
use std::collections::{BTreeMap, BTreeSet};

const STATE_KEY: &[u8] = b"EMET_STATE_V1";
const REG_SCRATCH: u64 = 0;

#[link(wasm_import_module = "env")]
extern "C" {
    fn read_register(register_id: u64, ptr: u64);
    fn register_len(register_id: u64) -> u64;
    fn current_account_id(register_id: u64);
    fn signer_account_id(register_id: u64);
    fn signer_account_pk(register_id: u64);
    fn predecessor_account_id(register_id: u64);
    fn input(register_id: u64);
    fn block_timestamp() -> u64;
    fn attached_deposit(balance_ptr: u64);
    fn prepaid_gas() -> u64;
    fn value_return(value_len: u64, value_ptr: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
    fn log_utf8(len: u64, ptr: u64);
    fn promise_create(
        account_id_len: u64,
        account_id_ptr: u64,
        function_name_len: u64,
        function_name_ptr: u64,
        arguments_len: u64,
        arguments_ptr: u64,
        amount_ptr: u64,
        gas: u64,
    ) -> u64;
    fn promise_then(
        promise_index: u64,
        account_id_len: u64,
        account_id_ptr: u64,
        function_name_len: u64,
        function_name_ptr: u64,
        arguments_len: u64,
        arguments_ptr: u64,
        amount_ptr: u64,
        gas: u64,
    ) -> u64;
    fn promise_results_count() -> u64;
    fn promise_result(result_idx: u64, register_id: u64) -> u64;
    fn promise_return(promise_id: u64);
    fn storage_write(
        key_len: u64,
        key_ptr: u64,
        value_len: u64,
        value_ptr: u64,
        register_id: u64,
    ) -> u64;
    fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
}

fn near_panic(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

fn near_log(msg: &str) {
    unsafe { log_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

fn near_return_json(json: &str) {
    unsafe { value_return(json.len() as u64, json.as_ptr() as u64) }
}

fn read_reg_bytes(reg: u64) -> Vec<u8> {
    let len = unsafe { register_len(reg) };
    if len == u64::MAX || len == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u8; len as usize];
    unsafe { read_register(reg, buf.as_mut_ptr() as u64) };
    buf
}

fn env_input_str() -> String {
    unsafe { input(REG_SCRATCH) };
    String::from_utf8(read_reg_bytes(REG_SCRATCH)).unwrap_or_default()
}

fn env_current_account() -> String {
    unsafe { current_account_id(REG_SCRATCH) };
    String::from_utf8(read_reg_bytes(REG_SCRATCH)).unwrap_or_default()
}

fn env_predecessor_account() -> String {
    unsafe { predecessor_account_id(REG_SCRATCH) };
    String::from_utf8(read_reg_bytes(REG_SCRATCH)).unwrap_or_default()
}

fn env_signer_account() -> String {
    unsafe { signer_account_id(REG_SCRATCH) };
    String::from_utf8(read_reg_bytes(REG_SCRATCH)).unwrap_or_default()
}

fn env_signer_pk_hex() -> String {
    unsafe { signer_account_pk(REG_SCRATCH) };
    hex_encode(&read_reg_bytes(REG_SCRATCH))
}

fn env_attached_deposit() -> u128 {
    let mut bytes = [0u8; 16];
    unsafe { attached_deposit(bytes.as_mut_ptr() as u64) };
    u128::from_le_bytes(bytes)
}

fn build_exec_ctx(key_permission: CallerKeyPermission) -> ExecutionContext {
    let ts_ns = unsafe { block_timestamp() };
    let gas = unsafe { prepaid_gas() };
    ExecutionContext {
        current_account_id: env_current_account(),
        predecessor_account_id: env_predecessor_account(),
        signer_account_id: env_signer_account(),
        attached_deposit: env_attached_deposit(),
        prepaid_gas: gas,
        block_timestamp_ms: ts_ns / 1_000_000,
        key_permission,
    }
}

// --- Compact Binary Trie Persistence ---

struct OnChainState {
    kernel: EmetSettlementKernel,
    agent_pks: BTreeMap<String, String>,
}

fn put_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}
fn put_u64(buf: &mut Vec<u8>, v: u64) {
    buf.extend_from_slice(&v.to_le_bytes());
}
fn put_u128(buf: &mut Vec<u8>, v: u128) {
    buf.extend_from_slice(&v.to_le_bytes());
}
fn put_str(buf: &mut Vec<u8>, s: &str) {
    put_u32(buf, s.len() as u32);
    buf.extend_from_slice(s.as_bytes());
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn u8(&mut self) -> u8 {
        let b = self.data[self.pos];
        self.pos += 1;
        b
    }
    fn u16(&mut self) -> u16 {
        let mut b = [0u8; 2];
        b.copy_from_slice(&self.data[self.pos..self.pos + 2]);
        self.pos += 2;
        u16::from_le_bytes(b)
    }
    fn u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        b.copy_from_slice(&self.data[self.pos..self.pos + 4]);
        self.pos += 4;
        u32::from_le_bytes(b)
    }
    fn u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[self.pos..self.pos + 8]);
        self.pos += 8;
        u64::from_le_bytes(b)
    }
    fn u128(&mut self) -> u128 {
        let mut b = [0u8; 16];
        b.copy_from_slice(&self.data[self.pos..self.pos + 16]);
        self.pos += 16;
        u128::from_le_bytes(b)
    }
    fn str(&mut self) -> String {
        let len = self.u32() as usize;
        let s = core::str::from_utf8(&self.data[self.pos..self.pos + len]).unwrap_or_default();
        self.pos += len;
        s.to_string()
    }
    fn hash32(&mut self) -> [u8; 32] {
        let mut b = [0u8; 32];
        b.copy_from_slice(&self.data[self.pos..self.pos + 32]);
        self.pos += 32;
        b
    }
}

fn chain_to_u8(c: ForeignChain) -> u8 {
    match c {
        ForeignChain::Solana => 0,
        ForeignChain::Bnb => 1,
        ForeignChain::Base => 2,
        ForeignChain::Ethereum => 3,
        ForeignChain::Avalanche => 4,
        ForeignChain::Arbitrum => 5,
        ForeignChain::Polygon => 6,
        ForeignChain::Bitcoin => 7,
        _ => 1,
    }
}

fn u8_to_chain(b: u8) -> ForeignChain {
    match b {
        0 => ForeignChain::Solana,
        1 => ForeignChain::Bnb,
        2 => ForeignChain::Base,
        3 => ForeignChain::Ethereum,
        4 => ForeignChain::Avalanche,
        5 => ForeignChain::Arbitrum,
        6 => ForeignChain::Polygon,
        7 => ForeignChain::Bitcoin,
        _ => ForeignChain::Bnb,
    }
}

fn placeholder_rpc_for_chain(c: ForeignChain) -> ForeignChainRpcRequest {
    let evm = EvmRpcRequest {
        tx_id: EvmTxId([0u8; 32]),
        extractors: vec![EvmExtractor::BlockHash],
        finality: EvmFinality::Finalized,
    };
    match c {
        ForeignChain::Solana => ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: SvmTxId([0u8; 64]),
            finality: SvmFinality::Finalized,
            extractors: vec![],
        }),
        ForeignChain::Base => ForeignChainRpcRequest::Base(evm),
        ForeignChain::Ethereum => ForeignChainRpcRequest::Ethereum(evm),
        ForeignChain::Avalanche => ForeignChainRpcRequest::Avalanche(evm),
        ForeignChain::Arbitrum => ForeignChainRpcRequest::Arbitrum(evm),
        ForeignChain::Polygon => ForeignChainRpcRequest::Polygon(evm),
        _ => ForeignChainRpcRequest::Bnb(evm),
    }
}

fn encode_status(buf: &mut Vec<u8>, st: &IntentStatus) {
    match st {
        IntentStatus::Initiated => buf.push(0),
        IntentStatus::FundsEscrowed => buf.push(1),
        IntentStatus::VerifyingOutcome => buf.push(2),
        IntentStatus::Settled {
            verified_at_ms,
            mpc_payload_hash,
            mpc_signature_hex,
        } => {
            buf.push(3);
            put_u64(buf, *verified_at_ms);
            put_str(buf, mpc_payload_hash);
            put_str(buf, mpc_signature_hex);
        }
        IntentStatus::Refunded {
            refunded_at_ms,
            reason,
        } => {
            buf.push(4);
            put_u64(buf, *refunded_at_ms);
            put_str(buf, reason);
        }
    }
}

fn decode_status(r: &mut Reader) -> IntentStatus {
    match r.u8() {
        0 => IntentStatus::Initiated,
        1 => IntentStatus::FundsEscrowed,
        2 => IntentStatus::VerifyingOutcome,
        3 => IntentStatus::Settled {
            verified_at_ms: r.u64(),
            mpc_payload_hash: r.str(),
            mpc_signature_hex: r.str(),
        },
        _ => IntentStatus::Refunded {
            refunded_at_ms: r.u64(),
            reason: r.str(),
        },
    }
}

fn save_state(st: &OnChainState) {
    let k = &st.kernel;
    let mut buf = Vec::with_capacity(1024);
    buf.push(u8::from(k.initialized));
    put_str(&mut buf, &k.owner_id);
    put_str(&mut buf, &k.mpc_signer_contract_id);
    put_u64(&mut buf, k.default_domain_id.0);

    put_u32(&mut buf, k.agents.len() as u32);
    for a in k.agents.values() {
        put_str(&mut buf, &a.agent_id);
        put_str(&mut buf, &a.owner_id);
        put_u128(&mut buf, a.available_balance.0);
        put_u128(&mut buf, a.in_flight_locked.0);
        put_u128(&mut buf, a.settled_spent.0);
        put_u128(&mut buf, a.refunded_saved.0);
        put_u128(&mut buf, a.max_per_tx.0);
        put_u128(&mut buf, a.epoch_spend_cap.0);
        put_u128(&mut buf, a.current_epoch_exposure.0);
        put_u64(&mut buf, a.epoch_started_at_ms);
        put_u32(&mut buf, a.allowed_counterparties.len() as u32);
        for cp in &a.allowed_counterparties {
            put_str(&mut buf, cp);
        }
        put_u64(&mut buf, a.last_nonce);
    }

    put_u32(&mut buf, k.counterparties.len() as u32);
    for cp in k.counterparties.values() {
        put_str(&mut buf, &cp.receiver_id);
        put_u32(&mut buf, cp.account_age_days);
        buf.push(u8::from(cp.is_contract));
        buf.push(u8::from(cp.code_changed_recently));
        put_u32(&mut buf, cp.prior_successful_settlements);
        put_u32(&mut buf, cp.reported_malicious_by.len() as u32);
        for (rep, ev) in &cp.reported_malicious_by {
            put_str(&mut buf, rep);
            put_str(&mut buf, ev);
        }
    }

    put_u32(&mut buf, k.intents.len() as u32);
    for i in k.intents.values() {
        put_str(&mut buf, &i.intent_id);
        put_str(&mut buf, &i.agent_id);
        put_str(&mut buf, &i.counterparty_id);
        put_u128(&mut buf, i.amount.0);
        put_u64(&mut buf, i.nonce);
        buf.push(chain_to_u8(i.target_chain));
        buf.extend_from_slice(&i.expected_payload_hash.0);
        encode_status(&mut buf, &i.status);
        put_u64(&mut buf, i.created_at_ms);
    }

    put_u32(&mut buf, k.receipts.len() as u32);
    for rc in k.receipts.values() {
        put_str(&mut buf, &rc.receipt_id);
        put_str(&mut buf, &rc.intent_id);
        put_str(&mut buf, &rc.agent_id);
        put_str(&mut buf, &rc.counterparty_id);
        buf.push(chain_to_u8(rc.target_chain));
        put_u128(&mut buf, rc.amount.0);
        buf.extend_from_slice(&rc.solver_spread_bps.to_le_bytes());
        buf.extend_from_slice(&rc.naive_unverified_spread_bps.to_le_bytes());
        put_str(&mut buf, &rc.expected_payload_hash);
        encode_status(&mut buf, &rc.status);
        put_u64(&mut buf, rc.issued_at_ms);
    }

    put_u32(&mut buf, st.agent_pks.len() as u32);
    for (aid, pk) in &st.agent_pks {
        put_str(&mut buf, aid);
        put_str(&mut buf, pk);
    }

    unsafe {
        storage_write(
            STATE_KEY.len() as u64,
            STATE_KEY.as_ptr() as u64,
            buf.len() as u64,
            buf.as_ptr() as u64,
            REG_SCRATCH,
        );
    }
}

fn load_state() -> OnChainState {
    let exists = unsafe {
        storage_read(
            STATE_KEY.len() as u64,
            STATE_KEY.as_ptr() as u64,
            REG_SCRATCH,
        )
    };
    if exists == 0 {
        near_panic("EMET_ERR: Contract is not initialized. Call init first.");
    }
    let bytes = read_reg_bytes(REG_SCRATCH);
    let mut r = Reader {
        data: &bytes,
        pos: 0,
    };

    let initialized = r.u8() != 0;
    let owner_id = r.str();
    let mpc_signer_contract_id = r.str();
    let domain_id = DomainId(r.u64());

    let agent_len = r.u32() as usize;
    let mut agents = BTreeMap::new();
    for _ in 0..agent_len {
        let agent_id = r.str();
        let a_owner = r.str();
        let available_balance = U128String(r.u128());
        let in_flight_locked = U128String(r.u128());
        let settled_spent = U128String(r.u128());
        let refunded_saved = U128String(r.u128());
        let max_per_tx = U128String(r.u128());
        let epoch_spend_cap = U128String(r.u128());
        let current_epoch_exposure = U128String(r.u128());
        let epoch_started_at_ms = r.u64();
        let cp_len = r.u32() as usize;
        let mut allowed_counterparties = BTreeSet::new();
        for _ in 0..cp_len {
            allowed_counterparties.insert(r.str());
        }
        let last_nonce = r.u64();
        agents.insert(
            agent_id.clone(),
            AgentBudgetLedger {
                agent_id,
                owner_id: a_owner,
                available_balance,
                in_flight_locked,
                settled_spent,
                refunded_saved,
                max_per_tx,
                epoch_spend_cap,
                current_epoch_exposure,
                epoch_started_at_ms,
                allowed_counterparties,
                last_nonce,
            },
        );
    }

    let cp_count = r.u32() as usize;
    let mut counterparties = BTreeMap::new();
    for _ in 0..cp_count {
        let receiver_id = r.str();
        let account_age_days = r.u32();
        let is_contract = r.u8() != 0;
        let code_changed_recently = r.u8() != 0;
        let prior_successful_settlements = r.u32();
        let rep_len = r.u32() as usize;
        let mut reported_malicious_by = Vec::with_capacity(rep_len);
        for _ in 0..rep_len {
            reported_malicious_by.push((r.str(), r.str()));
        }
        counterparties.insert(
            receiver_id.clone(),
            CounterpartyProfile {
                receiver_id,
                account_age_days,
                is_contract,
                code_changed_recently,
                prior_successful_settlements,
                reported_malicious_by,
            },
        );
    }

    let intent_count = r.u32() as usize;
    let mut intents = BTreeMap::new();
    for _ in 0..intent_count {
        let intent_id = r.str();
        let agent_id = r.str();
        let counterparty_id = r.str();
        let amount = U128String(r.u128());
        let nonce = r.u64();
        let target_chain = u8_to_chain(r.u8());
        let expected_payload_hash = Hash256(r.hash32());
        let status = decode_status(&mut r);
        let created_at_ms = r.u64();
        intents.insert(
            intent_id.clone(),
            CrossChainIntent {
                intent_id,
                agent_id,
                counterparty_id,
                amount,
                nonce,
                target_chain,
                mpc_request: VerifyForeignTransactionRequestArgs {
                    request: placeholder_rpc_for_chain(target_chain),
                    domain_id,
                    payload_version: ForeignTxPayloadVersion::V1,
                    expected_payload_hash: Some(expected_payload_hash),
                },
                expected_payload_hash,
                status,
                created_at_ms,
            },
        );
    }

    let rc_count = r.u32() as usize;
    let mut receipts = BTreeMap::new();
    for _ in 0..rc_count {
        let receipt_id = r.str();
        let intent_id = r.str();
        let agent_id = r.str();
        let counterparty_id = r.str();
        let target_chain = u8_to_chain(r.u8());
        let amount = U128String(r.u128());
        let solver_spread_bps = r.u16();
        let naive_unverified_spread_bps = r.u16();
        let expected_payload_hash = r.str();
        let status = decode_status(&mut r);
        let issued_at_ms = r.u64();
        receipts.insert(
            receipt_id.clone(),
            SettlementReceipt {
                receipt_id,
                intent_id,
                agent_id,
                counterparty_id,
                target_chain,
                amount,
                solver_spread_bps,
                naive_unverified_spread_bps,
                expected_payload_hash,
                status,
                issued_at_ms,
            },
        );
    }

    let pk_count = r.u32() as usize;
    let mut agent_pks = BTreeMap::new();
    for _ in 0..pk_count {
        agent_pks.insert(r.str(), r.str());
    }

    OnChainState {
        kernel: EmetSettlementKernel {
            initialized,
            owner_id,
            mpc_signer_contract_id,
            default_domain_id: domain_id,
            agents,
            intents,
            receipts,
            counterparties,
        },
        agent_pks,
    }
}

// --- Zero-Dependency JSON Argument Extractors ---

fn json_str(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    if let Some(inner) = rest.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(esc) = chars.next() {
                    out.push(esc);
                }
            } else if c == '"' {
                return Some(out);
            } else {
                out.push(c);
            }
        }
        None
    } else {
        let end = rest
            .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
            .unwrap_or(rest.len());
        let tok = &rest[..end];
        if tok.is_empty() || tok == "null" {
            None
        } else {
            Some(tok.to_string())
        }
    }
}

fn json_u64(json: &str, key: &str) -> Option<u64> {
    json_str(json, key)?.trim_matches('"').parse::<u64>().ok()
}

fn json_u128(json: &str, key: &str) -> Option<u128> {
    json_str(json, key)?.trim_matches('"').parse::<u128>().ok()
}

fn json_bool(json: &str, key: &str, default: bool) -> bool {
    match json_str(json, key).as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

fn decode_hex_fixed<const N: usize>(hex: &str) -> [u8; N] {
    let clean = hex.trim().strip_prefix("0x").unwrap_or(hex.trim());
    if clean.len() != N * 2 {
        near_panic(&format!(
            "EMET_ERR: Expected {}-byte hex ({} chars), got {} chars",
            N,
            N * 2,
            clean.len()
        ));
    }
    let mut out = [0u8; N];
    let bytes = clean.as_bytes();
    for i in 0..N {
        let hi = (bytes[i * 2] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = (bytes[i * 2 + 1] as char).to_digit(16).unwrap_or(0) as u8;
        out[i] = (hi << 4) | lo;
    }
    out
}

fn status_to_json(st: &IntentStatus) -> String {
    match st {
        IntentStatus::Initiated => "{\"state\":\"Initiated\"}".to_string(),
        IntentStatus::FundsEscrowed => "{\"state\":\"FundsEscrowed\"}".to_string(),
        IntentStatus::VerifyingOutcome => "{\"state\":\"VerifyingOutcome\"}".to_string(),
        IntentStatus::Settled {
            verified_at_ms,
            mpc_payload_hash,
            mpc_signature_hex,
        } => {
            let sig_escaped = mpc_signature_hex.replace('"', "\\\"");
            format!(
                "{{\"state\":\"Settled\",\"verified_at_ms\":{verified_at_ms},\"mpc_payload_hash\":\"{mpc_payload_hash}\",\"mpc_signature\":\"{sig_escaped}\"}}"
            )
        }
        IntentStatus::Refunded {
            refunded_at_ms,
            reason,
        } => {
            let r_escaped = reason.replace('"', "\\\"");
            format!(
                "{{\"state\":\"Refunded\",\"refunded_at_ms\":{refunded_at_ms},\"reason\":\"{r_escaped}\"}}"
            )
        }
    }
}

fn ledger_to_json(a: &AgentBudgetLedger, pk_hex: Option<&String>) -> String {
    let cps: Vec<String> = a
        .allowed_counterparties
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect();
    let pk = pk_hex.map(|s| s.as_str()).unwrap_or("");
    format!(
        "{{\"agent_id\":\"{}\",\"owner_id\":\"{}\",\"available_balance\":\"{}\",\"in_flight_locked\":\"{}\",\"settled_spent\":\"{}\",\"refunded_saved\":\"{}\",\"max_per_tx\":\"{}\",\"epoch_spend_cap\":\"{}\",\"current_epoch_exposure\":\"{}\",\"last_nonce\":{},\"authorized_pk_hex\":\"{}\",\"allowed_counterparties\":[{}]}}",
        a.agent_id,
        a.owner_id,
        a.available_balance.0,
        a.in_flight_locked.0,
        a.settled_spent.0,
        a.refunded_saved.0,
        a.max_per_tx.0,
        a.epoch_spend_cap.0,
        a.current_epoch_exposure.0,
        a.last_nonce,
        pk,
        cps.join(",")
    )
}

// --- Exported NEAR Smart Contract Entrypoints ---

#[no_mangle]
pub extern "C" fn init() {
    let exists = unsafe {
        storage_read(
            STATE_KEY.len() as u64,
            STATE_KEY.as_ptr() as u64,
            REG_SCRATCH,
        )
    };
    if exists == 1 {
        near_panic("EMET_ERR: AlreadyInitialized");
    }
    let raw = env_input_str();
    let owner_id = json_str(&raw, "owner_id").unwrap_or_else(env_predecessor_account);
    let mpc_signer =
        json_str(&raw, "mpc_signer_id").unwrap_or_else(|| "v1.signer-prod.testnet".to_string());
    let domain_id = json_u64(&raw, "domain_id").unwrap_or(3);

    let mut kernel = EmetSettlementKernel::init(owner_id.clone(), mpc_signer.clone())
        .unwrap_or_else(|e| near_panic(&format!("EMET_ERR: {e:?}")));
    kernel.default_domain_id = DomainId(domain_id);

    let state = OnChainState {
        kernel,
        agent_pks: BTreeMap::new(),
    };
    save_state(&state);
    near_log(&format!(
        "EVENT_JSON:{{\"standard\":\"emet\",\"version\":\"1.0.0\",\"event\":\"contract_initialized\",\"data\":{{\"owner_id\":\"{owner_id}\",\"mpc_signer_id\":\"{mpc_signer}\",\"domain_id\":{domain_id}}}}}"
    ));
    near_return_json(&format!(
        "{{\"initialized\":true,\"owner_id\":\"{owner_id}\",\"mpc_signer_id\":\"{mpc_signer}\",\"domain_id\":{domain_id}}}"
    ));
}

#[no_mangle]
pub extern "C" fn upsert_counterparty() {
    let mut st = load_state();
    let raw = env_input_str();
    let ctx = build_exec_ctx(CallerKeyPermission::FullAccess);
    let receiver_id = json_str(&raw, "receiver_id")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing receiver_id"));
    let profile = CounterpartyProfile {
        receiver_id: receiver_id.clone(),
        account_age_days: json_u64(&raw, "account_age_days").unwrap_or(90) as u32,
        is_contract: json_bool(&raw, "is_contract", true),
        code_changed_recently: json_bool(&raw, "code_changed_recently", false),
        prior_successful_settlements: json_u64(&raw, "prior_successful_settlements").unwrap_or(10)
            as u32,
        reported_malicious_by: Vec::new(),
    };
    st.kernel
        .upsert_counterparty_profile(&ctx, profile)
        .unwrap_or_else(|e| near_panic(&format!("EMET_ERR: {e:?}")));
    save_state(&st);
    near_return_json(&format!(
        "{{\"status\":\"updated\",\"receiver_id\":\"{receiver_id}\"}}"
    ));
}

#[no_mangle]
pub extern "C" fn register_agent() {
    let mut st = load_state();
    let raw = env_input_str();
    let ctx = build_exec_ctx(CallerKeyPermission::FullAccess);
    if ctx.predecessor_account_id != st.kernel.owner_id {
        near_panic("EMET_ERR: UnauthorizedOwner — Only contract owner can register agent vaults");
    }

    let agent_id =
        json_str(&raw, "agent_id").unwrap_or_else(|| ctx.predecessor_account_id.clone());
    let authorized_pk_hex = json_str(&raw, "authorized_pk_hex")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing authorized_pk_hex for FunctionCall key"));
    let initial_budget = U128String(
        json_u128(&raw, "initial_budget")
            .unwrap_or_else(|| near_panic("EMET_ERR: Missing initial_budget")),
    );
    let max_per_tx = U128String(json_u128(&raw, "max_per_tx").unwrap_or(initial_budget.0));
    let epoch_spend_cap =
        U128String(json_u128(&raw, "epoch_spend_cap").unwrap_or(initial_budget.0));
    let allowed_csv =
        json_str(&raw, "allowed_counterparties").unwrap_or_else(|| "solver-prime.near".to_string());
    let allowed: Vec<String> = allowed_csv
        .split(',')
        .map(|s| s.trim().trim_matches(|c| c == '[' || c == ']' || c == '"'))
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    let clean_pk = authorized_pk_hex.trim().to_lowercase();
    let ledger = st
        .kernel
        .register_agent(
            &ctx,
            agent_id.clone(),
            initial_budget,
            max_per_tx,
            epoch_spend_cap,
            allowed,
        )
        .unwrap_or_else(|e| near_panic(&format!("EMET_ERR: {e:?}")));
    st.agent_pks.insert(agent_id.clone(), clean_pk.clone());
    save_state(&st);

    near_log(&format!(
        "EVENT_JSON:{{\"standard\":\"emet\",\"version\":\"1.0.0\",\"event\":\"agent_registered\",\"data\":{{\"agent_id\":\"{agent_id}\",\"initial_budget\":\"{}\",\"authorized_pk_hex\":\"{clean_pk}\"}}}}",
        initial_budget.0
    ));
    near_return_json(&ledger_to_json(&ledger, Some(&clean_pk)));
}

#[no_mangle]
pub extern "C" fn report_malicious_counterparty() {
    let mut st = load_state();
    let raw = env_input_str();
    let ctx = build_exec_ctx(CallerKeyPermission::FullAccess);
    let cp = json_str(&raw, "counterparty_id")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing counterparty_id"));
    let ev = json_str(&raw, "evidence_tx_hash").unwrap_or_else(|| "onchain_report".to_string());
    st.kernel
        .report_malicious_counterparty(&ctx, cp.clone(), ev)
        .unwrap_or_else(|e| near_panic(&format!("EMET_ERR: {e:?}")));
    save_state(&st);
    near_return_json(&format!(
        "{{\"status\":\"blocked\",\"counterparty_id\":\"{cp}\"}}"
    ));
}

#[no_mangle]
pub extern "C" fn initiate_intent() {
    let mut st = load_state();
    let raw = env_input_str();
    let current_id = env_current_account();
    let pred_id = env_predecessor_account();
    let signer_pk_hex = env_signer_pk_hex();

    // Cryptographically verify the transaction was signed by the agent's registered
    // Function-Call Access Key (and NEVER by the owner's FullAccess key).
    let key_perm = match st.agent_pks.get(&pred_id) {
        Some(expected_pk) if expected_pk == &signer_pk_hex => CallerKeyPermission::FunctionCall {
            receiver_id: current_id.clone(),
            method_names: vec!["initiate_intent".to_string()],
            allowance_yocto: U128String(250_000_000_000_000_000_000_000),
        },
        _ => CallerKeyPermission::FullAccess,
    };

    let ctx = build_exec_ctx(key_perm);
    let intent_id =
        json_str(&raw, "intent_id").unwrap_or_else(|| near_panic("EMET_ERR: Missing intent_id"));
    let counterparty_id = json_str(&raw, "counterparty_id")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing counterparty_id"));
    let amount = U128String(
        json_u128(&raw, "amount").unwrap_or_else(|| near_panic("EMET_ERR: Missing amount")),
    );
    let nonce = json_u64(&raw, "nonce").unwrap_or_else(|| near_panic("EMET_ERR: Missing nonce"));
    let chain_str = json_str(&raw, "chain").unwrap_or_else(|| "Bnb".to_string());
    let dispatch_mpc = json_bool(&raw, "dispatch_mpc", true);

    let (payload, mpc_request_json_inner) = if chain_str.eq_ignore_ascii_case("Solana") {
        let tx_hex = json_str(&raw, "tx_id_hex").unwrap_or_else(|| "11".repeat(64));
        let tx_bytes = decode_hex_fixed::<64>(&tx_hex);
        let p = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
            request: ForeignChainRpcRequest::Solana(SvmRpcRequest {
                tx_id: SvmTxId(tx_bytes),
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
        });
        let req_json = format!(
            "{{\"Solana\":{{\"tx_id\":\"{}\",\"finality\":\"Finalized\",\"extractors\":[{{\"InnerInstruction\":{{\"instruction_index\":2,\"inner_instruction_index\":0}}}}]}}}}",
            hex_encode(&tx_bytes)
        );
        (p, req_json)
    } else {
        let tx_hex = json_str(&raw, "tx_id_hex").unwrap_or_else(|| "99".repeat(32));
        let blk_hex = json_str(&raw, "block_hash_hex").unwrap_or_else(|| "aa".repeat(32));
        let tx_bytes = decode_hex_fixed::<32>(&tx_hex);
        let blk_bytes = decode_hex_fixed::<32>(&blk_hex);
        let evm_req = EvmRpcRequest {
            tx_id: EvmTxId(tx_bytes),
            extractors: vec![EvmExtractor::BlockHash],
            finality: EvmFinality::Finalized,
        };
        let (rpc_enum, variant_name) = match chain_str.as_str() {
            "Base" | "base" => (ForeignChainRpcRequest::Base(evm_req), "Base"),
            "Ethereum" | "ethereum" => (ForeignChainRpcRequest::Ethereum(evm_req), "Ethereum"),
            "Avalanche" | "avalanche" => (ForeignChainRpcRequest::Avalanche(evm_req), "Avalanche"),
            "Arbitrum" | "arbitrum" => (ForeignChainRpcRequest::Arbitrum(evm_req), "Arbitrum"),
            "Polygon" | "polygon" => (ForeignChainRpcRequest::Polygon(evm_req), "Polygon"),
            _ => (ForeignChainRpcRequest::Bnb(evm_req), "Bnb"),
        };
        let p = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
            request: rpc_enum,
            values: vec![ExtractedValue::EvmExtractedValue(
                EvmExtractedValue::BlockHash(Hash256(blk_bytes)),
            )],
        });
        let req_json = format!(
            "{{\"{variant_name}\":{{\"tx_id\":\"{}\",\"extractors\":[\"BlockHash\"],\"finality\":\"Finalized\"}}}}",
            hex_encode(&tx_bytes)
        );
        (p, req_json)
    };

    let intent = st
        .kernel
        .initiate_intent(
            &ctx,
            intent_id.clone(),
            counterparty_id.clone(),
            amount,
            nonce,
            payload,
        )
        .unwrap_or_else(|e| near_panic(&format!("EMET_ERR: {e:?}")));

    // Persist locked state BEFORE cross-contract MPC call (Checks-Effects-Interactions).
    save_state(&st);

    let expected_hex = intent.expected_payload_hash.to_hex();
    near_log(&format!(
        "EVENT_JSON:{{\"standard\":\"emet\",\"version\":\"1.0.0\",\"event\":\"intent_escrowed\",\"data\":{{\"intent_id\":\"{intent_id}\",\"agent_id\":\"{pred_id}\",\"counterparty_id\":\"{counterparty_id}\",\"amount\":\"{}\",\"expected_payload_hash\":\"{expected_hex}\",\"dispatch_mpc\":{dispatch_mpc}}}}}",
        amount.0
    ));

    if dispatch_mpc {
        let mpc_contract = st.kernel.mpc_signer_contract_id.clone();
        let mpc_method = "verify_foreign_transaction";
        let mpc_args = format!(
            "{{\"request\":{{\"request\":{mpc_request_json_inner},\"domain_id\":{},\"payload_version\":1,\"expected_payload_hash\":\"{expected_hex}\"}}}}",
            st.kernel.default_domain_id.0
        );
        let one_yocto = 1u128.to_le_bytes();
        let zero_yocto = 0u128.to_le_bytes();
        let cb_method = "on_foreign_tx_verified";
        let cb_args = format!("{{\"intent_id\":\"{intent_id}\"}}");

        unsafe {
            let p0 = promise_create(
                mpc_contract.len() as u64,
                mpc_contract.as_ptr() as u64,
                mpc_method.len() as u64,
                mpc_method.as_ptr() as u64,
                mpc_args.len() as u64,
                mpc_args.as_ptr() as u64,
                one_yocto.as_ptr() as u64,
                MPC_VERIFY_GAS,
            );
            let p1 = promise_then(
                p0,
                current_id.len() as u64,
                current_id.as_ptr() as u64,
                cb_method.len() as u64,
                cb_method.as_ptr() as u64,
                cb_args.len() as u64,
                cb_args.as_ptr() as u64,
                zero_yocto.as_ptr() as u64,
                CALLBACK_GAS,
            );
            promise_return(p1);
        }
    } else {
        near_return_json(&format!(
            "{{\"intent_id\":\"{intent_id}\",\"status\":\"VerifyingOutcome\",\"expected_payload_hash\":\"{expected_hex}\",\"in_flight_locked\":\"{}\"}}",
            amount.0
        ));
    }
}

#[no_mangle]
pub extern "C" fn on_foreign_tx_verified() {
    let mut st = load_state();
    let raw = env_input_str();
    let ctx = build_exec_ctx(CallerKeyPermission::FullAccess);
    let intent_id =
        json_str(&raw, "intent_id").unwrap_or_else(|| near_panic("EMET_ERR: Missing intent_id"));

    let count = unsafe { promise_results_count() };
    let verdict = if count > 0 {
        let status_code = unsafe { promise_result(0, REG_SCRATCH) };
        if status_code == 1 {
            let resp_json = String::from_utf8(read_reg_bytes(REG_SCRATCH)).unwrap_or_default();
            if let Some(hash_hex) = json_str(&resp_json, "payload_hash") {
                let hash_bytes = decode_hex_fixed::<32>(&hash_hex);
                InspectorVerdict::Extracted(VerifyForeignTransactionResponse {
                    payload_hash: Hash256(hash_bytes),
                    signature: MpcSignature {
                        scheme: "Secp256k1".to_string(),
                        signature_hex: resp_json,
                    },
                })
            } else {
                InspectorVerdict::TransactionFailed
            }
        } else {
            InspectorVerdict::TransactionFailed
        }
    } else {
        InspectorVerdict::TransactionFailed
    };

    let receipt = st
        .kernel
        .on_foreign_tx_verified(&ctx, intent_id.clone(), verdict)
        .unwrap_or_else(|e| near_panic(&format!("EMET_ERR: {e:?}")));
    save_state(&st);

    let st_json = status_to_json(&receipt.status);
    near_log(&format!(
        "EVENT_JSON:{{\"standard\":\"emet\",\"version\":\"1.0.0\",\"event\":\"intent_reconciled\",\"data\":{{\"receipt_id\":\"{}\",\"intent_id\":\"{intent_id}\",\"amount\":\"{}\",\"outcome\":{st_json}}}}}",
        receipt.receipt_id, receipt.amount.0
    ));
    near_return_json(&format!(
        "{{\"receipt_id\":\"{}\",\"intent_id\":\"{intent_id}\",\"agent_id\":\"{}\",\"counterparty_id\":\"{}\",\"amount\":\"{}\",\"expected_payload_hash\":\"{}\",\"status\":{st_json}}}",
        receipt.receipt_id,
        receipt.agent_id,
        receipt.counterparty_id,
        receipt.amount.0,
        receipt.expected_payload_hash
    ));
}

// --- Read-Only View Entrypoints ---

#[no_mangle]
pub extern "C" fn get_contract_info() {
    let st = load_state();
    let k = &st.kernel;
    near_return_json(&format!(
        "{{\"initialized\":{},\"owner_id\":\"{}\",\"mpc_signer_id\":\"{}\",\"domain_id\":{},\"agent_count\":{},\"intent_count\":{},\"receipt_count\":{}}}",
        k.initialized,
        k.owner_id,
        k.mpc_signer_contract_id,
        k.default_domain_id.0,
        k.agents.len(),
        k.intents.len(),
        k.receipts.len()
    ));
}

#[no_mangle]
pub extern "C" fn get_agent_ledger() {
    let st = load_state();
    let raw = env_input_str();
    let agent_id = json_str(&raw, "agent_id")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing agent_id"));
    let Some(ledger) = st.kernel.agents.get(&agent_id) else {
        near_return_json("null");
        return;
    };
    near_return_json(&ledger_to_json(ledger, st.agent_pks.get(&agent_id)));
}

#[no_mangle]
pub extern "C" fn get_intent() {
    let st = load_state();
    let raw = env_input_str();
    let intent_id = json_str(&raw, "intent_id")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing intent_id"));
    let Some(i) = st.kernel.intents.get(&intent_id) else {
        near_return_json("null");
        return;
    };
    near_return_json(&format!(
        "{{\"intent_id\":\"{}\",\"agent_id\":\"{}\",\"counterparty_id\":\"{}\",\"amount\":\"{}\",\"nonce\":{},\"chain\":\"{}\",\"expected_payload_hash\":\"{}\",\"status\":{}}}",
        i.intent_id,
        i.agent_id,
        i.counterparty_id,
        i.amount.0,
        i.nonce,
        i.target_chain.label(),
        i.expected_payload_hash.to_hex(),
        status_to_json(&i.status)
    ));
}

#[no_mangle]
pub extern "C" fn evaluate_counterparty() {
    let st = load_state();
    let raw = env_input_str();
    let cp = json_str(&raw, "counterparty_id")
        .unwrap_or_else(|| near_panic("EMET_ERR: Missing counterparty_id"));
    match st.kernel.evaluate_counterparty(&cp) {
        CounterpartyDecision::Allow {
            risk_bps,
            solver_spread_bps,
            reason,
        } => near_return_json(&format!(
            "{{\"decision\":\"ALLOW\",\"risk_bps\":{risk_bps},\"solver_spread_bps\":{solver_spread_bps},\"reason\":\"{reason}\"}}"
        )),
        CounterpartyDecision::Warn { risk_bps, reason } => near_return_json(&format!(
            "{{\"decision\":\"WARN\",\"risk_bps\":{risk_bps},\"reason\":\"{reason}\"}}"
        )),
        CounterpartyDecision::Block {
            reason,
            evidence_tx_hash,
        } => {
            let ev = evidence_tx_hash.unwrap_or_default();
            near_return_json(&format!(
                "{{\"decision\":\"BLOCK\",\"risk_bps\":10000,\"reason\":\"{reason}\",\"evidence_tx_hash\":\"{ev}\"}}"
            ));
        }
    }
}
