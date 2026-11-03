//! Binary-compatible NEAR MPC (`v1.signer-prod.testnet` / `near/mpc` v3.18.0)
//! Foreign Chain Verification & Chain Signatures wire primitives for Emet.
//!
//! Zero external proc-macro or `build.rs` dependencies: compiles deterministically
//! to `wasm32-unknown-unknown` and native targets on any platform.

/// NEAR MPC Signer contract method constants (`near-mpc-contract-interface::method_names`).
pub mod method_names {
    pub const SIGN: &str = "sign";
    pub const VERIFY_FOREIGN_TRANSACTION: &str = "verify_foreign_transaction";
    pub const GET_AVAILABLE_FOREIGN_CHAINS: &str = "get_available_foreign_chains";
    pub const VERSION: &str = "version";
}

/// FIPS 180-4 deterministic SHA-256 implementation for on-chain & WASM verification.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX_CHARS[(b >> 4) as usize] as char);
        s.push(HEX_CHARS[(b & 0x0f) as usize] as char);
    }
    s
}

/// Canonical Borsh byte encoder trait.
pub trait BorshEncode {
    fn encode_borsh(&self, buf: &mut Vec<u8>);
}

fn encode_vec<T: BorshEncode>(items: &[T], buf: &mut Vec<u8>) {
    buf.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for item in items {
        item.encode_borsh(buf);
    }
}

/// Canonical 32-byte SHA-256 digest or chain hash.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Hash256(pub [u8; 32]);

