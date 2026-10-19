// The agent loop: payer message -> (LLM proposes a request type) -> code sanitizes -> policy decides -> templated reply + trace.
// The LLM never decides and never writes the reply. It only picks a label from a fixed list.
import { decide } from "./policy.mjs";
import { INJECTION_PATTERNS } from "./verify.mjs";

export const REQUEST_TYPES = [
  "pay_in_installments", "extend_due_date", "extra_work", "waive_late_fee",
  "ignore_contract", "reduce_total", "skip_payment", "pay_whenever", "unknown",
];

const posInt = (n) => (Number.isInteger(n) && n > 0 ? n : null);

// Whatever the model returned, only a well-formed request from the fixed list gets through.
export function sanitizeRequest(raw, policy) {
  const type = REQUEST_TYPES.includes(raw?.type) ? raw.type : "unknown";
  if (type === "pay_in_installments") {
    const installments = posInt(Number(raw.installments));
    let milestoneIndex = Number.isInteger(raw.milestoneIndex) ? raw.milestoneIndex : null;
    if (milestoneIndex === null && policy.milestones.length === 1) milestoneIndex = 0;
    if (installments === null || milestoneIndex === null || !policy.milestones[milestoneIndex]) return { type: "unknown" };
    return { type, milestoneIndex, installments };
  }
  if (type === "extend_due_date") {
    const days = posInt(Number(raw.days));
    return days === null ? { type: "unknown" } : { type, days };
  }
  if (type === "extra_work") {
    const h = Number(raw.estimatedHours);
    return { type, estimatedHours: Number.isFinite(h) && h > 0 ? h : 0 };
  }
  return { type };
}

function renderReply(decision) {
  const cites = decision.citations.map((c) =>
    c.source === "contract" ? `Contract: "${c.quote}"` : `Freelancer's limit: ${c.quote}`);
  return [decision.message, ...cites].join("\n");
}

export async function handleMessage({ policy, message, classify }) {
  const trace = [];
  const t = (step, detail) => trace.push({ step, ...detail });
  t("received", { actor: "payer", text: message });

  const injected = INJECTION_PATTERNS.some((re) => re.test(message));
  if (injected) t("flag", { actor: "code", note: "Message contains instructions aimed at an AI. It is treated as plain text and cannot change the rules." });

  let proposal;
  try { proposal = await classify(message, policy); } catch (e) {
    proposal = { type: "unknown" };
    t("error", { actor: "code", note: `Could not classify (${e.message}). Falling back to the freelancer.` });
  }
  t("proposed", { actor: "model", note: "The model only picks a request type. It cannot approve anything.", proposal });

  const request = sanitizeRequest(proposal, policy);
  t("sanitized", { actor: "code", request });

  const decision = decide(policy, request);
  t("decided", { actor: "policy", decision: decision.decision, code: decision.code, citations: decision.citations });

  const reply = renderReply(decision);
  t("reply", { actor: "agent", text: reply });
  return { request, decision, reply, trace };
}
