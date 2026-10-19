import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyExtraction } from "../src/verify.mjs";
import { buildPolicy, decide, assertInvoiceAllowed } from "../src/policy.mjs";

const clean = fs.readFileSync(new URL("../samples/clean-contract.txt", import.meta.url), "utf8");
const trap = fs.readFileSync(new URL("../samples/trap-contract.txt", import.meta.url), "utf8");
const extraction = () => ({
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
const policy = (over = {}) => {
  const e = extraction();
  return buildPolicy({ extraction: e, report: verifyExtraction(clean, e), approvedByOwner: true, ...over });
};

test("policy cannot be built from unverified terms (trap contract)", () => {
  const e = extraction();
  assert.throws(() => buildPolicy({ extraction: e, report: verifyExtraction(trap, e), approvedByOwner: true }), /not verified/);
});

test("policy cannot be built without owner approval", () => {
  const e = extraction();
  assert.throws(() => buildPolicy({ extraction: e, report: verifyExtraction(clean, e), approvedByOwner: false }), /not approved/);
});

test("3 installments: allowed, cents add up exactly, citations present", () => {
  const d = decide(policy(), { type: "pay_in_installments", milestoneIndex: 0, installments: 3 });
  assert.equal(d.decision, "allow");
  const amounts = d.action.schedule.map((s) => s.amount);
  assert.deepEqual(amounts, ["333.33", "333.33", "333.34"]);
  assert.equal(amounts.reduce((a, b) => a + Math.round(Number(b) * 100), 0), 100000);
  assert.ok(d.citations.some((c) => c.source === "contract" && c.quote.includes("$1,000.00")));
  assert.ok(d.citations.some((c) => c.source === "owner_limit"));
});

test("5 installments: denied, cites the owner's limit", () => {
  const d = decide(policy(), { type: "pay_in_installments", milestoneIndex: 0, installments: 5 });
  assert.equal(d.decision, "deny");
  assert.equal(d.code, "TOO_MANY_INSTALLMENTS");
});

test("extension within limit allowed, beyond limit denied", () => {
  assert.equal(decide(policy(), { type: "extend_due_date", days: 5 }).decision, "allow");
  assert.equal(decide(policy(), { type: "extend_due_date", days: 20 }).decision, "deny");
});

test("WOW: 'ignore the contract / pay whenever / reduce the fee' -> refused with the clause quoted", () => {
  for (const type of ["ignore_contract", "pay_whenever", "reduce_total", "skip_payment"]) {
    const d = decide(policy(), { type });
    assert.equal(d.decision, "deny");
    assert.equal(d.code, "CONTRACT_PREVAILS");
    assert.ok(d.citations.some((c) => c.quote.includes("$3,000.00")));
    assert.ok(d.citations.some((c) => c.quote.includes("Net 15")));
  }
});

test("extra work: change-order draft = hours x contract rate, needs owner approval, never auto-allowed", () => {
  const d = decide(policy(), { type: "extra_work", estimatedHours: 4 });
  assert.equal(d.decision, "needs_owner_approval");
  assert.equal(d.draft.amount, "240.00");
  assert.ok(d.citations[0].quote.includes("$60 per hour"));
  assert.equal(d.action, undefined);
});

test("extra work with no rate in the contract -> owner decides", () => {
  const e = extraction();
  delete e.extra_work_hourly_rate;
  const p = buildPolicy({ extraction: e, report: verifyExtraction(clean, e), approvedByOwner: true });
  assert.equal(decide(p, { type: "extra_work", estimatedHours: 4 }).code, "NO_EXTRA_WORK_RATE");
});

test("late fee waiver is never automatic", () => {
  assert.equal(decide(policy(), { type: "waive_late_fee" }).decision, "needs_owner_approval");
});

test("unknown request types go to the owner", () => {
  assert.equal(decide(policy(), { type: "do_something_creative" }).decision, "needs_owner_approval");
  assert.equal(decide(policy(), undefined).decision, "needs_owner_approval");
});

test("garbage numbers are rejected", () => {
  for (const installments of [0, -1, 1.5, NaN, "3; drop table", null]) {
    const d = decide(policy(), { type: "pay_in_installments", milestoneIndex: 0, installments });
    assert.equal(d.decision, "deny", String(installments));
  }
  assert.equal(decide(policy(), { type: "pay_in_installments", milestoneIndex: 9, installments: 2 }).decision, "deny");
  assert.equal(decide(policy(), { type: "extra_work", estimatedHours: -3 }).decision, "needs_owner_approval");
  assert.equal(decide(policy(), { type: "extra_work", estimatedHours: 9999 }).decision, "needs_owner_approval");
});

test("GATE: PayPal invoice only opens for an 'allow' decision on approved terms", () => {
  const p = policy();
  const ok = decide(p, { type: "pay_in_installments", milestoneIndex: 1, installments: 2 });
  assert.equal(assertInvoiceAllowed(p, ok).kind, "create_invoices");
  assert.throws(() => assertInvoiceAllowed(p, decide(p, { type: "reduce_total" })), /Blocked/);
  assert.throws(() => assertInvoiceAllowed(p, decide(p, { type: "extra_work", estimatedHours: 4 })), /Blocked/);
  assert.throws(() => assertInvoiceAllowed({ ...p, approvedByOwner: false }, ok), /not approved/);
  assert.throws(() => assertInvoiceAllowed(p, undefined), /Blocked/);
});
