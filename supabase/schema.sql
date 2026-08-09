-- =============================================================================
-- Stock Asset Management — Supabase schema
-- =============================================================================
-- HOW TO RUN:
--   1. Open your Supabase project → SQL Editor → New query
--   2. Paste this entire file and click "Run"
--   3. Re-running is safe (uses IF NOT EXISTS / CREATE OR REPLACE)
--
-- SECURITY MODEL:
--   Row Level Security is ENABLED on every table with NO public policies, so the
--   anon/public key cannot read or write anything. The app talks to these tables
--   only from the server using the SERVICE ROLE key, which bypasses RLS. Never
--   expose the service role key to the browser.
-- =============================================================================

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- -----------------------------------------------------------------------------
-- Helper: Indian financial year label for a date (1 Apr -> 31 Mar).
--   2024-08-01 -> '2024-25'      2025-02-01 -> '2024-25'
-- -----------------------------------------------------------------------------
create or replace function fin_year(d date)
returns text
language sql
immutable
as $$
  select case
    when extract(month from d) >= 4
      then extract(year from d)::int || '-' || lpad(((extract(year from d)::int + 1) % 100)::text, 2, '0')
    else (extract(year from d)::int - 1) || '-' || lpad((extract(year from d)::int % 100)::text, 2, '0')
  end;
$$;

-- -----------------------------------------------------------------------------
-- contract_notes — one row per contract note PDF
-- -----------------------------------------------------------------------------
create table if not exists contract_notes (
  id                            uuid primary key default gen_random_uuid(),
  broker_name                   text,
  broker_sebi_regn              text,
  contract_note_number          text,
  trade_date                    date,
  settlement_date               date,
  settlement_number             text,
  client_name                   text,
  client_code                   text,
  pan                           text,
  exchange                      text,
  currency                      text default 'INR',

  -- charge breakdown (rolled up from the note)
  brokerage                     numeric(18,4),
  exchange_transaction_charges  numeric(18,4),
  clearing_charges              numeric(18,4),
  sebi_turnover_fees            numeric(18,4),
  stt                           numeric(18,4),
  stamp_duty                    numeric(18,4),
  ipft                          numeric(18,4),
  gst                           numeric(18,4),
  cgst                          numeric(18,4),
  sgst                          numeric(18,4),
  igst                          numeric(18,4),
  demat_charges                 numeric(18,4),
  rounding                      numeric(18,4),
  other_charges                 numeric(18,4),
  total_charges                 numeric(18,4),

  net_amount                    numeric(18,4),
  net_amount_direction          text check (net_amount_direction in ('PAYABLE','RECEIVABLE')),

  source_filename               text,
  raw_json                      jsonb,          -- full extracted payload, for audit
  created_at                    timestamptz not null default now(),

  -- de-dupe: the same note should not be imported twice
  constraint contract_notes_unique unique (broker_name, contract_note_number, trade_date)
);

-- -----------------------------------------------------------------------------
-- trades — one row per trade line on a contract note
-- -----------------------------------------------------------------------------
create table if not exists trades (
  id                 uuid primary key default gen_random_uuid(),
  contract_note_id   uuid references contract_notes(id) on delete cascade,
  trade_date         date not null,
  security_name      text,
  symbol             text,           -- may be scrip code (e.g. 533148) for this broker
  isin               text,           -- reliable cross-broker key
  exchange           text,
  segment            text,
  side               text not null check (side in ('BUY','SELL')),
  quantity           numeric(18,4) not null,   -- always positive; direction is in `side`
  gross_rate         numeric(18,6),
  net_rate           numeric(18,6),
  gross_value        numeric(18,4),
  net_value          numeric(18,4),
  order_no           text,
  trade_no           text,
  trade_time         text,
  created_at         timestamptz not null default now()
);

create index if not exists trades_isin_idx        on trades(isin);
create index if not exists trades_trade_date_idx   on trades(trade_date);
create index if not exists trades_note_idx         on trades(contract_note_id);

-- -----------------------------------------------------------------------------
-- corporate_actions — splits, bonuses, etc. (manual entry or auto-fetched)
--   quantity_multiplier: new qty = old qty * multiplier (cost basis preserved).
--     2-for-1 split  -> 2.0      1:1 bonus (1 new per 1 held) -> 2.0
--     5:1 split (face 10->2)     -> 5.0      3:2 bonus         -> 2.5
-- -----------------------------------------------------------------------------
create table if not exists corporate_actions (
  id                   uuid primary key default gen_random_uuid(),
  isin                 text not null,
  symbol               text,
  security_name        text,
  action_type          text not null check (action_type in ('SPLIT','BONUS','MERGER','OTHER')),
  ex_date              date not null,
  quantity_multiplier  numeric(18,6) not null,
  ratio_text           text,           -- human label, e.g. "1:1 bonus", "5-for-1 split"
  notes                text,
  source               text not null default 'manual' check (source in ('manual','auto')),
  created_at           timestamptz not null default now(),
  constraint corporate_actions_unique unique (isin, action_type, ex_date)
);

create index if not exists corp_actions_isin_idx on corporate_actions(isin);

-- -----------------------------------------------------------------------------
-- dividends — dividend receipts (manual entry or auto-fetched)
-- -----------------------------------------------------------------------------
create table if not exists dividends (
  id                 uuid primary key default gen_random_uuid(),
  isin               text not null,
  symbol             text,
  security_name      text,
  ex_date            date,
  pay_date           date,
  amount_per_share   numeric(18,6),
  quantity           numeric(18,4),   -- shares held on record date
  gross_amount       numeric(18,4),
  tds                numeric(18,4) default 0,
  net_amount         numeric(18,4),
  source             text not null default 'manual' check (source in ('manual','auto')),
  notes              text,
  created_at         timestamptz not null default now()
);

create index if not exists dividends_isin_idx on dividends(isin);
create index if not exists dividends_paydate_idx on dividends(pay_date);

-- -----------------------------------------------------------------------------
-- Convenience view: trades tagged with the Indian financial year.
-- (Holdings & FIFO realized P&L are computed in the app for correctness with
--  corporate actions; this view is a simple building block / sanity check.)
-- -----------------------------------------------------------------------------
create or replace view v_trades_fy as
  select t.*, fin_year(t.trade_date) as financial_year
  from trades t;

-- Simple net position per ISIN (ignores corporate actions; app view is authoritative).
create or replace view v_net_positions as
  select
    isin,
    max(security_name) as security_name,
    sum(case when side = 'BUY'  then quantity else 0 end) as total_bought,
    sum(case when side = 'SELL' then quantity else 0 end) as total_sold,
    sum(case when side = 'BUY'  then quantity else -quantity end) as net_quantity
  from trades
  group by isin;

-- Dividends tagged with financial year (by pay date, falling back to ex date).
create or replace view v_dividends_fy as
  select d.*, fin_year(coalesce(d.pay_date, d.ex_date)) as financial_year
  from dividends d;

-- -----------------------------------------------------------------------------
-- Row Level Security: enable, no public policies (server/service-role only).
-- -----------------------------------------------------------------------------
alter table contract_notes    enable row level security;
alter table trades            enable row level security;
alter table corporate_actions enable row level security;
alter table dividends         enable row level security;

-- =============================================================================
-- Done. Tables: contract_notes, trades, corporate_actions, dividends
--       Views:  v_trades_fy, v_net_positions, v_dividends_fy
--       Func:   fin_year(date)
-- =============================================================================
