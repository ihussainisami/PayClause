// Turns an approved policy decision into real PayPal sandbox invoices. The ONLY way in is assertInvoiceAllowed.
import { assertInvoiceAllowed } from "./policy.mjs";

const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function buildInvoiceBody({ action, index, payerEmail, agreementId, today = new Date() }) {
  const item = action.schedule[index];
  const many = action.schedule.length > 1;
  return {
    detail: {
      currency_code: action.currency,
      note: `Agent decision cites the signed agreement. Ref ${agreementId}.`,
      invoice_date: addDays(today, 0),
      payment_term: { due_date: addDays(today, item.dueInDays) },
    },
    primary_recipients: [{ billing_info: { email_address: payerEmail } }],
    items: [{
      name: many ? `${action.milestone} (installment ${index + 1} of ${action.schedule.length})` : action.milestone,
      quantity: "1",
      unit_amount: { currency_code: action.currency, value: item.amount },
    }],
  };
}

// pp = the paypal.mjs request function (injected so tests never touch the network)
export async function createInvoicesFromDecision({ pp, policy, decision, payerEmail, agreementId, today }) {
  const action = assertInvoiceAllowed(policy, decision); // throws unless policy said allow on approved terms
  return createInvoicesFromAction({ pp, action, payerEmail, agreementId, today });
}

// Callers must get `action` from assertInvoiceAllowed or assertChangeOrderApproved, nowhere else.
export async function createInvoicesFromAction({ pp, action, payerEmail, agreementId, today }) {
  const created = [];
  for (let i = 0; i < action.schedule.length; i++) {
    const body = buildInvoiceBody({ action, index: i, payerEmail, agreementId, today });
    const c = await pp("/v2/invoicing/invoices", { method: "POST", body });
    if (c.status !== 201) throw new Error(`PayPal create invoice failed: HTTP ${c.status} ${JSON.stringify(c.data)}`);
    const id = String(c.data.href ?? "").split("/").pop();
    const s = await pp(`/v2/invoicing/invoices/${id}/send`, { method: "POST", body: { send_to_recipient: true, send_to_invoicer: false } });
    if (![200, 202].includes(s.status)) throw new Error(`PayPal send invoice failed: HTTP ${s.status} ${JSON.stringify(s.data)}`);
    const g = await pp(`/v2/invoicing/invoices/${id}`);
    created.push({ id, amount: action.schedule[i].amount, dueInDays: action.schedule[i].dueInDays, payUrl: g.data?.detail?.metadata?.recipient_view_url ?? null });
  }
  return created;
}
