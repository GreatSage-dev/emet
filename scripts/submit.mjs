/**
 * EMET Protocol — NEAR Hackathon 2026 Submission Validator & Dispatcher.
 * Conforms strictly to https://nearhackathon.com/HACKATHON.md rules & API contract.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NEAR_ADDRESS_REGEX = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const VALID_SIZES = new Set(["1", "2 - 4", "4 - 6", "6 - 8", "8+"]);
const VALID_TRACKS = new Set([
  "defi",
  "thesis",
  "privacy",
  "business",
  "swarms",
  "security",
  "agents",
  "realworld",
  "games",
  "nfts",
  "memecoins",
  "social",
  "open",
]);

export function buildEmetIdeaDescription() {
  return (
    "EMET (אמת) is the outcome-verified double-entry budget and settlement kernel for autonomous AI agents on NEAR. " +
    "Today, AI agents with autonomous wallet access face two fatal failure modes: runaway retry loops on stalled bridge relayers, and pre-signing policy wrappers that go blind after signing (as demonstrated by the Oct 1 $3.8M NEAR Intents ghost-deposit exploit). " +
    "EMET enforces a strict Two-Stroke architecture: " +
    "(1) Pre-signing Shield: AI agents are restricted to hardware-level Function-Call Access Keys scoped strictly to `emet.near::initiate_intent`, locking funds in-flight and checking an on-chain counterparty blocklist. " +
    "(2) Post-signing Accelerator: EMET queries NEAR's decentralized threshold MPC network (`v1.signer-prod.testnet` v3.18.0) via cross-contract calls to verify foreign chain transaction finality (SvmFinality::Finalized / EvmFinality::Finalized) before releasing escrow. " +
    "If the foreign tx succeeds, funds settle and solver spreads collapse from 200 bps to 10 bps; if the tx reverts or was a ghost deposit, funds are deterministically refunded. " +
    "EMET exposes native Model Context Protocol (MCP) tools for AI agents (integrating with nearai/near-mcp and near/agent-skills) and compiles to a zero-overhead Rust WebAssembly contract."
  );
}

export function validateSubmissionPayload(payload) {
  const errors = [];

  if (!payload.requestId || typeof payload.requestId !== "string") {
    errors.push("requestId must be a valid UUID string");
  }
  if (!payload.projectName || payload.projectName.length < 2 || payload.projectName.length > 80) {
    errors.push("projectName must be 2-80 characters");
  }
  if (!payload.leadName || payload.leadName.length < 2 || payload.leadName.length > 80) {
    errors.push("leadName must be 2-80 characters");
  }
  if (!payload.email || payload.email.length > 160 || !payload.email.includes("@")) {
    errors.push("email must be a valid email address up to 160 characters");
  }
  if (!VALID_SIZES.has(payload.size)) {
    errors.push(`size must be one of: ${Array.from(VALID_SIZES).join(", ")}`);
  }
  if (!Array.isArray(payload.tracks) || payload.tracks.length === 0) {
    errors.push("tracks must be a non-empty array of valid track ids");
  } else {
    for (const t of payload.tracks) {
      if (!VALID_TRACKS.has(t)) errors.push(`Unknown track id: ${t}`);
    }
  }
  if (
    !payload.nearAddress ||
    payload.nearAddress.length < 2 ||
    payload.nearAddress.length > 64 ||
    !NEAR_ADDRESS_REGEX.test(payload.nearAddress)
  ) {
    errors.push("nearAddress must be a valid NEAR account (2-64 chars, e.g. 'team.near' or 64-char implicit)");
  }
  if (
    !payload.projectUrl ||
    payload.projectUrl.length > 300 ||
    !/^https?:\/\//.test(payload.projectUrl)
  ) {
    errors.push("projectUrl must be a valid http(s) URL to public repository (max 300 chars)");
  }
  if (
    !payload.demoUrl ||
    payload.demoUrl.length > 300 ||
    !/^https?:\/\//.test(payload.demoUrl)
  ) {
    errors.push("demoUrl must be a valid http(s) URL to the public demo post on X (max 300 chars)");
  }
  if (!payload.idea || payload.idea.length < 20 || payload.idea.length > 2000) {
    errors.push("idea must be 20-2000 characters");
  }
  if (payload.consent !== true) {
    errors.push("consent must be explicitly true");
  }
  if ("website" in payload) {
    errors.push("Spam trap: 'website' field must NOT be included in submission body");
  }

  return errors;
}

export function createDraftPayload(overrides = {}) {
  const defaults = {
    requestId: crypto.randomUUID(),
    projectName: "EMET (אמת)",
    leadName: overrides.leadName || "Promise",
    email: overrides.email || "builder@emet.near",
    size: overrides.size || "1",
    tracks: ["security", "defi", "agents"],
    nearAddress: overrides.nearAddress || "emet.near",
    projectUrl: overrides.projectUrl || "https://github.com/emet-protocol/emet-near",
    demoUrl: overrides.demoUrl || "https://x.com/NEARProtocol/status/1234567890123456789",
    idea: buildEmetIdeaDescription(),
    consent: true,
  };
  return { ...defaults, ...overrides };
}

// CLI Driver
if (process.argv[1] && process.argv[1].endsWith("submit.mjs")) {
  const isSubmit = process.argv.includes("--submit");
  const configPath = path.resolve(process.cwd(), "submission.config.json");

  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      console.warn(`[WARN] Could not parse ${configPath}:`, e.message);
    }
  }

  const payload = createDraftPayload(userConfig);
  const errors = validateSubmissionPayload(payload);

  console.log("================================================================================");
  console.log(" EMET PROTOCOL — NEAR HACKATHON 2026 SUBMISSION INSPECTOR");
  console.log("================================================================================");
  console.log(`Endpoint:   POST https://nearhackathon.com/api/applications`);
  console.log(`Payload Size: ${Buffer.byteLength(JSON.stringify(payload), "utf8")} bytes (limit: 12000)`);
  console.log(`Idea Length:  ${payload.idea.length} chars (range: 20 - 2000)`);
  console.log("--------------------------------------------------------------------------------");
  console.log(JSON.stringify(payload, null, 2));
  console.log("--------------------------------------------------------------------------------");

  if (errors.length > 0) {
    console.error("❌ VALIDATION ERRORS DETECTED:");
    for (const err of errors) console.error(`   • ${err}`);
    console.log("\nUpdate 'submission.config.json' with your exact human credentials before submitting.");
    process.exit(1);
  }

  console.log("✅ PAYLOAD VALIDATION PASSED — All HACKATHON.md schema constraints satisfied.");
  console.log("\nTo submit via curl:");
  console.log(
    `curl -sS -X POST https://nearhackathon.com/api/applications \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '${JSON.stringify(payload)}'\n`
  );

  if (isSubmit) {
    console.log("🚀 Submitting payload to https://nearhackathon.com/api/applications...");
    fetch("https://nearhackathon.com/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        const text = await res.text();
        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Response: ${text}`);
        if (res.status === 201) {
          console.log("🎉 SUCCESS: Submission received and registered!");
        }
      })
      .catch((err) => {
        console.error("Network error during submission:", err.message);
      });
  } else {
    console.log("ℹ️  Dry run only. To dispatch live submission, review with human and run: node scripts/submit.mjs --submit");
  }
}
