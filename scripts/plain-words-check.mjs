/**
 * King's Court Rule 8.8: The Automated Plain-Words Linter.
 * Enforces plain, honest human English with zero marketing fluff across
 * repository documentation and user-facing copy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const BANNED_WORDS = [
  "seamless",
  "robust",
  "revolutionize",
  "empower",
  "leverage",
  "cutting-edge",
  "trustless",
  "decentralized",
  "orchestrate",
  "primitive",
  "paradigm",
  "synergy",
  "autonomous ecosystem",
  "game-changing",
];

export const TARGET_FILES = [
  "README.md",
  "docs/JUDGES.md",
  "packages/agent-gateway/src/ui/app.html",
];

export function lintFile(filePath, bannedWords = BANNED_WORDS) {
  if (!fs.existsSync(filePath)) return { violations: [], wordCount: 0 };
  const content = fs.readFileSync(filePath, "utf8");
  const violations = [];

  for (const word of bannedWords) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    let match;
    while ((match = regex.exec(content)) !== null) {
      // Find line number
      const line = content.slice(0, match.index).split("\n").length;
      violations.push({ word, line, index: match.index });
    }
  }

  // Calculate words in intro before first section heading (##)
  const introMatch = content.match(/^(.*?)(\n##\s)/s);
  const introText = introMatch ? introMatch[1] : content;
  const wordCount = introText.trim().split(/\s+/).filter(Boolean).length;

  return { violations, wordCount };
}

export function runPlainWordsLinter() {
  console.log("================================================================================");
  console.log(" KING'S COURT: AUTOMATED PLAIN-WORDS LINTER (RULE 8.8)");
  console.log("================================================================================");

  let totalViolations = 0;

  for (const relPath of TARGET_FILES) {
    const fullPath = path.resolve(rootDir, relPath);
    if (!fs.existsSync(fullPath)) continue;

    const { violations, wordCount } = lintFile(fullPath);
    console.log(`Checking ${relPath}...`);
    if (relPath === "README.md") {
      console.log(`  • Intro word count: ${wordCount} words (300-word ceiling)`);
      if (wordCount > 300) {
        console.warn(`  ⚠️  README intro exceeds 300 words (${wordCount} words)`);
      }
    }

    if (violations.length === 0) {
      console.log(`  ✅ Clean: 0 banned words detected.`);
    } else {
      console.error(`  ❌ ${violations.length} banned words detected:`);
      for (const v of violations) {
        console.error(`     - Line ${v.line}: "${v.word}"`);
      }
      totalViolations += violations.length;
    }
  }

  console.log("--------------------------------------------------------------------------------");
  if (totalViolations > 0) {
    console.error(`❌ FAILED: ${totalViolations} plain-words violations found. Replace with plain English.`);
    process.exit(1);
  } else {
    console.log("✅ PASSED: 100% compliant with King's Court Plain-Words Standard.");
    process.exit(0);
  }
}

if (process.argv[1] && process.argv[1].endsWith("plain-words-check.mjs")) {
  runPlainWordsLinter();
}
