// Shared wiring for the API routes. Secrets come from Vercel environment variables, never from code.
import { createClient } from "@supabase/supabase-js";
import { createService, ServiceError } from "./service.mjs";
import { makeStore } from "./store.mjs";
import { extractWithFallback } from "./gemini.mjs";
import { makeClassifier } from "./intent.mjs";
import { makeLimiter } from "./limiter.mjs";

let svc;
export async function getService() {
  if (svc) return svc;
  const env = process.env;
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "PAYER_EMAIL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) {
    if (!env[k]) throw new ServiceError(503, `Server is not configured (${k} missing).`);
  }
  const { pp } = await import("./paypal.mjs");
  const models = (env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
  const store = makeStore(createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));
  svc = createService({
    store,
    limiter: makeLimiter({ bump: store.bumpUsage, salt: env.IP_HASH_SALT || env.SUPABASE_SERVICE_ROLE_KEY.slice(-12) }),
    extract: async (text) => (await extractWithFallback(text, { apiKey: env.GEMINI_API_KEY, models })).extraction,
    classify: makeClassifier({ apiKey: env.GEMINI_API_KEY, models }),
    pp,
    payerEmail: env.PAYER_EMAIL,
  });
  return svc;
}

export const route = (method, fn) => async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== method) return res.status(405).json({ error: "Method not allowed." });
  try {
    const ip = String(req.headers?.["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
    res.status(200).json(await fn(await getService(), req, { ip }));
  } catch (e) {
    if (e instanceof ServiceError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    const busy = e?.status === 429 || e?.status >= 500 || /Gemini/.test(e?.message ?? "");
    res.status(busy ? 502 : 500).json({ error: busy ? "The AI service is busy. Try again in a few seconds." : "Something went wrong on the server. Try again." });
  }
};
