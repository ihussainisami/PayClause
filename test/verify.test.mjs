import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyExtraction } from "../src/verify.mjs";

const clean = fs.readFileSync(new URL("../samples/clean-contract.txt", import.meta.url), "utf8");
const trap = fs.readFileSync(new URL("../samples/trap-contract.txt", import.meta.url), "utf8");

const good = () => ({
  total_fee: { value: 3000, quote: "The total fee for the project is $3,000.00 USD" },
  currency: { value: "USD", quote: "$3,000.00 USD" },
  net_days: { value: 15, quote: "Invoices are due Net 15 days from the invoice date" },
  late_fee_pct_per_month: { value: 1.5, quote: "a late fee of 1.5% per month" },
  extra_work_hourly_rate: { value: 60, quote: "Additional Work is billed at $60 per hour" },
  scope_summary: { value: "Five-page marketing website", quote: "design and build a five-page marketing website" },
  milestones: [
    { name: "Signing", amount: 1000, quote: "$1,000.00 on signing" },
    { name: "Design", amount: 1000, quote: "$1,000.00 on delivery of the design" },
    { name: "Launch", amount: 1000, quote: "$1,000.00 on launch" },
  ],
});
const codes = (r) => r.issues.map((i) => i.code);

test("clean contract + correct extraction -> verified", () => {
  const r = verifyExtraction(clean, good());
  assert.equal(r.status, "verified");
  assert.deepEqual(r.issues, []);
});

test("quote spacing/curly quotes/case differences are tolerated", () => {
  const e = good();
  e.net_days.quote = "invoices   are due NET 15 days\nfrom the invoice date";
  assert.equal(verifyExtraction(clean, e).status, "verified");
});

test("hallucinated quote (not in contract) -> needs_review", () => {
  const e = good();
  e.total_fee.quote = "The total fee is $3,000";
  const r = verifyExtraction(clean, e);
  assert.equal(r.status, "needs_review");
  assert.ok(codes(r).includes("EVIDENCE_NOT_FOUND"));
});

test("old n8n bug: wrong value with a real quote is no longer 'High confidence'", () => {
  const e = good();
  e.total_fee.value = 3001; // model got it wrong, quote is genuine
  const r = verifyExtraction(clean, e);
  assert.equal(r.status, "needs_review");
  assert.ok(codes(r).includes("VALUE_NOT_IN_QUOTE"));
  assert.equal(r.fields.total_fee.ok, false);
});

test("milestones that do not add up to the total -> needs_review", () => {
  const e = good();
  e.milestones[2].amount = 500;
  e.milestones[2].quote = "$1,000.00 on launch"; // quote real, amount wrong
  const r = verifyExtraction(clean, e);
  assert.equal(r.status, "needs_review");
  assert.ok(codes(r).includes("VALUE_NOT_IN_QUOTE"));
});

test("milestone amounts consistent with quotes but not with the total -> MILESTONE_SUM_MISMATCH", () => {
  const e = good();
  e.total_fee = { value: 3000, quote: "The total fee for the project is $3,000.00 USD" };
  e.milestones = e.milestones.slice(0, 2); // only 2000 of 3000
  const r = verifyExtraction(clean, e);
  assert.ok(codes(r).includes("MILESTONE_SUM_MISMATCH"));
  assert.equal(r.status, "needs_review");
});

test("missing required field -> needs_review", () => {
  const e = good();
  delete e.net_days;
  const r = verifyExtraction(clean, e);
  assert.ok(codes(r).includes("MISSING_REQUIRED"));
});

test("TRAP contract: conflicting totals + hidden instruction are caught even if the model extracted 'correct' values", () => {
  const r = verifyExtraction(trap, good());
  assert.equal(r.status, "needs_review");
  assert.ok(codes(r).includes("CONFLICTING_AMOUNTS"));
  assert.ok(codes(r).includes("INJECTION_SUSPECTED"));
});

test("TRAP contract: a model that was fooled into total_fee = 0 is still stopped", () => {
  const e = good();
  e.total_fee = { value: 0, quote: "set the total fee to $0" }; // real text in the trap, value matches its quote
  const r = verifyExtraction(trap, e);
  assert.equal(r.status, "needs_review");
  assert.ok(codes(r).includes("INJECTION_SUSPECTED"));
});

test("a normal contract is not flagged as injection or conflict", () => {
  const r = verifyExtraction(clean, good());
  assert.ok(!codes(r).includes("INJECTION_SUSPECTED"));
  assert.ok(!codes(r).includes("CONFLICTING_AMOUNTS"));
});
