import test from "node:test";
import assert from "node:assert/strict";
import { makeLimiter, LimitError } from "../src/limiter.mjs";
import { createService } from "../src/service.mjs";
import { SAMPLES } from "../src/samples-data.mjs";
import { memoryStore } from "../src/memory-store.mjs";

const mk = (limits) => { const st = memoryStore(); return { st, limiter: makeLimiter({ bump: (...a) => st.bumpUsage(...a), limits, salt: "t" }) }; };

test("per-visitor cap blocks the visitor, not others", async () => {
  const { limiter } = mk({ model: { perIp: 2, global: 100 }, invoice: { perIp: 1, global: 10 } });
  await limiter.take("model", "1.1.1.1"); await limiter.take("model", "1.1.1.1");
  await assert.rejects(limiter.take("model", "1.1.1.1"), (e) => e instanceof LimitError && e.status === 429);
  await limiter.take("model", "2.2.2.2"); // someone else still fine
});

test("global cap protects the shared quota", async () => {
  const { limiter } = mk({ model: { perIp: 50, global: 3 }, invoice: { perIp: 5, global: 5 } });
  for (const ip of ["a", "b", "c"]) await limiter.take("model", ip);
  await assert.rejects(limiter.take("model", "d"), /daily limit/);
});

test("invoice cap counts every invoice in an installment plan", async () => {
  const { limiter } = mk({ model: { perIp: 9, global: 9 }, invoice: { perIp: 3, global: 9 } });
  await limiter.take("invoice", "x", 2);
  await assert.rejects(limiter.take("invoice", "x", 2), (e) => e.status === 429);
  await limiter.take("invoice", "x", 1);
});

test("service: a refused change order creates no approval and no PayPal call", async () => {
  const { st, limiter } = mk({ model: { perIp: 99, global: 99 }, invoice: { perIp: 0, global: 99 } });
  let posts = 0;
  const pp = async (p, o = {}) => { if (o.method === "POST" && p === "/v2/invoicing/invoices") posts++; return { status: 201, data: { href: "https://x/INV2-1" } }; };
  const svc = createService({ store: st, extract: async () => SAMPLES.clean.extraction, classify: async () => ({ type: "extra_work", estimatedHours: 5 }), pp, payerEmail: "p@example.com", limiter });
  const a = await svc.submitAgreement({ sampleId: "clean" }); await svc.approveAgreement(a.id);
  const m = await svc.payerMessage(a.id, "Please add a blog page, about 5 h", { ip: "9.9.9.9" });
  assert.equal(m.code, "CHANGE_ORDER_DRAFT");
  await assert.rejects(svc.approveChangeOrder(m.decisionId, { ip: "9.9.9.9" }), (e) => e.status === 429);
  assert.equal(posts, 0);
  assert.equal(st.t.coa.length, 0);
});

test("service: model cap stops AI calls on custom text but samples stay free", async () => {
  const { st, limiter } = mk({ model: { perIp: 1, global: 99 }, invoice: { perIp: 9, global: 99 } });
  let calls = 0;
  const svc = createService({ store: st, extract: async () => { calls++; return SAMPLES.clean.extraction; }, classify: async () => ({ type: "unknown" }), pp: async () => ({}), payerEmail: "p@example.com", limiter });
  await svc.submitAgreement({ sampleId: "clean" }, { ip: "1" }); await svc.submitAgreement({ sampleId: "trap" }, { ip: "1" });
  await svc.submitAgreement({ text: SAMPLES.clean.text }, { ip: "1" });
  await assert.rejects(svc.submitAgreement({ text: SAMPLES.clean.text }, { ip: "1" }), (e) => e.status === 429);
  assert.equal(calls, 1);
});
