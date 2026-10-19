// The application logic behind the API. Everything external is injected, so it is fully testable offline.
// Rules enforced here: policy is always rebuilt from the DATABASE (never from the browser),
// a PayPal invoice only follows an allow decision or an owner-approved change order, and abuse caps apply.
import { verifyExtraction } from "./verify.mjs";
import { buildPolicy, decide, assertChangeOrderApproved } from "./policy.mjs";
import { handleMessage } from "./agent.mjs";
import { createInvoicesFromDecision, createInvoicesFromAction } from "./invoicing.mjs";
import { SAMPLES } from "./samples-data.mjs";
import { noLimiter } from "./limiter.mjs";

export class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const LIMITS = { maxText: 20000, minText: 80, maxMessage: 500, maxInvoicesPerAgreement: 6 };

export function createService({ store, extract, classify, pp, payerEmail, limiter = noLimiter, now = () => new Date() }) {
  const view = (row) => {
    const report = verifyExtraction(row.source_text, row.extraction);
    return { id: row.id, status: report.status, issues: report.issues, fields: report.fields, terms: row.extraction, createdAt: row.created_at, text: row.source_text };
  };

  async function loadPolicy(agreementId) {
    const row = await store.getAgreement(agreementId);
    if (!row) throw new ServiceError(404, "Agreement not found.");
    const report = verifyExtraction(row.source_text, row.extraction); // re-checked every time
    if (report.status !== "verified") throw new ServiceError(409, "These terms need human review, so the agent cannot act on them.");
    if (!(await store.isApproved(agreementId))) throw new ServiceError(409, "The freelancer has not approved these terms yet.");
    return buildPolicy({ extraction: row.extraction, report, approvedByOwner: true });
  }

  const guardInvoiceBudget = async (agreementId, adding) => {
    if ((await store.countInvoices(agreementId)) + adding > LIMITS.maxInvoicesPerAgreement) {
      throw new ServiceError(429, `Demo limit: at most ${LIMITS.maxInvoicesPerAgreement} invoices per agreement.`);
    }
  };

  return {
    samples: () => Object.entries(SAMPLES).map(([id, s]) => ({ id, label: s.label, text: s.text })),

    async submitAgreement({ text, sampleId }, ctx = {}) {
      let sourceText, extraction;
      if (sampleId) {
        const s = SAMPLES[sampleId];
        if (!s) throw new ServiceError(400, "Unknown sample.");
        ({ text: sourceText, extraction } = s); // cached model output; verification below still runs live
      } else {
        sourceText = String(text ?? "");
        if (sourceText.length < LIMITS.minText) throw new ServiceError(400, "Paste the full agreement text (at least a few sentences).");
        if (sourceText.length > LIMITS.maxText) throw new ServiceError(400, `The agreement is too long for this demo (max ${LIMITS.maxText} characters).`);
        await limiter.take("model", ctx.ip);
        extraction = await extract(sourceText);
      }
      const report = verifyExtraction(sourceText, extraction);
      const row = await store.saveAgreement({ sourceText, extraction, report });
      return { ...view(row), approved: false, source: sampleId ? "sample" : "model" };
    },

    async getAgreement(id) {
      const row = await store.getAgreement(id);
      if (!row) throw new ServiceError(404, "Agreement not found.");
      return { ...view(row), approved: await store.isApproved(id) };
    },

    async approveAgreement(id, approvedBy = "owner (demo)") {
      const row = await store.getAgreement(id);
      if (!row) throw new ServiceError(404, "Agreement not found.");
      if (verifyExtraction(row.source_text, row.extraction).status !== "verified") {
        throw new ServiceError(409, "These terms need human review. Fix the agreement and submit it again.");
      }
      if (!(await store.isApproved(id))) await store.saveApproval({ agreementId: id, approvedBy });
      return { ...view(row), approved: true };
    },

    async payerMessage(agreementId, message, ctx = {}) {
      message = String(message ?? "").trim();
      if (!message) throw new ServiceError(400, "Write a message first.");
      if (message.length > LIMITS.maxMessage) throw new ServiceError(400, `Keep the message under ${LIMITS.maxMessage} characters.`);
      const policy = await loadPolicy(agreementId);
      await limiter.take("model", ctx.ip);
      const out = await handleMessage({ policy, message, classify: (m) => classify(m, policy) });
      const saved = await store.saveDecision({ agreementId, message, request: out.request, decision: out.decision, reply: out.reply, trace: out.trace });

      let invoices = [];
      if (out.decision.decision === "allow" && out.decision.action?.kind === "create_invoices") {
        await guardInvoiceBudget(agreementId, out.decision.action.schedule.length);
        await limiter.take("invoice", ctx.ip, out.decision.action.schedule.length);
        invoices = await createInvoicesFromDecision({ pp, policy, decision: out.decision, payerEmail, agreementId, today: now() });
        await store.saveInvoices({ agreementId, decisionId: saved.id, milestone: out.decision.action.milestone, currency: policy.currency, invoices });
      }
      return { decisionId: saved.id, reply: out.reply, trace: out.trace, decision: out.decision.decision, code: out.decision.code, citations: out.decision.citations, draft: out.decision.draft ?? null, invoices };
    },

    async approveChangeOrder(decisionId, ctx = {}) {
      const d = await store.getDecision(decisionId);
      if (!d) throw new ServiceError(404, "Change order not found.");
      if (d.code !== "CHANGE_ORDER_DRAFT") throw new ServiceError(400, "That request is not a change order.");
      if (await store.hasChangeOrderApproval(decisionId)) throw new ServiceError(409, "This change order was already approved.");
      const policy = await loadPolicy(d.agreement_id);
      const recomputed = decide(policy, { type: "extra_work", estimatedHours: d.draft?.hours }); // never trust the stored amount
      const action = assertChangeOrderApproved(policy, recomputed, true);
      await guardInvoiceBudget(d.agreement_id, 1);
      await limiter.take("invoice", ctx.ip, 1); // before the approval row, so a refused request leaves nothing behind
      try { await store.saveChangeOrderApproval(decisionId); } // first, so a double click cannot invoice twice
      catch (e) { if (e.duplicate) throw new ServiceError(409, "This change order was already approved."); throw e; }
      const invoices = await createInvoicesFromAction({ pp, action, payerEmail, agreementId: d.agreement_id, today: now() });
      await store.saveInvoices({ agreementId: d.agreement_id, decisionId, milestone: action.milestone, currency: policy.currency, invoices });
      return { invoices };
    },

    async state(agreementId) {
      const a = await this.getAgreement(agreementId);
      const decisions = (await store.listDecisions(agreementId)).map((r) => ({
        id: r.id, at: r.created_at, message: r.payer_message, decision: r.decision, code: r.code,
        citations: r.citations, reply: r.reply, trace: r.trace, draft: r.draft, changeOrderApproved: r.changeOrderApproved,
      }));
      return { agreement: a, decisions, invoices: await store.listInvoices(agreementId) };
    },

    ledger: (agreementId) => store.listLedger(String(agreementId ?? "")),
    ping: () => store.ping(),
  };
}
