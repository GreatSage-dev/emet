/**
 * Code-only upgrade of an already-deployed EMET contract (no init call, state is kept).
 * Used so the live contract's code_hash equals the bundled artifacts/emet_settlement_contract.wasm,
 * which the /cockpit#verify screen re-hashes in the browser.
 *
 *   node scripts/redeploy-code.mjs [accountId]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  NearActions,
  base58Encode,
  nearRpc,
  signAndSendNearTransaction,
} from "../packages/agent-gateway/src/near_testnet.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "testnet-deployment.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const accountId = process.argv[2] || manifest.contractId;
const credPath = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  ".near-credentials",
  "testnet",
  `${accountId}.json`
);
const cred = JSON.parse(fs.readFileSync(credPath, "utf8"));
const wasm = fs.readFileSync(path.join(repoRoot, "artifacts/emet_settlement_contract.wasm"));
const localHash = base58Encode(crypto.createHash("sha256").update(wasm).digest());

const before = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
console.log(`account      ${accountId}`);
console.log(`live hash    ${before.code_hash}`);
console.log(`local hash   ${localHash} (${wasm.length} bytes)`);
if (before.code_hash === localHash) {
  console.log("already identical, nothing to do");
  process.exit(0);
}

const tx = await signAndSendNearTransaction({
  signerId: accountId,
  signerPublicKey: cred.public_key,
  signerPrivateKey: cred.private_key,
  receiverId: accountId,
  actions: [NearActions.deployContract(wasm)],
});
console.log(`upgrade tx   ${tx.txHash}`);

const after = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
console.log(`new hash     ${after.code_hash}`);
if (after.code_hash !== localHash) {
  console.error("hash mismatch after upgrade");
  process.exit(1);
}

manifest.previousCodeHash = manifest.codeHash;
manifest.codeHash = after.code_hash;
manifest.transactions.codeUpgrade = {
  txHash: tx.txHash,
  explorerUrl: `https://testnet.nearblocks.io/txns/${tx.txHash}`,
  note: "Code-only upgrade to add permissionless deadline timeout refund (claim_expired_intent). State and receipts unchanged.",
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log("testnet-deployment.json updated");
