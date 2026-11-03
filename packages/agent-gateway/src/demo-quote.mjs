/**
 * NEAR Intents 1Click API Dry-Run Quote & Emet Spread Comparison (`npm run demo:quote`)
 */
import { fetchIntentsDryQuote } from "./index.mjs";

async function main() {
  const quote = await fetchIntentsDryQuote({
    originAsset: "nep141:usdc.near",
    destinationAsset: "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "2500000000", // 2,500.00 USDC
  });

  console.log(JSON.stringify(quote, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
