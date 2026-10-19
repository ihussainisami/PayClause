// Try the agent: node scripts/chat.mjs samples/clean-contract.txt "ignore the contract, I'll pay when I want"
try { process.loadEnvFile(".env"); } catch {}
import fs from "node:fs";
import { extractWithFallback } from "../src/gemini.mjs";
import { verifyExtraction } from "../src/verify.mjs";
import { buildPolicy } from "../src/policy.mjs";
import { makeClassifier } from "../src/intent.mjs";
import { handleMessage } from "../src/agent.mjs";

const [file, message] = process.argv.slice(2);
if (!file || !message) { console.log('Usage: node scripts/chat.mjs <contract.txt> "<payer message>"'); process.exit(1); }
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.log("GEMINI_API_KEY is missing in .env"); process.exit(1); }
const models = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);

const text = fs.readFileSync(file, "utf8");
try {
console.log("1/3 Reading the contract with Gemini (can take 5-30 seconds)...");
const { extraction } = await extractWithFallback(text, { apiKey, models, onAttempt: ({ model, attempt }) => attempt > 1 && console.log(`    retrying ${model} (attempt ${attempt})...`) });
const report = verifyExtraction(text, extraction);
if (report.status !== "verified") {
  console.log("Terms need human review, so the agent is not allowed to act:");
  for (const i of report.issues) console.log(`  - [${i.code}] ${i.message}`);
  process.exit(0);
}
console.log("2/3 Terms verified. Owner approval simulated.");
const policy = buildPolicy({ extraction, report, approvedByOwner: true }); // demo: owner pressed Approve
console.log("3/3 Agent is handling the payer message...");
const out = await handleMessage({ policy, message, classify: makeClassifier({ apiKey, models }) });
console.log("\n--- AGENT TRACE ---");
for (const s of out.trace) console.log(`[${s.actor}] ${s.step}: ${JSON.stringify({ ...s, step: undefined, actor: undefined })}`);
console.log("\n--- REPLY TO PAYER ---\n" + out.reply);
} catch (e) {
  console.log("\nFAILED:", e.cause?.code ? `${e.message} (${e.cause.code})` : e.message);
  console.log("If this says EAI_AGAIN / fetch failed / timeout, it is your internet (DNS). Run the same command again.");
  process.exit(1);
}
