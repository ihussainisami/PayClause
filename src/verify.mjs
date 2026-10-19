// Evidence verification for terms extracted from an agreement.
// The LLM only PROPOSES values (each with a verbatim quote). This code decides.
// No model "confidence" is trusted anywhere: status comes from checks below.

const norm = (s) =>
  String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const numbersIn = (text) => (String(text).match(NUMBER_RE) || []).map((n) => Number(n.replace(/,/g, "")));
const sameNumber = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Phrases that try to talk to the AI instead of describing a business deal.
export const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|terms)/i,
  /disregard (all |any |the )?(previous|prior|above|earlier|your) (instructions|rules|policy)/i,
  /\b(system|developer) prompt\b/i,
  /note to (automated|ai) (systems?|agents?|assistants?)/i,
  /(set|change|override) (the )?(total )?(fee|rent|amount|price|rate)[^.\n]{0,30}\bto\s+\$?0\b/i,
  /do not (flag|report|mention|tell)/i,
];

// "total fee ... $X" style statements, used to spot a contract that contradicts itself.
const FEE_STATEMENT_RE = /(total|project|contract)\s+(fee|price|amount|value)[^$\d]{0,40}(?:\$|usd\s?)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/gi;

const FIELDS = {
  total_fee: { type: "number", required: true },
  currency: { type: "text", required: true },
  net_days: { type: "number", required: true },
  late_fee_pct_per_month: { type: "number", required: false },
  extra_work_hourly_rate: { type: "number", required: false },
  scope_summary: { type: "summary", required: true }, // a summary: only its quote must exist
};

function checkEvidence(src, field) {
  if (!field.quote) return "missing evidence quote";
  if (!src.includes(norm(field.quote))) return "quote not found in contract";
  return null;
}

function checkValueInQuote(type, value, quote) {
  if (type === "number") {
    return numbersIn(quote).some((n) => sameNumber(n, value)) ? null : "value does not appear in its quote";
  }
  if (type === "text") {
    return norm(quote).includes(norm(value)) ? null : "value does not appear in its quote";
  }
  return null;
}

export function verifyExtraction(sourceText, extraction) {
  const src = norm(sourceText);
  const issues = [];
  const fields = {};
  const add = (code, message, extra = {}) => issues.push({ code, severity: "high", message, ...extra });

  for (const [name, spec] of Object.entries(FIELDS)) {
    const f = extraction?.[name];
    if (f == null || f.value == null) {
      if (spec.required) {
        fields[name] = { ok: false, reason: "missing" };
        add("MISSING_REQUIRED", `Required field "${name}" was not extracted`, { field: name });
      }
      continue;
    }
    const evidenceError = checkEvidence(src, f);
    if (evidenceError) {
      fields[name] = { ok: false, reason: evidenceError };
      add("EVIDENCE_NOT_FOUND", `${name}: ${evidenceError}`, { field: name, quote: f.quote });
      continue;
    }
    const valueError = checkValueInQuote(spec.type, f.value, f.quote);
    if (valueError) {
      fields[name] = { ok: false, reason: valueError };
      add("VALUE_NOT_IN_QUOTE", `${name}: ${valueError}`, { field: name, quote: f.quote, value: f.value });
      continue;
    }
    fields[name] = { ok: true, quote: f.quote };
  }

  // Milestones: each needs a real quote containing its amount; together they must add up.
  const milestones = Array.isArray(extraction?.milestones) ? extraction.milestones : [];
  let milestoneSum = 0;
  let milestonesOk = milestones.length > 0;
  milestones.forEach((m, i) => {
    const label = `milestones[${i}]`;
    const evidenceError = checkEvidence(src, m);
    const valueError = evidenceError ? null : checkValueInQuote("number", m.amount, m.quote);
    if (evidenceError || valueError) {
      milestonesOk = false;
      add(evidenceError ? "EVIDENCE_NOT_FOUND" : "VALUE_NOT_IN_QUOTE", `${label}: ${evidenceError || valueError}`, { field: label, quote: m.quote });
    }
    milestoneSum += Number(m.amount) || 0;
  });
  fields.milestones = { ok: milestonesOk };
  if (milestones.length === 0) add("MISSING_REQUIRED", 'Required field "milestones" was not extracted', { field: "milestones" });
  if (fields.total_fee?.ok && milestones.length > 0 && !sameNumber(milestoneSum, extraction.total_fee.value)) {
    add("MILESTONE_SUM_MISMATCH", `Milestones add up to ${milestoneSum}, but total fee is ${extraction.total_fee.value}`);
  }

  // The contract itself must not contradict itself about the total fee.
  const feeValues = new Map();
  for (const m of String(sourceText).matchAll(FEE_STATEMENT_RE)) {
    feeValues.set(Number(m[3].replace(/,/g, "")), m[0].trim());
  }
  if (feeValues.size > 1) {
    add("CONFLICTING_AMOUNTS", `Contract states different total fees: ${[...feeValues.keys()].join(", ")}`, { quotes: [...feeValues.values()] });
  }

  // Text that talks to the AI is never a contract term.
  for (const re of INJECTION_PATTERNS) {
    const m = String(sourceText).match(re);
    if (m) add("INJECTION_SUSPECTED", "Contract contains text addressed to an AI system", { quote: m[0] });
  }

  const status = issues.some((i) => i.severity === "high") ? "needs_review" : "verified";
  return { status, fields, issues };
}
