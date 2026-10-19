// Supabase Edge Function: PayPal webhook receiver for LeaseGuard AI (sandbox).
// Deploy with "Verify JWT" turned OFF (PayPal cannot send a Supabase JWT).
import { createClient } from "npm:@supabase/supabase-js@2";

const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("PAYPAL_CLIENT_SECRET");
const WEBHOOK_ID = Deno.env.get("PAYPAL_WEBHOOK_ID");
const db = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

const SIG_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
];

let cachedToken = null;
async function getToken() {
  if (cachedToken) return cachedToken;
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`token request failed: HTTP ${r.status}`);
  cachedToken = data.access_token;
  return cachedToken;
}

async function paypal(path, init = {}) {
  const res = await fetch(PAYPAL_BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// Raw body is embedded as-is: re-serialising parsed JSON could break the signature.
async function verifySignature(h, raw) {
  const body =
    `{"auth_algo":${JSON.stringify(h.get("paypal-auth-algo"))},` +
    `"cert_url":${JSON.stringify(h.get("paypal-cert-url"))},` +
    `"transmission_id":${JSON.stringify(h.get("paypal-transmission-id"))},` +
    `"transmission_sig":${JSON.stringify(h.get("paypal-transmission-sig"))},` +
    `"transmission_time":${JSON.stringify(h.get("paypal-transmission-time"))},` +
    `"webhook_id":${JSON.stringify(WEBHOOK_ID)},` +
    `"webhook_event":${raw}}`;
  const r = await paypal("/v1/notifications/verify-webhook-signature", { method: "POST", body });
  if (r.status !== 200) throw new Error(`verify call failed: HTTP ${r.status}`);
  return r.data?.verification_status === "SUCCESS";
}

// What a PAID-type event means is decided by the invoice itself (fetched from PayPal's API), never by the event text.
//  PAID                       -> real money, fully settled: credit the ledger once per invoice.
//  PARTIALLY_PAID             -> money arrived but the invoice is not settled: log it, credit nothing yet.
//                                (The final payment sends another event, and the ledger is credited then.)
//  PAYMENT_PENDING / SENT /
//  UNPAID / SCHEDULED         -> not confirmed yet (status can lag the event): fail so PayPal retries later.
//  anything else (MARKED_AS_PAID = owner clicked "mark paid", REFUNDED, CANCELLED, ...) -> never credited.
function classify(status) {
  if (status === "PAID") return "credit";
  if (status === "PARTIALLY_PAID") return "partial";
  if (["PAYMENT_PENDING", "SENT", "UNPAID", "SCHEDULED"].includes(status)) return "wait";
  return "ignore";
}

async function handleEvent(ev) {
  if (ev.event_type !== "INVOICING.INVOICE.PAID") return "logged only (not a PAID event)";
  const invoiceId = ev.resource?.invoice?.id ?? ev.resource?.id;
  if (!invoiceId) return "NOT credited: no invoice id in event";
  const got = await paypal(`/v2/invoicing/invoices/${invoiceId}`);
  if (got.status !== 200) throw new Error(`invoice ${invoiceId} lookup failed (HTTP ${got.status})`);
  const status = got.data?.status;
  const kind = classify(status);
  if (kind === "wait") throw new Error(`invoice ${invoiceId} not settled yet (status ${status}); PayPal will retry`);
  if (kind === "partial") return `logged only: invoice is PARTIALLY_PAID, not credited until fully paid`;
  if (kind === "ignore") return `NOT credited: invoice status is ${status}`;

  // One credit per invoice, even if PayPal sends several different PAID events for it.
  const prior = await db.from("ledger_entries").select("id").eq("invoice_id", invoiceId).limit(1);
  if (prior.error) throw new Error(`ledger lookup failed: ${prior.error.message}`);
  if (prior.data && prior.data.length > 0) return "already credited (invoice)";

  const paid = got.data.payments?.paid_amount;
  const { data, error } = await db
    .from("ledger_entries")
    .upsert(
      {
        event_id: ev.id,
        invoice_id: invoiceId,
        amount: paid?.value,
        currency: paid?.currency_code,
        source: "verified_webhook",
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    )
    .select();
  if (error) throw new Error(`ledger insert failed: ${error.message}`);
  return data && data.length > 0 ? "CREDITED" : "already credited";
}

const reply = (code, text) => new Response(text, { status: code });
const log = (...a) => console.log(...a);

Deno.serve(async (req) => {
  if (req.method === "GET") return reply(200, "ok");
  if (req.method !== "POST") return reply(405, "method not allowed");

  const raw = await req.text();
  if (SIG_HEADERS.some((k) => !req.headers.get(k))) {
    log("REJECTED: missing PayPal signature headers");
    return reply(400, "missing signature headers");
  }

  let ok;
  try {
    ok = await verifySignature(req.headers, raw);
  } catch (e) {
    log("verification error (PayPal will retry):", e.message);
    return reply(503, "verification unavailable");
  }
  if (!ok) {
    log("REJECTED: signature verification FAILED");
    return reply(400, "bad signature");
  }

  let ev;
  try { ev = JSON.parse(raw); } catch { return reply(400, "bad json"); }

  try {
    const ins = await db
      .from("webhook_events")
      .upsert(
        { event_id: ev.id, event_type: ev.event_type, payload: ev },
        { onConflict: "event_id", ignoreDuplicates: true },
      )
      .select();
    if (ins.error) throw new Error(`event insert failed: ${ins.error.message}`);
    const duplicate = !ins.data || ins.data.length === 0;
    const result = await handleEvent(ev);
    log(duplicate ? "DUPLICATE" : "VERIFIED", ev.event_type, ev.id, "->", result);
    return reply(200, duplicate ? "duplicate" : "ok");
  } catch (e) {
    log("handler error (PayPal will retry):", e.message);
    return reply(500, "handler error");
  }
});
