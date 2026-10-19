// Usage: node scripts/extract.mjs samples/trap-contract.txt
try { process.loadEnvFile(".env"); } catch {}
import fs from "node:fs";
import { extractWithFallback, listModels } from "../src/gemini.mjs";
import { verifyExtraction } from "../src/verify.mjs";

const file = process.argv[2];
if (!file) { console.log("Usage: node scripts/extract.mjs <contract.txt>"); process.exit(1); }
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.log("GEMINI_API_KEY is missing in .env"); process.exit(1); }
// GEMINI_MODEL may be a comma-separated list; the next one is used if the first is busy.
const models = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);

const text = fs.readFileSync(file, "utf8");
let extraction, model;
try {
  ({ extraction, model } = await extractWithFallback(text, {
    apiKey, models,
    onAttempt: ({ model, attempt }) => console.log(`Trying ${model} (attempt ${attempt})...`),
  }));
} catch (e) {
  console.log("FAILED:", e.message);
  if (e.status === 404) {
    console.log(`A model in your list was not found. Models available to your key:`);
    console.log((await listModels({ apiKey })).join("\n"));
    console.log('Put one of them in .env as GEMINI_MODEL=<name> and run again.');
  }
  process.exit(1);
}

const report = verifyExtraction(text, extraction);
console.log(`Model: ${model}`);
console.log("\nWhat the model proposed:");
console.log(`  total_fee: ${extraction.total_fee ? extraction.total_fee.value : "(MISSING - model did not return it)"}`);
for (const [k, v] of Object.entries(extraction)) {
  if (k === "milestones") console.log(`  milestones: ${v.map((m) => `${m.name}=${m.amount}`).join(", ")}`);
  else if (k !== "total_fee") console.log(`  ${k}: ${v?.value}`);
}
console.log(`\nVERIFIER STATUS: ${report.status}`);
for (const i of report.issues) console.log(`  - [${i.code}] ${i.message}${i.quote ? `  ("${i.quote}")` : ""}`);
if (report.issues.length === 0) console.log("  no issues");

if (process.argv[3] === "--raw") console.log("\nRAW:", JSON.stringify(extraction, null, 1));
