/**
 * Zero-dependency NEAR Protocol JSON-RPC & Borsh Ed25519 Transaction Client (`node:crypto`).
 * Signs and dispatches real DeployContract, AddKey (scoped FunctionCall), and FunctionCall
 * transactions against `https://rpc.testnet.near.org`, plus view queries.
 */
import crypto from "node:crypto";

export const DEFAULT_NEAR_TESTNET_RPC = "https://rpc.testnet.near.org";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(buf) {
  const digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; buf[i] === 0 && i < buf.length - 1; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

export function base58Decode(str) {
  const clean = str.includes(":") ? str.split(":")[1] : str;
  const bytes = [0];
  for (let i = 0; i < clean.length; i++) {
    const c = BASE58_ALPHABET.indexOf(clean[i]);
    if (c < 0) throw new Error(`Invalid base58 character: ${clean[i]}`);
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; clean[i] === "1" && i < clean.length - 1; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export function generateNearKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const seedRaw = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const secret64 = Buffer.concat([seedRaw, pubRaw]);
  return {
    publicKey: `ed25519:${base58Encode(pubRaw)}`,
    privateKey: `ed25519:${base58Encode(secret64)}`,
    pubRaw,
    // NEAR VM `signer_account_pk` Borsh bytes: 0x00 (Ed25519) + 32-byte pubkey
    borshSignerPkHex: Buffer.concat([Buffer.from([0]), pubRaw]).toString("hex"),
  };
}

function ed25519PrivateKeyObjectFromNearSecret(nearSecret) {
  const raw = base58Decode(nearSecret);
  const seed32 = raw.subarray(0, 32);
  // PKCS#8 DER prefix for a 32-byte Ed25519 seed (RFC 8410)
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed32]),
    format: "der",
    type: "pkcs8",
  });
}

// --- Borsh Binary Encoders for NEAR Transactions ---

function borshU32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function borshU64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function borshU128(n) {
  let val = BigInt(n);
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    b[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return b;
}

function borshStr(s) {
  const utf8 = Buffer.from(s, "utf8");
  return Buffer.concat([borshU32(utf8.length), utf8]);
}

function borshPublicKey(nearPubStr) {
  const raw = base58Decode(nearPubStr);
  if (raw.length !== 32) throw new Error(`Expected 32-byte Ed25519 pubkey, got ${raw.length}`);
  return Buffer.concat([Buffer.from([0]), raw]);
}

export const NearActions = {
  createAccount() {
    return Buffer.from([0]);
  },
  deployContract(wasmBytes) {
    return Buffer.concat([Buffer.from([1]), borshU32(wasmBytes.length), wasmBytes]);
  },
  functionCall({ methodName, args = {}, gas = 100_000_000_000_000n, deposit = 0n }) {
    const argsBytes = Buffer.isBuffer(args)
      ? args
      : Buffer.from(typeof args === "string" ? args : JSON.stringify(args), "utf8");
    return Buffer.concat([
      Buffer.from([2]),
      borshStr(methodName),
      borshU32(argsBytes.length),
      argsBytes,
      borshU64(gas),
      borshU128(deposit),
    ]);
  },
  transfer(deposit) {
    return Buffer.concat([Buffer.from([3]), borshU128(deposit)]);
  },
  addFunctionCallKey({ publicKey, allowanceYocto = 250_000_000_000_000_000_000_000n, receiverId, methodNames = [] }) {
    const methodsBuf = Buffer.concat([
      borshU32(methodNames.length),
      ...methodNames.map((m) => borshStr(m)),
    ]);
    const allowanceBuf =
      allowanceYocto === null
        ? Buffer.from([0])
        : Buffer.concat([Buffer.from([1]), borshU128(allowanceYocto)]);
    return Buffer.concat([
      Buffer.from([5]), // Action::AddKey
      borshPublicKey(publicKey),
      borshU64(0n), // AccessKey.nonce = 0
      Buffer.from([0]), // AccessKeyPermission::FunctionCall
      allowanceBuf,
      borshStr(receiverId),
      methodsBuf,
    ]);
  },
};

export async function nearRpc(method, params, rpcUrl = DEFAULT_NEAR_TESTNET_RPC, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "emet-rpc", method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(`NEAR_RPC_ERROR: ${JSON.stringify(json.error)}`);
      err.rpcError = json.error;
      throw err;
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAccessKeyNonceAndBlockHash(accountId, publicKey, rpcUrl = DEFAULT_NEAR_TESTNET_RPC) {
  const ak = await nearRpc(
    "query",
    {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    },
    rpcUrl
  );
  return {
    nonce: BigInt(ak.nonce) + 1n,
    blockHashBytes: base58Decode(ak.block_hash),
    permission: ak.permission,
  };
}

export async function signAndSendNearTransaction({
  signerId,
  signerPublicKey,
  signerPrivateKey,
  receiverId,
  actions,
  rpcUrl = DEFAULT_NEAR_TESTNET_RPC,
  waitUntil = "FINAL",
}) {
  const { nonce, blockHashBytes } = await getAccessKeyNonceAndBlockHash(
    signerId,
    signerPublicKey,
    rpcUrl
  );

  const txBytes = Buffer.concat([
    borshStr(signerId),
    borshPublicKey(signerPublicKey),
    borshU64(nonce),
    borshStr(receiverId),
    blockHashBytes,
    borshU32(actions.length),
    ...actions,
  ]);

  const txHash = crypto.createHash("sha256").update(txBytes).digest();
  const privKeyObj = ed25519PrivateKeyObjectFromNearSecret(signerPrivateKey);
  const sigBytes = crypto.sign(null, txHash, privKeyObj);

  const signedTxBytes = Buffer.concat([txBytes, Buffer.from([0]), sigBytes]);
  const outcome = await nearRpc(
    "send_tx",
    {
      signed_tx_base64: signedTxBytes.toString("base64"),
      wait_until: waitUntil,
    },
    rpcUrl,
    90_000
  );

  return {
    txHash: outcome.transaction?.hash || base58Encode(txHash),
    status: outcome.status,
    outcome,
  };
}

export async function callNearViewFunction({
  contractId,
  methodName,
  args = {},
  rpcUrl = DEFAULT_NEAR_TESTNET_RPC,
  timeoutMs = 5_000,
}) {
  const res = await nearRpc(
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
    },
    rpcUrl,
    timeoutMs
  );
  const text = Buffer.from(res.result).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
