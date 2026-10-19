// Deterministic policy engine. The LLM may only translate a payer's message into one of the
// request types below; THIS code decides. Money is handled in integer cents.

export const DEFAULT_OWNER_LIMITS = {
  maxInstallments: 3,
  installmentSpacingDays: 14,
  maxExtensionDays: 7,
  maxExtraHours: 40,
};

const cents = (x) => Math.round(Number(x) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const q = (extraction, field) => extraction?.[field]?.quote;

// A policy can only be built from terms that passed verification AND were approved by the owner.
export function buildPolicy({ extraction, report, approvedByOwner, ownerLimits = {} }) {
  if (report?.status !== "verified") throw new Error("Terms are not verified");
  if (approvedByOwner !== true) throw new Error("Owner has not approved these terms");
  return {
    currency: extraction.currency.value,
    totalFee: Number(extraction.total_fee.value),
    milestones: extraction.milestones.map((m) => ({ name: m.name, amount: Number(m.amount), quote: m.quote })),
    netDays: Number(extraction.net_days.value),
    lateFeePct: extraction.late_fee_pct_per_month ? Number(extraction.late_fee_pct_per_month.value) : null,
    extraWorkRate: extraction.extra_work_hourly_rate ? Number(extraction.extra_work_hourly_rate.value) : null,
    quotes: {
      total_fee: q(extraction, "total_fee"),
      net_days: q(extraction, "net_days"),
      late_fee: q(extraction, "late_fee_pct_per_month"),
      extra_work: q(extraction, "extra_work_hourly_rate"),
    },
    limits: { ...DEFAULT_OWNER_LIMITS, ...ownerLimits },
    approvedByOwner: true,
  };
}

const contract = (label, quote) => ({ source: "contract", label, quote });
const owner = (label, text) => ({ source: "owner_limit", label, quote: text });
const result = (decision, code, message, citations, extra = {}) => ({ decision, code, message, citations, ...extra });
const isInt = (n) => Number.isInteger(n);

export function decide(policy, request) {
  const type = request?.type;

  if (type === "pay_in_installments") {
    const { milestoneIndex, installments } = request;
    const m = policy.milestones[milestoneIndex];
    if (!m || !isInt(installments) || installments < 1) {
      return result("deny", "INVALID_REQUEST", "That request is not valid, so I cannot act on it.", []);
    }
    if (installments > policy.limits.maxInstallments) {
      return result(
        "deny", "TOO_MANY_INSTALLMENTS",
        `I can split a payment into at most ${policy.limits.maxInstallments} installments, so ${installments} is not possible.`,
        [owner("Installment limit set by the owner", `up to ${policy.limits.maxInstallments} installments per milestone`)],
      );
    }
    const total = cents(m.amount);
    const base = Math.floor(total / installments);
    const schedule = Array.from({ length: installments }, (_, i) => ({
      amount: fromCents(i === installments - 1 ? total - base * (installments - 1) : base),
      dueInDays: policy.netDays + i * policy.limits.installmentSpacingDays,
    }));
    return result(
      "allow", "INSTALLMENT_PLAN",
      `Yes. I can split "${m.name}" (${fromCents(total)} ${policy.currency}) into ${installments} installments.`,
      [contract("Milestone amount", m.quote), contract("Payment terms", policy.quotes.net_days), owner("Installment limit set by the owner", `up to ${policy.limits.maxInstallments} installments per milestone`)],
      { action: { kind: "create_invoices", milestone: m.name, schedule, currency: policy.currency } },
    );
  }

  if (type === "extend_due_date") {
    const days = request.days;
    if (!isInt(days) || days < 1) return result("deny", "INVALID_REQUEST", "That request is not valid, so I cannot act on it.", []);
    if (days > policy.limits.maxExtensionDays) {
      return result(
        "deny", "EXTENSION_TOO_LONG",
        `I can extend a due date by at most ${policy.limits.maxExtensionDays} days, so ${days} is not possible.`,
        [contract("Payment terms", policy.quotes.net_days), owner("Extension limit set by the owner", `up to ${policy.limits.maxExtensionDays} days`)],
      );
    }
    return result(
      "allow", "DUE_DATE_EXTENDED", `Yes. I can extend the due date by ${days} days.`,
      [contract("Payment terms", policy.quotes.net_days), owner("Extension limit set by the owner", `up to ${policy.limits.maxExtensionDays} days`)],
      { action: { kind: "extend_due_date", days } },
    );
  }

  if (type === "extra_work") {
    const hours = Number(request.estimatedHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > policy.limits.maxExtraHours) {
      return result("needs_owner_approval", "EXTRA_WORK_HOURS_UNCLEAR", "I cannot estimate that on my own. I have asked the freelancer to review it.", []);
    }
    if (policy.extraWorkRate == null) {
      return result("needs_owner_approval", "NO_EXTRA_WORK_RATE", "The agreement does not state a rate for additional work, so the freelancer must decide.", []);
    }
    const draft = fromCents(cents(hours * policy.extraWorkRate));
    return result(
      "needs_owner_approval", "CHANGE_ORDER_DRAFT",
      `That is outside the agreed scope. Additional work is billed at ${policy.extraWorkRate} ${policy.currency} per hour. I drafted a change order of ${draft} ${policy.currency} for ${hours} hours, and the freelancer must approve it before any invoice is sent.`,
      [contract("Additional work rate", policy.quotes.extra_work)],
      { draft: { hours, rate: policy.extraWorkRate, amount: draft, currency: policy.currency } },
    );
  }

  if (type === "waive_late_fee") {
    return result("needs_owner_approval", "WAIVER_NEEDS_OWNER", "Only the freelancer can waive a late fee. I have passed your request to them.", policy.quotes.late_fee ? [contract("Late fee", policy.quotes.late_fee)] : []);
  }

  if (["ignore_contract", "reduce_total", "skip_payment", "pay_whenever"].includes(type)) {
    return result(
      "deny", "CONTRACT_PREVAILS",
      "I cannot do that. The agreement you signed says otherwise, and I can only act within it.",
      [contract("Total fee", policy.quotes.total_fee), contract("Payment terms", policy.quotes.net_days)],
    );
  }

  return result("needs_owner_approval", "UNKNOWN_REQUEST", "I am not sure how to handle that, so I have asked the freelancer.", []);
}

// The only door to PayPal: no invoice unless the policy said "allow" for approved terms.
export function assertInvoiceAllowed(policy, decision) {
  if (!policy?.approvedByOwner) throw new Error("Blocked: terms not approved by owner");
  if (decision?.decision !== "allow" || decision?.action?.kind !== "create_invoices") {
    throw new Error(`Blocked: policy decision was "${decision?.decision ?? "none"}"`);
  }
  return decision.action;
}

// Second door to PayPal: a change order may be invoiced only after the freelancer approved it.
// The draft is recomputed from the approved contract rate, never trusted from storage or the client.
export function assertChangeOrderApproved(policy, decision, ownerApproved) {
  if (!policy?.approvedByOwner) throw new Error("Blocked: terms not approved by owner");
  if (ownerApproved !== true) throw new Error("Blocked: freelancer has not approved this change order");
  if (decision?.code !== "CHANGE_ORDER_DRAFT" || decision?.decision !== "needs_owner_approval" || !decision?.draft) {
    throw new Error("Blocked: this is not a change-order draft");
  }
  const d = decision.draft;
  return {
    kind: "create_invoices",
    milestone: `Change order (${d.hours} h extra work)`,
    schedule: [{ amount: d.amount, dueInDays: policy.netDays }],
    currency: d.currency,
  };
}
