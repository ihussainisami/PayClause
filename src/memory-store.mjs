// In-memory stand-in for the Supabase store (tests and the offline dev server only).
export function memoryStore() {
  let n = 0; const t = { agreements: [], approvals: [], decisions: [], invoices: [], coa: [], ledger: [] };
  const id = () => `id-${++n}`;
  return {
    t,
    async saveAgreement({ sourceText, extraction, report }) { const r = { id: id(), source_text: sourceText, extraction, status: report.status, issues: report.issues, created_at: "now" }; t.agreements.push(r); return r; },
    async saveApproval({ agreementId, approvedBy }) { t.approvals.push({ agreement_id: agreementId, approvedBy }); },
    async isApproved(a) { return t.approvals.some((x) => x.agreement_id === a); },
    async getAgreement(i) { return t.agreements.find((x) => x.id === i) ?? null; },
    async saveDecision(d) { const r = { id: id(), agreement_id: d.agreementId, payer_message: d.message, decision: d.decision.decision, code: d.decision.code, citations: d.decision.citations, reply: d.reply, trace: d.trace, draft: d.decision.draft ?? null, created_at: "now" }; t.decisions.push(r); return r; },
    async getDecision(i) { return t.decisions.find((x) => x.id === i) ?? null; },
    async listDecisions(a) { return t.decisions.filter((x) => x.agreement_id === a).map((x) => ({ ...x, changeOrderApproved: t.coa.includes(x.id) })); },
    async hasChangeOrderApproval(i) { return t.coa.includes(i); },
    async saveChangeOrderApproval(i) { if (t.coa.includes(i)) throw Object.assign(new Error("dup"), { duplicate: true }); t.coa.push(i); },
    async saveInvoices({ invoices, agreementId, decisionId, milestone, currency = "USD" }) { invoices.forEach((v, k) => t.invoices.push({ invoice_id: v.id, agreement_id: agreementId, decision_id: decisionId, milestone, installment_no: k + 1, amount: v.amount, currency, pay_url: v.payUrl })); },
    async countInvoices(a) { return t.invoices.filter((x) => x.agreement_id === a).length; },
    async listInvoices(a) { return t.invoices.filter((x) => x.agreement_id === a); },
    async listLedger(agreementId) {
      const mine = (l) => t.invoices.find((x) => x.invoice_id === l.invoice_id)?.agreement_id === agreementId;
      return t.ledger.filter(mine).reverse().map((l, i) => {
        const inv = t.invoices.find((x) => x.invoice_id === l.invoice_id); const d = inv && t.decisions.find((x) => x.id === inv.decision_id);
        return { id: i + 1, paid_at: l.paid_at, invoice_id: l.invoice_id, amount: l.amount, currency: "USD", milestone: inv?.milestone ?? null, installment_no: inv?.installment_no ?? null, installments_total: inv ? t.invoices.filter((x) => x.decision_id === inv.decision_id).length : null, decision_code: d?.code ?? null, payer_message: d?.payer_message ?? null, citations: d?.citations ?? null };
      });
    },
    usage: new Map(),
    async bumpUsage(kind, key, n, limit) { const k = `${kind}|${key}`; const cur = this.usage.get(k) ?? 0; if (cur + n > limit) return false; this.usage.set(k, cur + n); return true; },
    async ping() { return true; },
    addLedger(l) { t.ledger.push(l); },
  };
}
