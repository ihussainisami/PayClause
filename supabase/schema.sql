-- PayClause database: run this whole file once in Supabase > SQL Editor on a new project.
-- (Safe to run again: it only creates what is missing.)

-- ===== 1. webhook events + append-only ledger =====
-- LeaseGuard AI: webhook events + ledger (run once in Supabase > SQL Editor)

create table if not exists public.webhook_events (
  event_id    text primary key,
  event_type  text not null,
  received_at timestamptz not null default now(),
  payload     jsonb not null
);

create table if not exists public.ledger_entries (
  id         bigint generated always as identity primary key,
  event_id   text not null unique references public.webhook_events(event_id),
  invoice_id text not null,
  amount     numeric(12,2) not null,
  currency   text not null,
  source     text not null default 'verified_webhook',
  created_at timestamptz not null default now()
);

-- Append-only: nobody (not even the server key) can update or delete rows.
create or replace function public.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

drop trigger if exists ledger_append_only on public.ledger_entries;
create trigger ledger_append_only before update or delete on public.ledger_entries
  for each row execute function public.forbid_change();

drop trigger if exists events_append_only on public.webhook_events;
create trigger events_append_only before update or delete on public.webhook_events
  for each row execute function public.forbid_change();

-- Lock the tables from the browser/anon key. With RLS on and no policies,
-- only the server's service-role key can read or write them.
alter table public.webhook_events enable row level security;
alter table public.ledger_entries enable row level security;

-- ===== 2. agreements, approvals, decisions, invoices, ledger_view =====
-- Agreement-to-Payment agent: agreements, approvals, decisions, invoices (run once in Supabase > SQL Editor)

create table if not exists public.agreements (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  source_text text not null,
  extraction  jsonb not null,
  status      text not null check (status in ('verified','needs_review')),
  issues      jsonb not null default '[]'
);

-- Owner approval is its own append-only record (who/when), not a flag that can be flipped.
create table if not exists public.approvals (
  id           bigint generated always as identity primary key,
  agreement_id uuid not null references public.agreements(id),
  approved_by  text not null,
  created_at   timestamptz not null default now()
);

create table if not exists public.decisions (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  agreement_id  uuid not null references public.agreements(id),
  payer_message text not null,
  request       jsonb not null,
  decision      text not null check (decision in ('allow','deny','needs_owner_approval')),
  code          text not null,
  citations     jsonb not null default '[]',
  reply         text not null,
  trace         jsonb not null
);

create table if not exists public.invoices (
  invoice_id         text primary key,
  created_at         timestamptz not null default now(),
  agreement_id       uuid not null references public.agreements(id),
  decision_id        uuid not null references public.decisions(id),
  milestone          text not null,
  installment_no     int  not null,
  installments_total int  not null,
  amount             numeric(12,2) not null,
  currency           text not null,
  pay_url            text
);

-- Everything here is append-only, like the ledger.
do $$
declare t text;
begin
  foreach t in array array['agreements','approvals','decisions','invoices'] loop
    execute format('drop trigger if exists %I_append_only on public.%I', t, t);
    execute format('create trigger %I_append_only before update or delete on public.%I for each row execute function public.forbid_change()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

-- One readable row per payment: what was paid, which clause-backed decision allowed it.
create or replace view public.ledger_view with (security_invoker = true) as
select l.id, l.created_at as paid_at, l.invoice_id, l.amount, l.currency,
       i.milestone, i.installment_no, i.installments_total,
       d.code as decision_code, d.payer_message, d.citations,
       i.agreement_id
from public.ledger_entries l
left join public.invoices i on i.invoice_id = l.invoice_id
left join public.decisions d on d.id = i.decision_id;
revoke all on public.ledger_view from anon, authenticated;
grant select on public.ledger_view to service_role;

-- ===== 3. change orders =====
-- Step 3: change orders + draft/action columns (run once in Supabase > SQL Editor, after schema2.sql)
alter table public.decisions add column if not exists draft  jsonb;
alter table public.decisions add column if not exists action jsonb;

-- One approval per change order. The primary key makes a double click impossible to invoice twice.
create table if not exists public.change_order_approvals (
  decision_id uuid primary key references public.decisions(id),
  created_at  timestamptz not null default now()
);
drop trigger if exists change_order_approvals_append_only on public.change_order_approvals;
create trigger change_order_approvals_append_only before update or delete on public.change_order_approvals
  for each row execute function public.forbid_change();
alter table public.change_order_approvals enable row level security;
revoke all on public.change_order_approvals from anon, authenticated;
grant select, insert on public.change_order_approvals to service_role;

-- ===== 4. daily demo limits =====
-- Daily abuse caps for the public demo. Run once in the Supabase SQL Editor.
create table if not exists usage_counters (
  day  date not null default current_date,
  kind text not null,
  key  text not null,
  n    int  not null default 0,
  primary key (day, kind, key)
);
alter table usage_counters enable row level security;
revoke all on usage_counters from anon, authenticated;
grant select, insert, update, delete on usage_counters to service_role;

-- Atomic: adds p_n only if the total stays within p_limit. Returns true if allowed.
create or replace function bump_usage(p_kind text, p_key text, p_n int, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  delete from usage_counters where day < current_date - 7;
  insert into usage_counters (day, kind, key, n) values (current_date, p_kind, p_key, 0) on conflict do nothing;
  update usage_counters set n = n + p_n
   where day = current_date and kind = p_kind and key = p_key and n + p_n <= p_limit
   returning n into cur;
  return cur is not null;
end $$;
revoke all on function bump_usage(text, text, int, int) from public, anon, authenticated;
grant execute on function bump_usage(text, text, int, int) to service_role;
