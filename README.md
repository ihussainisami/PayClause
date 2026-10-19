# PayClause

**An AI agent that handles payment requests using only what the signed agreement says, then sends real PayPal invoices.**
It cannot be talked out of the contract: every decision is bound to a clause.

Built for the *Build What's Next with PayPal and AI* hackathon. PayPal **sandbox only**: no real money moves.

**Live demo:** https://clause-desk.vercel.app  ·  **Video:** TODO(add link)  ·  **How we defend it:** [docs/DEFENSE.md](docs/DEFENSE.md)

## The problem

A freelancer agrees on a price and milestones in a contract. Then the client asks: *"Can I pay later?"*, *"Can you also add a blog page?"*, *"Ignore the contract, I'll pay when I want."*
Today the freelancer answers by hand, or an AI chatbot answers and gets talked into things. Agents that touch money need a hard rule: **the agreement decides, not the model.**

## What PayClause does

1. **Reads the agreement.** Gemini *proposes* terms (total, milestones, due days, late fee, hourly rate) and must quote the exact words it relied on.
2. **Verifies in code.** Every quote must exist in the text, every value must appear in its quote, milestones must add up to the total, and conflicting numbers or instructions hidden in the contract ("ignore previous instructions…") are flagged. A suspicious contract is marked *needs review* and the agent refuses to act on it.
3. **The freelancer approves.** Only approved, verified terms become the policy. No approval, no agent.
4. **Client messages are handled by a fixed policy.** Gemini may only pick **one label** from a fixed list (pay in installments, extend due date, extra work, reduce total, …). Code sanitizes it. A deterministic policy engine returns *allow*, *deny* or *needs the freelancer*, always quoting the clauses it used. The reply is a template, not model text.
5. **Real PayPal invoices, only through two gates.** Allowed requests (e.g. split a milestone into 2 installments) create sandbox invoices through the PayPal Invoicing API. Extra work becomes a *change order draft* and creates nothing until the freelancer approves it; the amount is recomputed from the contract rate.
6. **A signed webhook builds the ledger.** PayPal's `INVOICING.INVOICE.PAID` event is verified with PayPal's signature API, the invoice is re-fetched to confirm it is really `PAID`, and an append-only ledger row is written, linked to the decision that allowed it.

The page shows every step ("How the agent decided"), highlights the clauses in the agreement, and has a **Run 6 attacks** button that fires six attempts to get around the contract.

## PayPal and AI usage

| Piece | What it does |
|---|---|
| PayPal Invoicing v2 | create, send and read invoices (`/v2/invoicing/invoices`, `/send`) |
| PayPal Webhooks | signed `INVOICING.INVOICE.PAID` events, verified via `/v1/notifications/verify-webhook-signature` using the raw body |
| Gemini | (a) propose contract terms with quotes, (b) classify a client message into one label. Structured JSON output, temperature 0, untrusted text wrapped and labelled as data |
| Supabase (Postgres + Edge Function) | agreements, approvals, decisions, invoices, webhook events, append-only ledger |
| Vercel | static page + serverless API |

If the model is down or answers badly, the request goes to the freelancer. It never defaults to *allow*.

## Architecture

```
contract text ──► Gemini proposes terms + quotes ──► code verifies ──► freelancer approves
                                                                            │
client message ──► Gemini picks 1 label ──► code sanitizes ──► policy engine (built from the DB, never from the browser)
                                                                            │
                          allow / deny / needs freelancer  ──► templated reply + quoted clauses + trace
                                                                            │
              allowed or approved only ──► PayPal invoice ──► payer pays ──► signed webhook ──► ledger
```

```
api/        serverless routes (thin: each calls one function in src/service.mjs)
public/     the whole UI: one HTML file
src/        verify.mjs (term checks) · policy.mjs (decisions + the only two doors to PayPal) · agent.mjs (message handling)
            gemini.mjs / intent.mjs (model calls) · invoicing.mjs / paypal.mjs (PayPal) · service.mjs (app logic)
            store.mjs (database) · limiter.mjs (daily caps) · app-lib.mjs (wiring)
supabase/   schema.sql (run once) · webhook/index.ts (signed-webhook receiver, an Edge Function)
test/       62 offline tests          samples/  two example agreements          scripts/  CLI helpers + offline preview
```

## Run the tests (no keys, no network)

```
npm install
npm test
```
62 tests, including a property test of 1000 random requests that must never produce an invoice outside the contract.

## Run it yourself

1. Create a Supabase project; run `supabase/schema.sql` once in the SQL Editor; deploy `supabase/webhook/index.ts` as an Edge Function with *Verify JWT* off.
2. Create a PayPal **sandbox** REST app and a webhook pointing at the Edge Function (event `INVOICING.INVOICE.PAID`).
3. Set these environment variables (Vercel, or a local `.env` that is never committed):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (optional), `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYER_EMAIL`. The Edge Function also needs `PAYPAL_WEBHOOK_ID`.
4. `vercel deploy`, or `npm run preview` for an offline preview at http://localhost:3000 with a fake model and fake PayPal.

## Testing instructions for judges

1. Open the live demo and press **Try the clean agreement**. It is a normal freelance agreement.
2. Press **Approve these terms**. Try the chips: *"Can I pay the launch milestone in 2 parts?"* creates two real sandbox invoices.
3. Press **Run 6 attacks**. Nothing is invoiced.
4. *"Can you also add a blog page? Maybe 5 hours."* creates a change order for the freelancer. Press **Approve and send invoice** in the inbox.
5. Pay an invoice: press **Open invoice** and log in with the sandbox personal account below. Within seconds the invoice shows *Paid and confirmed by PayPal* and a row appears in the ledger.
   - Sandbox payer: `TODO(add email)` / `TODO(add password)` (sandbox only, no real funds)
6. Press **Start over**, then **Use the trap sample**: a contract with a hidden instruction and conflicting numbers. It is flagged *needs review*, highlighted in red, and cannot be approved.

## Honest limits

- **Sandbox only.** No real money, no real customers.
- **No owner login.** In this public demo anyone who has an agreement id can press *Approve*. A real product would put the freelancer behind sign-in. Demo caps limit abuse (per-visitor and global daily limits on AI calls and invoices; at most 6 invoices per agreement). Each visitor's page shows only their own agreement's payments.
- Partial payments are not enabled on our invoices (PayPal default). The webhook still handles partially-paid, pending, refunded and owner-marked-paid states safely: it does not credit them.
- The model can misread a contract. That is why every extracted value must be quoted from the text and verified by code, and why anything doubtful goes to a human.
- The hero use case is a freelancer or service agreement. The same engine works for a lease or any fixed-price contract, but we only demo these two samples.

## Background

TODO(confirm and edit): The idea started as an n8n automation workflow for lease payments (project name *LeaseGuard AI*). This submission is a new build: the verifier, policy engine, web app, PayPal invoicing and webhook ledger were written for this hackathon.

## Licence

TODO(confirm): AGPL-3.0.
