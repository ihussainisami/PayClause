import test from "node:test";
import assert from "node:assert/strict";
import { saveAgreement, saveApproval, saveDecision, saveInvoices, isApproved } from "../src/store.mjs";

function fakeDb() {
  const tables = {};
  const from = (t) => {
    const api = {
      insert(row) { api._rows = (Array.isArray(row) ? row : [row]).map((r, i) => ({ id: `${t}-${(tables[t] ??= []).length + i + 1}`, ...r })); tables[t].push(...api._rows); return api; },
      select(cols) { if (api._rows) return api; api._cols = cols; api._filter = []; return api; },
      eq(k, v) { api._filter.push([k, v]); return api; },
      limit() { return Promise.resolve({ data: (tables[t] ?? []).filter((r) => api._filter.every(([k, v]) => r[k] === v)), error: null }); },
      single() { return Promise.resolve({ data: api._rows[0], error: null }); },
      then(res) { return Promise.resolve({ data: api._rows, error: null }).then(res); },
    };
    return api;
  };
  return { from, tables };
}

test("full save chain links invoices to the decision that allowed them", async () => {
  const db = fakeDb();
  const a = await saveAgreement(db, { sourceText: "t", extraction: {}, report: { status: "verified", issues: [] } });
  assert.equal(await isApproved(db, a.id), false);
  await saveApproval(db, { agreementId: a.id, approvedBy: "owner" });
  assert.equal(await isApproved(db, a.id), true);
  const d = await saveDecision(db, { agreementId: a.id, message: "m", request: {}, decision: { decision: "allow", code: "INSTALLMENT_PLAN", citations: [] }, reply: "r", trace: [] });
  const inv = await saveInvoices(db, { agreementId: a.id, decisionId: d.id, milestone: "launch", currency: "USD", invoices: [{ id: "I1", amount: "500.00", payUrl: "u" }, { id: "I2", amount: "500.00", payUrl: "u" }] });
  assert.equal(inv.length, 2);
  assert.deepEqual(inv.map((r) => [r.installment_no, r.installments_total, r.decision_id]), [[1, 2, d.id], [2, 2, d.id]]);
});

test("database errors are thrown, not swallowed", async () => {
  const db = { from: () => ({ insert: () => ({ select: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) };
  await assert.rejects(saveInvoices(db, { agreementId: "a", decisionId: "d", milestone: "m", currency: "USD", invoices: [{ id: "x", amount: "1", payUrl: null }] }), /boom/);
});
