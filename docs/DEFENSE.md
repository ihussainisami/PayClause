# Questions we expect, and straight answers

**Isn't "the model proposes, code decides" what everyone says?**
Yes, so that alone is not our claim. What we add: the policy itself is *derived from the signed agreement* (every number is a verified quote), it is rebuilt from the database on every request, and every answer cites the clause it used. The same engine also catches a trap contract before the agent ever works with it.

**What can the model actually do?**
Two things. Propose contract terms (which code then verifies against the text), and pick one label from a fixed list for a client message. It cannot approve a payment, change an amount, choose a recipient or write the reply.

**What if the client message contains a prompt injection?**
The message is wrapped and labelled as untrusted data, the model can only return a label from an enum, the label is sanitized, and a pattern scan flags instruction-like text. Even a fully "jailbroken" model could at most pick a different label, and the policy engine still applies the contract. Try *Run 6 attacks*.

**What if the contract itself contains an injection or contradicts itself?**
The verifier flags hidden instructions, numbers that conflict, milestones that do not add up to the total, and values the model could not quote. The result is *needs review*; the freelancer cannot approve it and the agent will not act.

**How do you stop a duplicate or forged payment record?**
The webhook calls PayPal's signature-verification API with the raw body, rejects anything unsigned, stores each event once, re-fetches the invoice and requires status `PAID`, and writes at most one ledger row per invoice. The ledger table is append-only (database trigger), and the browser key has no access to it.

**Can the same change order be invoiced twice?**
No. The approval row has the decision id as primary key and is written before PayPal is called. A double click gets a conflict. The amount is recomputed from the contract rate; the stored draft is never trusted.

**What if someone floods the demo?**
Per-visitor and global daily caps on AI calls and invoices (enforced atomically in the database), 20,000-character and 500-character input limits, and at most 6 invoices per agreement. Sample agreements do not use AI quota.

**What if Gemini is down?**
Retries, then fallback models. If it still fails, the request goes to the freelancer. It never falls through to *allow*.

**Is any of this faked?**
Gemini calls, Supabase storage, PayPal sandbox invoices and webhooks are real. The two sample agreements use pre-computed model extractions (their verification still runs live) so that the first click is instant and costs no quota. Paying an invoice uses PayPal sandbox accounts, not real funds. The offline preview (`npm run preview`) is a development tool and is not what the live site runs.

**What would you build next?**
Freelancer sign-in and notifications, per-agreement settings for the limits (extension days, extra hours), partial-payment support with per-transaction ledger rows, and more contract types.
