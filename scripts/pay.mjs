// Full chain, live: contract -> verify -> policy -> payer message -> (if allowed) REAL PayPal sandbox invoices.
// node scripts/pay.mjs samples/clean-contract.txt "Can I pay the launch milestone in 2 parts?"
// Needs in .env: GEMINI_API_KEY, PAYPAL_* and PAYER_EMAIL (your sandbox PERSONAL account email).
try { process.loadEnvFile(".env"); } catch {}
import fs from "node:fs";
import { extractWithFallback } from "../src/gemini.mjs";
import { verifyExtraction } from "../src/verify.mjs";
import { buildPolicy } from "../src/policy.mjs";
import { makeClassifier } from "../src/intent.mjs";
import { handleMessage } from "../src/agent.mjs";
import { createInvoicesFromDecision } from "../src/invoicing.mjs";
import { saveAgreement, saveApproval, saveDecision, saveInvoices, isApproved } from "../src/store.mjs";

const [file, message] = process.argv.slice(2);
if (!file || !message) { console.log('Usage: node scripts/pay.mjs <contract.txt> "<payer message>"'); process.exit(1); }
const { GEMINI_API_KEY: apiKey, PAYER_EMAIL: payerEmail } = process.env;
if (!apiKey || !payerEmail) { console.log("GEMINI_API_KEY and PAYER_EMAIL must be in .env"); process.exit(1); }
const models = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);

try {
  const text = fs.readFileSync(file, "utf8");
  console.log("1/4 Reading the contract (5-30 s)...");
  const { extraction } = await extractWithFallback(text, { apiKey, models, onAttempt: ({ model, attempt }) => attempt > 1 && console.log(`    retrying ${model} (attempt ${attempt})...`) });
  const report = verifyExtraction(text, extraction);
  if (report.status !== "verified") {
    console.log("Terms need human review. The agent may not act:");
    for (const i of report.issues) console.log(`  - [${i.code}] ${i.message}`);
    process.exit(0);
  }
  // Optional memory: with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env, every step is saved so the ledger can explain each payment.
  let db = null, agreement = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    agreement = await saveAgreement(db, { sourceText: text, extraction, report });
    await saveApproval(db, { agreementId: agreement.id, approvedBy: "owner (demo CLI)" });
    if (!(await isApproved(db, agreement.id))) throw new Error("approval not recorded");
  } else console.log("    (no SUPABASE_* in .env: results are shown here but not saved)");
  console.log("2/4 Terms verified. Owner approval simulated.");
  const policy = buildPolicy({ extraction, report, approvedByOwner: true });
  console.log("3/4 Agent is handling the payer message...");
  const out = await handleMessage({ policy, message, classify: makeClassifier({ apiKey, models }) });
  console.log("\n--- AGENT TRACE ---");
  for (const s of out.trace) console.log(`[${s.actor}] ${s.step}: ${JSON.stringify({ ...s, step: undefined, actor: undefined })}`);
  console.log("\n--- REPLY TO PAYER ---\n" + out.reply);

  const decisionRow = db ? await saveDecision(db, { agreementId: agreement.id, message, request: out.request, decision: out.decision, reply: out.reply, trace: out.trace }) : null;
  if (out.decision.decision !== "allow") { console.log(`\nNo invoice created (policy said: ${out.decision.decision}).`); process.exit(0); }
  console.log("\n4/4 Policy said ALLOW. Creating real PayPal sandbox invoices...");
  const { pp } = await import("../src/paypal.mjs");
  const invoices = await createInvoicesFromDecision({ pp, policy, decision: out.decision, payerEmail, agreementId: `demo-${Date.now()}` });
  if (db) await saveInvoices(db, { agreementId: agreement.id, decisionId: decisionRow.id, milestone: out.decision.action.milestone, currency: policy.currency, invoices });
  for (const inv of invoices) console.log(`  ${inv.id}  ${inv.amount} ${policy.currency}  due in ${inv.dueInDays} days\n  pay link: ${inv.payUrl}`);
} catch (e) {
  console.log("\nFAILED:", e.cause?.code ? `${e.message} (${e.cause.code})` : e.message);
  console.log("EAI_AGAIN / fetch failed / timeout = your internet. Run the same command again.");
  process.exit(1);
}
