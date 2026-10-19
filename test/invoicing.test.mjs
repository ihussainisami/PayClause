import test from "node:test";
import assert from "node:assert/strict";
import { createInvoicesFromDecision, buildInvoiceBody } from "../src/invoicing.mjs";
import { buildPolicy, decide } from "../src/policy.mjs";

const q = (value, quote) => ({ value, quote });
const extraction = {
  total_fee: q(3000, "t"), currency: q("USD", "c"), net_days: q(15, "n"), extra_work_hourly_rate: q(60, "r"),
  milestones: [{ name: "launch", amount: 1000, quote: "m" }],
};
const policy = buildPolicy({ extraction, report: { status: "verified" }, approvedByOwner: true });
const today = new Date("2026-10-16T00:00:00Z");

function fakePP() {
  const calls = [];
  const pp = async (path, opts = {}) => {
    calls.push({ path, ...opts });
    if (path === "/v2/invoicing/invoices" && opts.method === "POST") return { status: 201, data: { href: `https://x/v2/invoicing/invoices/INV2-${calls.length}` } };
    if (path.endsWith("/send")) return { status: 202, data: {} };
    return { status: 200, data: { detail: { metadata: { recipient_view_url: "https://pay.example/" + path } } } };
  };
  return { pp, calls };
}

test("allowed 2-installment plan creates and sends 2 invoices that add up to the milestone", async () => {
  const decision = decide(policy, { type: "pay_in_installments", milestoneIndex: 0, installments: 2 });
  const { pp, calls } = fakePP();
  const out = await createInvoicesFromDecision({ pp, policy, decision, payerEmail: "p@example.com", agreementId: "A1", today });
  assert.equal(out.length, 2);
  assert.equal(out.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0), 100000);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/v2/invoicing/invoices").length, 2);
  assert.equal(out[1].dueInDays, 29); // 15 + 14
});

test("GATE: denied, owner-approval and unapproved decisions create NOTHING at PayPal", async () => {
  for (const req of [{ type: "ignore_contract" }, { type: "extra_work", estimatedHours: 5 }, { type: "pay_in_installments", milestoneIndex: 0, installments: 9 }]) {
    const { pp, calls } = fakePP();
    await assert.rejects(createInvoicesFromDecision({ pp, policy, decision: decide(policy, req), payerEmail: "p@e.com", agreementId: "A", today }));
    assert.equal(calls.length, 0);
  }
  const { pp, calls } = fakePP();
  const decision = decide(policy, { type: "pay_in_installments", milestoneIndex: 0, installments: 2 });
  await assert.rejects(createInvoicesFromDecision({ pp, policy: { ...policy, approvedByOwner: false }, decision, payerEmail: "p@e.com", agreementId: "A", today }));
  assert.equal(calls.length, 0);
});

test("a forged decision object without the policy's allow is rejected", async () => {
  const { pp, calls } = fakePP();
  await assert.rejects(createInvoicesFromDecision({ pp, policy, decision: { decision: "allow", action: { kind: "something_else" } }, payerEmail: "p@e.com", agreementId: "A", today }));
  assert.equal(calls.length, 0);
});

test("PayPal failure surfaces as an error", async () => {
  const decision = decide(policy, { type: "pay_in_installments", milestoneIndex: 0, installments: 1 });
  const pp = async () => ({ status: 422, data: { name: "UNPROCESSABLE" } });
  await assert.rejects(createInvoicesFromDecision({ pp, policy, decision, payerEmail: "p@e.com", agreementId: "A", today }), /422/);
});

test("invoice body uses the agreed amount, currency and due date", () => {
  const decision = decide(policy, { type: "pay_in_installments", milestoneIndex: 0, installments: 1 });
  const b = buildInvoiceBody({ action: decision.action, index: 0, payerEmail: "p@e.com", agreementId: "A", today });
  assert.equal(b.items[0].unit_amount.value, "1000.00");
  assert.equal(b.detail.currency_code, "USD");
  assert.equal(b.detail.payment_term.due_date, "2026-10-31");
});
