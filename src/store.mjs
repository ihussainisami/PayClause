// Saves every step to Supabase so the ledger can say WHY a payment exists. `db` is a supabase-js client (injected for tests).
const one = async (q) => { const { data, error } = await q.select().single(); if (error) throw new Error(error.message); return data; };

export async function saveAgreement(db, { sourceText, extraction, report }) {
  return one(db.from("agreements").insert({ source_text: sourceText, extraction, status: report.status, issues: report.issues }));
}
export async function saveApproval(db, { agreementId, approvedBy }) {
  return one(db.from("approvals").insert({ agreement_id: agreementId, approved_by: approvedBy }));
}
export async function saveDecision(db, { agreementId, message, request, decision, reply, trace }) {
  return one(db.from("decisions").insert({
    agreement_id: agreementId, payer_message: message, request,
    decision: decision.decision, code: decision.code, citations: decision.citations, reply, trace,
    draft: decision.draft ?? null, action: decision.action ?? null,
  }));
}
export async function saveInvoices(db, { agreementId, decisionId, milestone, currency, invoices }) {
  const rows = invoices.map((inv, i) => ({
    invoice_id: inv.id, agreement_id: agreementId, decision_id: decisionId, milestone,
    installment_no: i + 1, installments_total: invoices.length, amount: inv.amount, currency, pay_url: inv.payUrl,
  }));
  const { data, error } = await db.from("invoices").insert(rows).select();
  if (error) throw new Error(error.message);
  return data;
}
// Trust only the database: an agreement is approved only if an approval row exists.
export async function isApproved(db, agreementId) {
  const { data, error } = await db.from("approvals").select("id").eq("agreement_id", agreementId).limit(1);
  if (error) throw new Error(error.message);
  return data.length > 0;
}

// ---- reads and the object the service layer uses ----
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // ids come from the browser: never pass junk to Postgres

export function makeStore(db) {
  return {
    saveAgreement: (a) => saveAgreement(db, a),
    saveApproval: (a) => saveApproval(db, a),
    saveDecision: (d) => saveDecision(db, d),
    saveInvoices: (i) => saveInvoices(db, i),
    isApproved: (id) => isApproved(db, id),
    async getAgreement(id) { if (!UUID.test(String(id))) return null; return must(await db.from("agreements").select("*").eq("id", id).maybeSingle()); },
    async getDecision(id) { if (!UUID.test(String(id))) return null; return must(await db.from("decisions").select("*").eq("id", id).maybeSingle()); },
    async listDecisions(agreementId) {
      const rows = must(await db.from("decisions").select("*").eq("agreement_id", agreementId).order("created_at", { ascending: false }).limit(30));
      const ids = rows.map((r) => r.id);
      const apps = ids.length ? must(await db.from("change_order_approvals").select("decision_id").in("decision_id", ids)) : [];
      const done = new Set(apps.map((a) => a.decision_id));
      return rows.map((r) => ({ ...r, changeOrderApproved: done.has(r.id) }));
    },
    async hasChangeOrderApproval(decisionId) {
      return must(await db.from("change_order_approvals").select("decision_id").eq("decision_id", decisionId).limit(1)).length > 0;
    },
    async saveChangeOrderApproval(decisionId) {
      const { error } = await db.from("change_order_approvals").insert({ decision_id: decisionId });
      if (error) throw Object.assign(new Error(error.message), { duplicate: error.code === "23505" });
    },
    async countInvoices(agreementId) {
      const { count, error } = await db.from("invoices").select("invoice_id", { count: "exact", head: true }).eq("agreement_id", agreementId);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async listInvoices(agreementId) {
      return must(await db.from("invoices").select("*").eq("agreement_id", agreementId).order("created_at", { ascending: false }));
    },
    async bumpUsage(kind, key, n, limit) {
      const { data, error } = await db.rpc("bump_usage", { p_kind: kind, p_key: key, p_n: n, p_limit: limit });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async ping() {
      const { error } = await db.from("agreements").select("id").limit(1);
      if (error) throw new Error(error.message);
      return true;
    },
    async listLedger(agreementId) {
      if (!UUID.test(String(agreementId))) return []; // each visitor sees only their own agreement's payments
      return must(await db.from("ledger_view").select("*").eq("agreement_id", agreementId).order("id", { ascending: false }).limit(30));
    },
  };
}
