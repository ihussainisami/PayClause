// Daily abuse caps for the public demo. Two counters per action: one per visitor (hashed IP) and one global.
// `bump(kind, key, n, limit)` must be atomic and return true only if the count stayed within the limit.
import { createHash } from "node:crypto";

export const DEFAULT_LIMITS = {
  model:   { perIp: 40, global: 400 }, // Gemini calls: custom agreements and payer messages
  invoice: { perIp: 12, global: 80 },  // real PayPal sandbox invoices
};

export class LimitError extends Error {
  constructor(message) { super(message); this.status = 429; }
}

export function makeLimiter({ bump, limits = DEFAULT_LIMITS, salt = "" }) {
  const who = (ip) => createHash("sha256").update(`${salt}|${ip || "unknown"}`).digest("hex").slice(0, 16);
  return {
    async take(kind, ip, n = 1) {
      const l = limits[kind];
      if (!l) throw new Error(`Unknown limit kind: ${kind}`);
      const word = kind === "invoice" ? "invoices" : "AI requests";
      if (!(await bump(kind, who(ip), n, l.perIp))) {
        throw new LimitError(`Demo limit reached: ${l.perIp} ${word} per visitor per day. Please come back tomorrow, or try the sample agreements.`);
      }
      if (!(await bump(kind, "all", n, l.global))) {
        throw new LimitError(`The public demo has reached its daily limit for ${word}. It resets every day (UTC).`);
      }
    },
  };
}

export const noLimiter = { take: async () => {} };
