// OFFLINE PREVIEW of the whole UI. No keys, no network: fake model, fake PayPal, in-memory database.
// node dev-mock.mjs   then open http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import { createService, ServiceError } from "../src/service.mjs";
import { memoryStore } from "../src/memory-store.mjs";
import { SAMPLES } from "../src/samples-data.mjs";

const store = memoryStore(); let seq = 0;
const guess = (m) => {
  const t = m.toLowerCase();
  if (/(ignore|pay when|whenever|previous instructions)/.test(t) && !/\$0|total/.test(t)) return { type: "pay_whenever" };
  if (/(total|price|cut|reduce|\$0)/.test(t)) return { type: "reduce_total" };
  if (/(blog|add|extra|also)/.test(t)) return { type: "extra_work", estimatedHours: Number((t.match(/(\d+)\s*h/) || [])[1] || 5) };
  if (/(day|extend|extension)/.test(t)) return { type: "extend_due_date", days: Number((t.match(/(\d+)/) || [])[1] || 3) };
  if (/(part|install|split)/.test(t)) return { type: "pay_in_installments", installments: Number((t.match(/(\d+)\s*part/) || [])[1] || 2), milestoneIndex: 2 };
  return { type: "unknown" };
};
const pp = async (path, o = {}) => {
  if (path === "/v2/invoicing/invoices" && o.method === "POST") return { status: 201, data: { href: `https://x/INV2-MOCK-${String(++seq).padStart(4, "0")}` } };
  if (path.endsWith("/send")) return { status: 202, data: {} };
  return { status: 200, data: { detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#MOCK" } } } };
};
const svc = createService({ store, extract: async () => SAMPLES.clean.extraction, classify: async (m) => guess(m), pp, payerEmail: "client@example.com" });

const routes = {
  "GET /api/samples": () => svc.samples(),
  "POST /api/agreements": (q, b) => svc.submitAgreement(b),
  "GET /api/agreement": (q) => svc.state(q.get("id")),
  "POST /api/approve": (q, b) => svc.approveAgreement(b.id),
  "POST /api/message": (q, b) => svc.payerMessage(b.id, b.message),
  "POST /api/change-order": (q, b) => svc.approveChangeOrder(b.decisionId),
  "GET /api/ledger": (q) => svc.ledger(q.get("id")),
  "POST /dev/pay": (q, b) => { store.addLedger({ invoice_id: b.invoice_id, amount: b.amount, paid_at: new Date().toISOString() }); return { ok: true }; },
};
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const h = routes[`${req.method} ${url.pathname}`];
  if (h) {
    let raw = ""; for await (const c of req) raw += c;
    try { return send(200, await h(url.searchParams, raw ? JSON.parse(raw) : {})); }
    catch (e) { return send(e instanceof ServiceError ? e.status : 500, { error: e.message }); }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(fs.readFileSync(new URL("../public/index.html", import.meta.url))); }
  res.writeHead(404); res.end("not found");
}).listen(3000, () => console.log("OFFLINE PREVIEW (fake model, fake PayPal) at http://localhost:3000"));