impl Hash256 {
    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

impl BorshEncode for Hash256 {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct Hash160(pub [u8; 20]);

impl BorshEncode for Hash160 {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct EvmTxId(pub [u8; 32]);

impl BorshEncode for EvmTxId {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SvmTxId(pub [u8; 64]);

impl BorshEncode for SvmTxId {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SvmAddress(pub [u8; 32]);

impl BorshEncode for SvmAddress {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct BitcoinTxId(pub [u8; 32]);

impl BorshEncode for BitcoinTxId {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct BlockConfirmations(pub u64);

impl BorshEncode for BlockConfirmations {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.0.to_le_bytes());
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct DomainId(pub u64);

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
#[repr(u8)]
pub enum ForeignTxPayloadVersion {
    V1 = 1,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ForeignChain {
    Solana,
    Bitcoin,
    Ethereum,
    Base,
    Bnb,
    Arbitrum,
    Abstract,
    Starknet,
    Polygon,
    HyperEvm,
    Ton,
    Aptos,
    Sui,
    Avalanche,
    Adi,
    Fogo,
}

impl ForeignChain {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Solana => "solana",
            Self::Bitcoin => "bitcoin",
            Self::Ethereum => "ethereum",
            Self::Base => "base",
            Self::Bnb => "bnb",
            Self::Arbitrum => "arbitrum",
            Self::Abstract => "abstract",
            Self::Starknet => "starknet",
            Self::Polygon => "polygon",
            Self::HyperEvm => "hyper_evm",
            Self::Ton => "ton",
            Self::Aptos => "aptos",
            Self::Sui => "sui",
            Self::Avalanche => "avalanche",
            Self::Adi => "adi",
            Self::Fogo => "fogo",
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum EvmFinality {
    Latest,
    Safe,
    Finalized,
}

impl BorshEncode for EvmFinality {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        let disc = match self {
            Self::Latest => 0u8,
            Self::Safe => 1u8,
            Self::Finalized => 2u8,
        };
        buf.push(disc);
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SvmFinality {
    Confirmed,
    Finalized,
}

impl BorshEncode for SvmFinality {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        let disc = match self {
            Self::Confirmed => 0u8,
            Self::Finalized => 1u8,
        };
        buf.push(disc);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum EvmExtractor {
    BlockHash,
    Log { log_index: u64 },
}

impl BorshEncode for EvmExtractor {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::BlockHash => buf.push(0u8),
            Self::Log { log_index } => {
                buf.push(1u8);
                buf.extend_from_slice(&log_index.to_le_bytes());
            }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct EvmLog {
    pub removed: bool,
    pub log_index: u64,
    pub transaction_index: u64,
    pub transaction_hash: Hash256,
    pub block_hash: Hash256,
    pub block_number: u64,
    pub address: Hash160,
    pub data: String,
    pub topics: Vec<Hash256>,
}

impl BorshEncode for EvmLog {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.push(u8::from(self.removed));
        buf.extend_from_slice(&self.log_index.to_le_bytes());
        buf.extend_from_slice(&self.transaction_index.to_le_bytes());
        self.transaction_hash.encode_borsh(buf);
        self.block_hash.encode_borsh(buf);
        buf.extend_from_slice(&self.block_number.to_le_bytes());
        self.address.encode_borsh(buf);
        buf.extend_from_slice(&(self.data.len() as u32).to_le_bytes());
        buf.extend_from_slice(self.data.as_bytes());
        encode_vec(&self.topics, buf);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SvmExtractor {
    InnerInstruction {
        instruction_index: u64,
        inner_instruction_index: u64,
    },
    AccountState {
        pubkey: SvmAddress,
    },
}

impl BorshEncode for SvmExtractor {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            // `near/mpc` uses explicit discriminant starting at 1 for SvmExtractor
            Self::InnerInstruction {
                instruction_index,
                inner_instruction_index,
            } => {
                buf.push(1u8);
                buf.extend_from_slice(&instruction_index.to_le_bytes());
                buf.extend_from_slice(&inner_instruction_index.to_le_bytes());
            }
            Self::AccountState { pubkey } => {
                buf.push(2u8);
                pubkey.encode_borsh(buf);
            }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SvmInnerInstruction {
    pub program_id: SvmAddress,
    pub accounts: Vec<SvmAddress>,
    pub data: Vec<u8>,
}

impl BorshEncode for SvmInnerInstruction {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        self.program_id.encode_borsh(buf);
        encode_vec(&self.accounts, buf);
        buf.extend_from_slice(&(self.data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&self.data);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SvmAccount {
    pub owner: SvmAddress,
    pub data: Vec<u8>,
}

impl BorshEncode for SvmAccount {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        self.owner.encode_borsh(buf);
        buf.extend_from_slice(&(self.data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&self.data);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum BitcoinExtractor {
    BlockHash,
}

impl BorshEncode for BitcoinExtractor {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        buf.push(0u8);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct EvmRpcRequest {
    pub tx_id: EvmTxId,
    pub extractors: Vec<EvmExtractor>,
    pub finality: EvmFinality,
}

impl BorshEncode for EvmRpcRequest {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        self.tx_id.encode_borsh(buf);
        encode_vec(&self.extractors, buf);
        self.finality.encode_borsh(buf);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct SvmRpcRequest {
    pub tx_id: SvmTxId,
    pub finality: SvmFinality,
    pub extractors: Vec<SvmExtractor>,
}

impl BorshEncode for SvmRpcRequest {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        self.tx_id.encode_borsh(buf);
        self.finality.encode_borsh(buf);
        encode_vec(&self.extractors, buf);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct BitcoinRpcRequest {
    pub tx_id: BitcoinTxId,
    pub confirmations: BlockConfirmations,
    pub extractors: Vec<BitcoinExtractor>,
}

impl BorshEncode for BitcoinRpcRequest {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        self.tx_id.encode_borsh(buf);
        self.confirmations.encode_borsh(buf);
        encode_vec(&self.extractors, buf);
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct OpaqueChainPayload(pub Vec<u8>);

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ForeignChainRpcRequest {
    Abstract(EvmRpcRequest),          // 0
    Ethereum(EvmRpcRequest),          // 1
    Solana(SvmRpcRequest),            // 2
    Bitcoin(BitcoinRpcRequest),       // 3
    Starknet(OpaqueChainPayload),     // 4
    Bnb(EvmRpcRequest),               // 5
    Base(EvmRpcRequest),              // 6
    Arbitrum(EvmRpcRequest),          // 7
    Polygon(EvmRpcRequest),           // 8
    HyperEvm(EvmRpcRequest),          // 9
    Ton(OpaqueChainPayload),          // 10
    Aptos(OpaqueChainPayload),        // 11
    Sui(OpaqueChainPayload),          // 12
    Avalanche(EvmRpcRequest),         // 13
    Adi(EvmRpcRequest),               // 14
    Fogo(SvmRpcRequest),              // 15
}

impl BorshEncode for ForeignChainRpcRequest {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::Abstract(r) => { buf.push(0); r.encode_borsh(buf); }
            Self::Ethereum(r) => { buf.push(1); r.encode_borsh(buf); }
            Self::Solana(r) => { buf.push(2); r.encode_borsh(buf); }
            Self::Bitcoin(r) => { buf.push(3); r.encode_borsh(buf); }
            Self::Starknet(p) => { buf.push(4); buf.extend_from_slice(&p.0); }
            Self::Bnb(r) => { buf.push(5); r.encode_borsh(buf); }
            Self::Base(r) => { buf.push(6); r.encode_borsh(buf); }
            Self::Arbitrum(r) => { buf.push(7); r.encode_borsh(buf); }
            Self::Polygon(r) => { buf.push(8); r.encode_borsh(buf); }
            Self::HyperEvm(r) => { buf.push(9); r.encode_borsh(buf); }
            Self::Ton(p) => { buf.push(10); buf.extend_from_slice(&p.0); }
            Self::Aptos(p) => { buf.push(11); buf.extend_from_slice(&p.0); }
            Self::Sui(p) => { buf.push(12); buf.extend_from_slice(&p.0); }
            Self::Avalanche(r) => { buf.push(13); r.encode_borsh(buf); }
            Self::Adi(r) => { buf.push(14); r.encode_borsh(buf); }
            Self::Fogo(r) => { buf.push(15); r.encode_borsh(buf); }
        }
    }
}

impl ForeignChainRpcRequest {
    pub fn chain(&self) -> ForeignChain {
        match self {
            Self::Abstract(_) => ForeignChain::Abstract,
            Self::Ethereum(_) => ForeignChain::Ethereum,
            Self::Solana(_) => ForeignChain::Solana,
            Self::Bitcoin(_) => ForeignChain::Bitcoin,
            Self::Starknet(_) => ForeignChain::Starknet,
            Self::Bnb(_) => ForeignChain::Bnb,
            Self::Base(_) => ForeignChain::Base,
            Self::Arbitrum(_) => ForeignChain::Arbitrum,
            Self::Polygon(_) => ForeignChain::Polygon,
            Self::HyperEvm(_) => ForeignChain::HyperEvm,
            Self::Ton(_) => ForeignChain::Ton,
            Self::Aptos(_) => ForeignChain::Aptos,
            Self::Sui(_) => ForeignChain::Sui,
            Self::Avalanche(_) => ForeignChain::Avalanche,
            Self::Adi(_) => ForeignChain::Adi,
            Self::Fogo(_) => ForeignChain::Fogo,
        }
    }

    pub fn assert_strict_finality(&self) -> Result<(), FinalityPolicyError> {
        match self {
            Self::Solana(req) | Self::Fogo(req) => {
                if req.finality != SvmFinality::Finalized {
                    return Err(FinalityPolicyError::InsufficientSvmFinality {
                        got: req.finality,
                    });
                }
                Ok(())
            }
            Self::Ethereum(req)
            | Self::Bnb(req)
            | Self::Base(req)
            | Self::Arbitrum(req)
            | Self::Polygon(req)
            | Self::Abstract(req)
            | Self::HyperEvm(req)
            | Self::Avalanche(req)
            | Self::Adi(req) => {
                if req.finality != EvmFinality::Finalized {
                    return Err(FinalityPolicyError::InsufficientEvmFinality {
                        got: req.finality,
                    });
                }
                Ok(())
            }
            Self::Bitcoin(req) => {
                if req.confirmations.0 < 6 {
                    return Err(FinalityPolicyError::InsufficientBitcoinConfirmations {
                        got: req.confirmations.0,
                        required: 6,
                    });
                }
                Ok(())
            }
            _ => Err(FinalityPolicyError::UnsupportedChainForStrictSettlement),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum FinalityPolicyError {
    InsufficientSvmFinality { got: SvmFinality },
    InsufficientEvmFinality { got: EvmFinality },
    InsufficientBitcoinConfirmations { got: u64, required: u64 },
    UnsupportedChainForStrictSettlement,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum BitcoinExtractedValue {
    BlockHash(Hash256),
}

impl BorshEncode for BitcoinExtractedValue {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::BlockHash(h) => {
                buf.push(0);
                h.encode_borsh(buf);
            }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum EvmExtractedValue {
    BlockHash(Hash256),
    Log(EvmLog),
}

impl BorshEncode for EvmExtractedValue {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::BlockHash(h) => {
                buf.push(0);
                h.encode_borsh(buf);
            }
            Self::Log(l) => {
                buf.push(1);
                l.encode_borsh(buf);
            }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SvmExtractedValue {
    InnerInstruction(SvmInnerInstruction),
    AccountState(SvmAccount),
}

impl BorshEncode for SvmExtractedValue {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::InnerInstruction(ii) => {
                buf.push(0);
                ii.encode_borsh(buf);
            }
            Self::AccountState(acc) => {
                buf.push(1);
                acc.encode_borsh(buf);
            }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ExtractedValue {
    BitcoinExtractedValue(BitcoinExtractedValue),     // 0
    EvmExtractedValue(EvmExtractedValue),             // 1
    StarknetExtractedValue(OpaqueChainPayload),       // 2
    TonExtractedValue(OpaqueChainPayload),            // 3
    AptosExtractedValue(OpaqueChainPayload),          // 4
    SuiExtractedValue(OpaqueChainPayload),            // 5
    SvmExtractedValue(SvmExtractedValue),             // 6
}

impl BorshEncode for ExtractedValue {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::BitcoinExtractedValue(v) => { buf.push(0); v.encode_borsh(buf); }
            Self::EvmExtractedValue(v) => { buf.push(1); v.encode_borsh(buf); }
            Self::StarknetExtractedValue(p) => { buf.push(2); buf.extend_from_slice(&p.0); }
            Self::TonExtractedValue(p) => { buf.push(3); buf.extend_from_slice(&p.0); }
            Self::AptosExtractedValue(p) => { buf.push(4); buf.extend_from_slice(&p.0); }
            Self::SuiExtractedValue(p) => { buf.push(5); buf.extend_from_slice(&p.0); }
            Self::SvmExtractedValue(v) => { buf.push(6); v.encode_borsh(buf); }
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ForeignTxSignPayload {
    V1(ForeignTxSignPayloadV1),
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct ForeignTxSignPayloadV1 {
    pub request: ForeignChainRpcRequest,
    pub values: Vec<ExtractedValue>,
}

impl BorshEncode for ForeignTxSignPayload {
    fn encode_borsh(&self, buf: &mut Vec<u8>) {
        match self {
            Self::V1(v1) => {
                buf.push(0u8);
                v1.request.encode_borsh(buf);
                encode_vec(&v1.values, buf);
            }
        }
    }
}

impl ForeignTxSignPayload {
    pub fn compute_msg_hash(&self) -> Result<Hash256, &'static str> {
        let mut bytes = Vec::with_capacity(256);
        self.encode_borsh(&mut bytes);
        Ok(Hash256(sha256(&bytes)))
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct VerifyForeignTransactionRequestArgs {
    pub request: ForeignChainRpcRequest,
    pub domain_id: DomainId,
    pub payload_version: ForeignTxPayloadVersion,
    pub expected_payload_hash: Option<Hash256>,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct MpcSignature {
    pub scheme: String,
    pub signature_hex: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct VerifyForeignTransactionResponse {
    pub payload_hash: Hash256,
    pub signature: MpcSignature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum InspectorVerdict {
    Extracted(VerifyForeignTransactionResponse),
    TransactionFailed,
    TransactionNotFound,
    NonCanonicalBlock {
        block_number: u64,
        receipt_hash_hex: String,
        canonical_hash_hex: String,
    },
    LogIndexOutOfBounds,
    AccountNotFound,
}

impl InspectorVerdict {
    pub fn is_verified_truth(&self, expected_hash: &Hash256) -> bool {
        match self {
            Self::Extracted(resp) => &resp.payload_hash == expected_hash,
            _ => false,
        }
    }
}

/// Self-check function callable from both native tests and WASM runtime.
pub fn verify_near_mpc_snapshots() -> bool {
    let eth_payload = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request: ForeignChainRpcRequest::Ethereum(EvmRpcRequest {
            tx_id: EvmTxId([0xab; 32]),
            extractors: vec![EvmExtractor::BlockHash],
            finality: EvmFinality::Finalized,
        }),
        values: vec![ExtractedValue::EvmExtractedValue(
            EvmExtractedValue::BlockHash(Hash256([0xef; 32])),
        )],
    });
    if eth_payload.compute_msg_hash().unwrap().to_hex()
        != "2ab97999d1e015730271c7d6cbb298af76fd1de7af81926b42a8877bc4f5794e"
    {
        return false;
    }

    let sol_payload = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request: ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: SvmTxId([0x11; 64]),
            finality: SvmFinality::Finalized,
            extractors: vec![
                SvmExtractor::InnerInstruction {
                    instruction_index: 2,
                    inner_instruction_index: 0,
                },
                SvmExtractor::AccountState {
                    pubkey: SvmAddress([0x22; 32]),
                },
            ],
        }),
        values: vec![
            ExtractedValue::SvmExtractedValue(SvmExtractedValue::InnerInstruction(
                SvmInnerInstruction {
                    program_id: SvmAddress([0x33; 32]),
                    accounts: vec![SvmAddress([0x44; 32]), SvmAddress([0x55; 32])],
                    data: vec![0xde, 0xad, 0xbe, 0xef],
                },
            )),
            ExtractedValue::SvmExtractedValue(SvmExtractedValue::AccountState(SvmAccount {
                owner: SvmAddress([0x66; 32]),
                data: vec![0xca, 0xfe],
            })),
        ],
    });
    if sol_payload.compute_msg_hash().unwrap().to_hex()
        != "f53a1a864fa9ce51d50349b2e5fe38ff23e45b25b20038d405c12316f9bf05b1"
    {
        return false;
    }

    let btc_payload = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request: ForeignChainRpcRequest::Bitcoin(BitcoinRpcRequest {
            tx_id: BitcoinTxId([0x55; 32]),
            confirmations: BlockConfirmations(6),
            extractors: vec![BitcoinExtractor::BlockHash],
        }),
        values: vec![ExtractedValue::BitcoinExtractedValue(
            BitcoinExtractedValue::BlockHash(Hash256([42u8; 32])),
        )],
    });
    if btc_payload.compute_msg_hash().unwrap().to_hex()
        != "08e426dcd6eb98cc5eb5280d50f9c14e024f4a531bd5e09314ac4ae8bb07c9be"
    {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_near_mpc_v3_18_0_snapshots_match() {
        assert!(verify_near_mpc_snapshots());
    }
}
