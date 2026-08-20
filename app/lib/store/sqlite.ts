import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ContractNote } from "@/app/lib/schema";
import {
  Account,
  AccountInput,
  AssignResult,
  CorporateActionInput,
  DividendInput,
  PortfolioFilter,
  SaveResult,
  Store,
  StoreError,
  StoreInfo,
  StoredCorporateAction,
  StoredDividend,
  StoredNoteWithTrades,
  StoredTrade,
  UnassignedGroup,
} from "@/app/lib/store/types";
import { normalizeContractNote } from "@/app/lib/store/normalize";
import { multiplierOf } from "@/app/lib/corporate-actions";

/**
 * Local SQLite store — the desktop default. Nothing leaves the machine.
 *
 * Uses `node:sqlite`, which is built into the Node runtime (Electron 43 ships
 * Node 24). That matters: a native module like better-sqlite3 would reintroduce
 * platform-specific binaries into the bundle and need an ABI rebuild per
 * Electron version, undoing the work that keeps a Windows build straightforward.
 *
 * The API is synchronous by design. Node is single-threaded, so a statement
 * cannot interleave with another — which is what makes the check-then-insert in
 * saveContractNote() safe even with the importer running three files at once,
 * without any locking of our own.
 */

const SCHEMA = `
create table if not exists accounts (
  id           text primary key,
  label        text not null,
  pan          text unique,
  entity_type  text not null default 'INDIVIDUAL'
                 check (entity_type in ('INDIVIDUAL','HUF','COMPANY','TRUST','OTHER')),
  created_at   text not null
);

-- Client codes are broker-specific: the same person is a different string at
-- each broker. This maps each broker/code pair onto the person.
create table if not exists account_codes (
  id           text primary key,
  account_id   text not null references accounts(id) on delete cascade,
  broker_name  text not null,
  client_code  text not null,
  created_at   text not null,
  unique (broker_name, client_code)
);

create table if not exists contract_notes (
  id                            text primary key,
  broker_name                   text,
  broker_sebi_regn              text,
  contract_note_number          text,
  trade_date                    text,
  settlement_date               text,
  settlement_number             text,
  client_name                   text,
  client_code                   text,
  pan                           text,
  exchange                      text,
  currency                      text default 'INR',
  brokerage                     real,
  exchange_transaction_charges  real,
  clearing_charges              real,
  sebi_turnover_fees            real,
  stt                           real,
  stamp_duty                    real,
  ipft                          real,
  gst                           real,
  cgst                          real,
  sgst                          real,
  igst                          real,
  demat_charges                 real,
  rounding                      real,
  other_charges                 real,
  total_charges                 real,
  net_amount                    real,
  net_amount_direction          text check (net_amount_direction in ('PAYABLE','RECEIVABLE')),
  source_filename               text,
  raw_json                      text,
  account_id                    text references accounts(id) on delete set null,
  created_at                    text not null,
  unique (broker_name, contract_note_number, trade_date)
);

create index if not exists notes_account_idx on contract_notes(account_id);

create table if not exists trades (
  id                 text primary key,
  contract_note_id   text references contract_notes(id) on delete cascade,
  trade_date         text not null,
  security_name      text,
  symbol             text,
  isin               text,
  exchange           text,
  segment            text,
  side               text not null check (side in ('BUY','SELL')),
  quantity           real not null,
  gross_rate         real,
  net_rate           real,
  gross_value        real,
  net_value          real,
  order_no           text,
  trade_no           text,
  trade_time         text,
  -- Denormalised from the note so FIFO can filter by account without a join on
  -- every read; kept in step by saveContractNote and assignToAccount.
  account_id         text references accounts(id) on delete set null,
  created_at         text not null
);

create index if not exists trades_account_idx    on trades(account_id);
create index if not exists trades_isin_idx       on trades(isin);
create index if not exists trades_trade_date_idx on trades(trade_date);
create index if not exists trades_note_idx       on trades(contract_note_id);

-- All ten action types from Table 4 of the spec. The columns are the union of
-- what the four mechanisms need and are therefore mostly null on any one row;
-- app/lib/corporate-actions.ts is the authority on which apply to which type.
-- No CHECK on action_type: the list is expected to grow, and a constraint here
-- would mean rebuilding the table each time it does.
create table if not exists corporate_actions (
  id                    text primary key,
  isin                  text not null,
  symbol                text,
  security_name         text,
  action_type           text not null,
  ex_date               text not null,
  ratio_from            real,
  ratio_to              real,
  quantity_multiplier   real,
  target_isin           text,
  target_symbol         text,
  target_security_name  text,
  /* Always a string, never null — see the unique constraint below. */
  target_key            text not null default '',
  cost_fraction         real,
  price_per_share       real,
  quantity              real,
  ratio_text            text,
  notes                 text,
  source                text not null default 'manual',
  created_at            text not null,
  -- target_isin is part of the key because a demerger into four companies is
  -- four rows on the same security and the same date, differing only in where
  -- the cost goes. It is '' rather than null for every other type, since SQLite
  -- treats nulls as distinct and a unique index containing one stops
  -- deduplicating anything.
  unique (isin, action_type, ex_date, target_key)
);

create index if not exists corp_actions_isin_idx on corporate_actions(isin);

create table if not exists dividends (
  id                 text primary key,
  isin               text not null,
  symbol             text,
  security_name      text,
  ex_date            text,
  pay_date           text,
  amount_per_share   real,
  quantity           real,
  gross_amount       real,
  tds                real default 0,
  net_amount         real,
  source             text not null default 'manual',
  notes              text,
  account_id         text references accounts(id) on delete set null,
  created_at         text not null
);

create index if not exists dividends_account_idx on dividends(account_id);
create index if not exists dividends_isin_idx    on dividends(isin);
create index if not exists dividends_paydate_idx on dividends(pay_date);
`;

/**
 * Where portfolio.db lives.
 *
 * The Electron main process passes LOCAL_DB_PATH explicitly. The fallback is for
 * `npm run desktop:dev`, where the Next server is started by the dev script
 * rather than by Electron — it resolves to the same file the packaged app uses,
 * so dev and the real app share one database.
 */
export function localDbPath(): string {
  const explicit = process.env.LOCAL_DB_PATH?.trim();
  if (explicit) return explicit;

  const home = os.homedir();
  const dir =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Asset Manager")
      : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Asset Manager")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Asset Manager");

  return path.join(dir, "portfolio.db");
}

/** Values SQLite will accept: undefined is not one of them. */
type Bindable = string | number | null;

function v(value: unknown): Bindable {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  return String(value);
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * PAN is the identity that links one person's accounts across brokers, so it has
 * to compare equal regardless of how a given contract note printed it.
 */
export function normalizePan(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleaned) ? cleaned : null;
}

/**
 * `create table if not exists` does nothing to a table that already exists, so
 * databases written before accounts existed need their new columns added.
 */
function migrate(conn: DatabaseSync): void {
  const columns = (table: string): string[] =>
    (conn.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    );

  for (const table of ["contract_notes", "trades", "dividends"]) {
    if (!columns(table).includes("account_id")) {
      conn.exec(`alter table ${table} add column account_id text`);
    }
  }

  migrateCorporateActions(conn);
  normalizeStoredSigns(conn);
}

/** The columns corporate_actions grew when Table 4's ten types arrived. */
const CORP_ACTION_COLUMNS: [string, string][] = [
  ["ratio_from", "real"],
  ["ratio_to", "real"],
  ["target_isin", "text"],
  ["target_symbol", "text"],
  ["target_security_name", "text"],
  ["target_key", "text not null default ''"],
  ["cost_fraction", "real"],
  ["price_per_share", "real"],
  ["quantity", "real"],
];

/**
 * Bring a corporate_actions table written for splits and bonuses up to the ten
 * types in Table 4.
 *
 * Two things need doing and only one of them is an ALTER. The new columns add
 * cleanly, but the original table also carried
 * `check (action_type in ('SPLIT','BONUS','MERGER','OTHER'))` and a NOT NULL on
 * `quantity_multiplier` — a demerger satisfies neither, and SQLite cannot drop a
 * constraint in place. So when the old constraints are still present the table
 * is rebuilt and its rows copied across.
 */
function migrateCorporateActions(conn: DatabaseSync): void {
  const row = conn
    .prepare("select sql from sqlite_master where type = 'table' and name = 'corporate_actions'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return;

  const existing = (
    conn.prepare("pragma table_info(corporate_actions)").all() as { name: string }[]
  ).map((c) => c.name);

  for (const [name, type] of CORP_ACTION_COLUMNS) {
    if (!existing.includes(name)) {
      conn.exec(`alter table corporate_actions add column ${name} ${type}`);
    }
  }

  const hasOldCheck = /check\s*\(\s*action_type/i.test(row.sql);
  const hasNotNullMultiplier = /quantity_multiplier\s+real\s+not\s+null/i.test(row.sql);
  // A key without target_key allows only one demerger per security per date,
  // which a four-way scheme breaks.
  const hasOldKey = !/unique\s*\([^)]*target_key/i.test(row.sql);
  if (!hasOldCheck && !hasNotNullMultiplier && !hasOldKey) return;

  conn.exec("begin immediate");
  try {
    conn.exec(`
      create table corporate_actions_new (
        id                    text primary key,
        isin                  text not null,
        symbol                text,
        security_name         text,
        action_type           text not null,
        ex_date               text not null,
        ratio_from            real,
        ratio_to              real,
        quantity_multiplier   real,
        target_isin           text,
        target_symbol         text,
        target_security_name  text,
        target_key            text not null default '',
        cost_fraction         real,
        price_per_share       real,
        quantity              real,
        ratio_text            text,
        notes                 text,
        source                text not null default 'manual',
        created_at            text not null,
        unique (isin, action_type, ex_date, target_key)
      );

      insert into corporate_actions_new (
        id, isin, symbol, security_name, action_type, ex_date,
        ratio_from, ratio_to, quantity_multiplier, target_isin, target_symbol,
        target_security_name, target_key, cost_fraction, price_per_share, quantity,
        ratio_text, notes, source, created_at
      )
      select
        id, isin, symbol, security_name, action_type, ex_date,
        -- Old rows carry only a multiplier. Expressed as a ratio it is "one
        -- share becomes m", which is exactly what the multiplier meant.
        coalesce(ratio_from, case when quantity_multiplier is not null then 1 end),
        coalesce(ratio_to, quantity_multiplier),
        quantity_multiplier, target_isin, target_symbol,
        target_security_name, coalesce(target_isin, ''), cost_fraction,
        price_per_share, quantity,
        ratio_text, notes, source, created_at
      from corporate_actions;

      drop table corporate_actions;
    `);
    conn.exec("alter table corporate_actions_new rename to corporate_actions");
    // The index went with the old table.
    conn.exec("create index if not exists corp_actions_isin_idx on corporate_actions(isin)");
    conn.exec("commit");
  } catch (err) {
    conn.exec("rollback");
    throw new StoreError(
      `Could not upgrade the corporate actions table: ${(err as Error).message}`
    );
  }
}

/**
 * Bring rows written before normalize.ts existed onto the same convention.
 *
 * The first real import stored 27 of 129 buy lines with a positive net value and
 * the other 102 negative — the same PDFs, read twice. Nothing was corrupted
 * (cost basis takes the magnitude and `side` carries direction), but the mix
 * means any future signed arithmetic gets a different answer depending on which
 * pass wrote the row. Rewriting them is safe precisely because the sign never
 * carried information here.
 *
 * Guarded by a count so the normal case — an already-clean database — costs one
 * scan of a small table and no write at all.
 */
function normalizeStoredSigns(conn: DatabaseSync): void {
  const magnitudes = ["quantity", "gross_rate", "net_rate", "gross_value", "net_value"];
  const dirty = conn
    .prepare(
      `select count(*) as n from trades where ${magnitudes
        .map((c) => `${c} < 0`)
        .join(" or ")}`
    )
    .get() as { n: number };

  if (dirty?.n) {
    conn.exec(
      `update trades set ${magnitudes.map((c) => `${c} = abs(${c})`).join(", ")}
        where ${magnitudes.map((c) => `${c} < 0`).join(" or ")}`
    );
  }

  // The note total and its direction have to agree, for the same reason: the
  // direction is read off words on the page, the sign off a bracket or a minus.
  conn.exec(
    `update contract_notes
        set net_amount = -abs(net_amount)
      where net_amount_direction = 'PAYABLE' and net_amount > 0`
  );
  conn.exec(
    `update contract_notes
        set net_amount = abs(net_amount)
      where net_amount_direction = 'RECEIVABLE' and net_amount < 0`
  );
  // Notes stored without a direction: recover it from the sign we do have.
  conn.exec(
    `update contract_notes
        set net_amount_direction = case when net_amount < 0 then 'PAYABLE' else 'RECEIVABLE' end
      where net_amount_direction is null and net_amount is not null and net_amount <> 0`
  );
}

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;

  const file = localDbPath();

  // Every fs call here carries a turbopackIgnore hint, for the same reason
  // ensureStructure() in folder.ts does: the path is only known at runtime, so
  // without it the bundler gives up on static tracing and sweeps the entire
  // project — including dist/ — into the server output.
  fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), {
    recursive: true,
    mode: 0o700,
  });

  // Create the file private *before* opening it. The database holds the user's
  // entire financial history, and SQLite copies the main file's permissions onto
  // the -wal and -shm sidecars it creates — so chmod-ing after the fact would
  // leave the WAL, which contains recently written rows, world-readable.
  if (!fs.existsSync(/*turbopackIgnore: true*/ file)) {
    fs.closeSync(fs.openSync(/*turbopackIgnore: true*/ file, "a", 0o600));
  }
  fs.chmodSync(/*turbopackIgnore: true*/ file, 0o600);

  const handle = new DatabaseSync(file);
  // WAL keeps reads from blocking the importer's writes; the busy timeout covers
  // the brief overlap if a second process (e.g. a dev server) has the file open.
  handle.exec("pragma journal_mode = WAL");
  handle.exec("pragma busy_timeout = 5000");
  handle.exec("pragma foreign_keys = ON");
  handle.exec(SCHEMA);
  migrate(handle);

  // Belt and braces: if this database predates the fix above, its sidecars may
  // already exist with looser permissions.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.chmodSync(/*turbopackIgnore: true*/ file + suffix, 0o600);
    } catch {
      // Not in WAL mode yet, or already gone — nothing to tighten.
    }
  }

  db = handle;
  return db;
}

function isUniqueViolation(err: unknown): boolean {
  const message = String((err as Error)?.message ?? "");
  return message.includes("UNIQUE constraint failed");
}

/**
 * Which account does this note belong to?
 *
 * PAN first, because it is the same string at every broker and is what makes one
 * person's accounts pool together. Client code is the fallback for notes that do
 * not print a PAN, and only works once that broker/code pair has been mapped by
 * hand. Returning null is a normal outcome, not an error: the note is saved
 * unassigned and held out of the portfolio until someone claims it.
 */
function resolveAccountId(conn: DatabaseSync, note: ContractNote): string | null {
  const pan = normalizePan(note.pan);
  if (pan) {
    const byPan = conn.prepare("select id from accounts where pan = ?").get(pan) as
      | { id: string }
      | undefined;
    if (byPan) return byPan.id;
  }

  if (note.broker_name && note.client_code) {
    const byCode = conn
      .prepare(
        "select account_id from account_codes where broker_name = ? and client_code = ?"
      )
      .get(note.broker_name, note.client_code) as { account_id: string } | undefined;
    if (byCode) return byCode.account_id;
  }

  return null;
}

/**
 * Claim every unassigned note carrying this PAN.
 *
 * PAN identifies the person, so the moment an account is known to own one there
 * is nothing left to decide — asking the user to confirm each broker separately
 * would be busywork over a question already answered. Runs when an account is
 * created with a PAN, and when one adopts a PAN during assignment.
 */
function claimByPan(conn: DatabaseSync, accountId: string, pan: string): number {
  const ids = (
    conn
      .prepare("select id from contract_notes where account_id is null and pan = ?")
      .all(pan) as { id: string }[]
  ).map((r) => r.id);

  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(", ");
  conn
    .prepare(`update contract_notes set account_id = ? where id in (${placeholders})`)
    .run(accountId, ...ids);
  conn
    .prepare(
      `update trades set account_id = ? where contract_note_id in (${placeholders})`
    )
    .run(accountId, ...ids);

  return ids.length;
}

/**
 * Build a `where` fragment restricting rows to the requested accounts.
 *
 * With no filter this still excludes unassigned rows: a note nobody has claimed
 * must not silently join someone's holdings.
 */
function accountScope(
  filter: PortfolioFilter | undefined,
  column = "account_id"
): { sql: string; params: string[] } {
  const ids = filter?.accountIds?.filter(Boolean) ?? [];
  if (ids.length > 0) {
    return {
      sql: `${column} in (${ids.map(() => "?").join(", ")})`,
      params: ids,
    };
  }
  return { sql: `${column} is not null`, params: [] };
}

export const sqliteStore: Store = {
  info(): StoreInfo {
    return { driver: "sqlite", location: localDbPath(), local: true };
  },

  accountsSupported: true,

  async saveContractNote(input: ContractNote, filename?: string): Promise<SaveResult> {
    const conn = open();
    // Signs first, so what lands in the database — and in raw_json beside it —
    // is the same whichever way the extraction happened to read a bracket.
    const d = normalizeContractNote(input);
    const c = d.charges;

    // Dedupe only when all three key parts are present. A note missing any of
    // them would otherwise collide with every other note that is also missing
    // it — two unidentifiable notes are not the same note. This mirrors how the
    // Postgres unique constraint treats NULLs as distinct.
    const keyed = Boolean(d.broker_name && d.contract_note_number && d.trade_date);
    if (keyed) {
      const existing = conn
        .prepare(
          `select id from contract_notes
            where broker_name = ? and contract_note_number = ? and trade_date = ?`
        )
        .get(d.broker_name!, d.contract_note_number!, d.trade_date!) as
        | { id: string }
        | undefined;

      if (existing) {
        return {
          saved: false,
          duplicate: true,
          note_id: existing.id,
          trades: 0,
          account_id: null,
        };
      }
    }

    const noteId = randomUUID();
    const now = new Date().toISOString();
    const accountId = resolveAccountId(conn, d);

    const trades = (d.trades || [])
      .filter((t) => t.buy_sell && t.quantity)
      .map((t) => ({
        ...t,
        exchange: t.exchange ?? d.exchange,
      }));

    conn.exec("begin immediate");
    try {
      conn
        .prepare(
          `insert into contract_notes (
             id, broker_name, broker_sebi_regn, contract_note_number, trade_date,
             settlement_date, settlement_number, client_name, client_code, pan,
             exchange, currency, brokerage, exchange_transaction_charges,
             clearing_charges, sebi_turnover_fees, stt, stamp_duty, ipft, gst,
             cgst, sgst, igst, demat_charges, rounding, other_charges,
             total_charges, net_amount, net_amount_direction, source_filename,
             raw_json, account_id, created_at
           ) values (${new Array(33).fill("?").join(", ")})`
        )
        .run(
          noteId,
          v(d.broker_name),
          v(d.broker_sebi_regn),
          v(d.contract_note_number),
          v(d.trade_date),
          v(d.settlement_date),
          v(d.settlement_number),
          v(d.client_name),
          v(d.client_code),
          v(d.pan),
          v(d.exchange),
          v(d.currency ?? "INR"),
          num(c.brokerage),
          num(c.exchange_transaction_charges),
          num(c.clearing_charges),
          num(c.sebi_turnover_fees),
          num(c.stt),
          num(c.stamp_duty),
          num(c.ipft),
          num(c.gst),
          num(c.cgst),
          num(c.sgst),
          num(c.igst),
          num(c.demat_charges),
          num(c.rounding),
          num(c.other_charges),
          num(c.total_charges),
          num(d.net_amount),
          v(d.net_amount_direction),
          v(filename),
          JSON.stringify(d),
          accountId,
          now
        );

      const insertTrade = conn.prepare(
        `insert into trades (
           id, contract_note_id, trade_date, security_name, symbol, isin,
           exchange, segment, side, quantity, gross_rate, net_rate, gross_value,
           net_value, order_no, trade_no, trade_time, account_id, created_at
         ) values (${new Array(19).fill("?").join(", ")})`
      );

      for (const t of trades) {
        insertTrade.run(
          randomUUID(),
          noteId,
          v(d.trade_date) ?? "",
          v(t.security_name),
          v(t.symbol),
          v(t.isin),
          v(t.exchange),
          v(t.segment),
          t.buy_sell as string,
          num(t.quantity)!,
          num(t.gross_rate),
          num(t.net_rate),
          num(t.gross_value),
          num(t.net_value),
          v(t.order_no),
          v(t.trade_no),
          v(t.trade_time),
          accountId,
          now
        );
      }

      conn.exec("commit");
    } catch (err) {
      conn.exec("rollback");

      // Lost the race with a concurrent import worker on the same note: the
      // unique constraint caught what the pre-check could not. Same outcome.
      if (isUniqueViolation(err)) {
        const existing = conn
          .prepare(
            `select id from contract_notes
              where broker_name is ? and contract_note_number is ? and trade_date is ?`
          )
          .get(v(d.broker_name), v(d.contract_note_number), v(d.trade_date)) as
          | { id: string }
          | undefined;
        return {
          saved: false,
          duplicate: true,
          note_id: existing?.id ?? null,
          trades: 0,
          account_id: null,
        };
      }

      throw new StoreError(`Failed to save contract note: ${(err as Error).message}`);
    }

    return {
      saved: true,
      duplicate: false,
      note_id: noteId,
      trades: trades.length,
      account_id: accountId,
    };
  },

  async countContractNotes(filter?: PortfolioFilter): Promise<number> {
    const scope = accountScope(filter);
    const row = open()
      .prepare(`select count(*) as n from contract_notes where ${scope.sql}`)
      .get(...scope.params) as { n: number };
    return row?.n ?? 0;
  },

  async listTrades(filter?: PortfolioFilter): Promise<StoredTrade[]> {
    const scope = accountScope(filter);
    return open()
      .prepare(
        `select account_id, trade_date, security_name, symbol, isin, exchange,
                segment, side, quantity, gross_rate, net_rate, gross_value, net_value
           from trades where ${scope.sql} order by trade_date asc`
      )
      .all(...scope.params) as unknown as StoredTrade[];
  },

  async listNotesWithTrades(filter?: PortfolioFilter): Promise<StoredNoteWithTrades[]> {
    const conn = open();

    // Unlike every other read, no filter means *every* note, unassigned ones
    // included. Reconciliation checks a note against itself, so ownership has no
    // bearing on the answer — and an unclaimed note is exactly the kind that
    // nobody has looked at yet.
    const ids = filter?.accountIds?.filter(Boolean) ?? [];
    const where = ids.length
      ? `where account_id in (${ids.map(() => "?").join(", ")})`
      : "";

    const notes = conn
      .prepare(
        `select id, contract_note_number, trade_date, broker_name, client_name,
                account_id, source_filename, net_amount, net_amount_direction,
                brokerage, exchange_transaction_charges, clearing_charges,
                sebi_turnover_fees, stt, stamp_duty, ipft, gst, cgst, sgst, igst,
                demat_charges, rounding, other_charges, total_charges
           from contract_notes ${where}
          order by trade_date asc`
      )
      .all(...ids) as unknown as StoredNoteWithTrades[];

    if (notes.length === 0) return [];

    // One query for all the lines, bucketed in memory: 27 notes would otherwise
    // be 28 round trips, and a year of imports rather more.
    const lines = conn
      .prepare(
        `select contract_note_id, side, quantity, gross_rate, gross_value,
                net_rate, net_value, security_name, isin
           from trades
          where contract_note_id in (${notes.map(() => "?").join(", ")})`
      )
      .all(...notes.map((n) => n.id)) as unknown as ({
      contract_note_id: string;
    } & StoredNoteWithTrades["trades"][number])[];

    const byNote = new Map<string, StoredNoteWithTrades["trades"]>();
    for (const { contract_note_id, ...line } of lines) {
      const bucket = byNote.get(contract_note_id);
      if (bucket) bucket.push(line);
      else byNote.set(contract_note_id, [line]);
    }

    return notes.map((n) => ({ ...n, trades: byNote.get(n.id) ?? [] }));
  },

  async listDividends(filter?: PortfolioFilter): Promise<StoredDividend[]> {
    const scope = accountScope(filter);
    return open()
      .prepare(`select * from dividends where ${scope.sql} order by pay_date desc`)
      .all(...scope.params) as unknown as StoredDividend[];
  },

  async listCorporateActions(): Promise<StoredCorporateAction[]> {
    return open()
      .prepare("select * from corporate_actions order by ex_date desc")
      .all() as unknown as StoredCorporateAction[];
  },

  async addDividend(input: DividendInput): Promise<string> {
    const id = randomUUID();
    open()
      .prepare(
        `insert into dividends (
           id, isin, symbol, security_name, ex_date, pay_date, amount_per_share,
           quantity, gross_amount, tds, net_amount, source, notes, account_id,
           created_at
         ) values (${new Array(15).fill("?").join(", ")})`
      )
      .run(
        id,
        input.isin,
        v(input.symbol),
        v(input.security_name),
        v(input.ex_date),
        v(input.pay_date),
        num(input.amount_per_share),
        num(input.quantity),
        num(input.gross_amount),
        num(input.tds) ?? 0,
        num(input.net_amount),
        input.source ?? "manual",
        v(input.notes),
        v(input.account_id),
        new Date().toISOString()
      );
    return id;
  },

  async upsertCorporateAction(input: CorporateActionInput): Promise<string> {
    const conn = open();
    // Stored alongside the ratio it comes from, so nothing downstream has to
    // divide and nothing can disagree about which way round the ratio went.
    const multiplier = multiplierOf(input.ratio_from, input.ratio_to);

    conn
      .prepare(
        `insert into corporate_actions (
           id, isin, symbol, security_name, action_type, ex_date,
           ratio_from, ratio_to, quantity_multiplier, target_isin, target_symbol,
           target_security_name, target_key, cost_fraction, price_per_share, quantity,
           ratio_text, notes, source, created_at
         ) values (${new Array(20).fill("?").join(", ")})
         on conflict (isin, action_type, ex_date, target_key) do update set
           symbol               = excluded.symbol,
           security_name        = excluded.security_name,
           ratio_from           = excluded.ratio_from,
           ratio_to             = excluded.ratio_to,
           quantity_multiplier  = excluded.quantity_multiplier,
           target_isin          = excluded.target_isin,
           target_symbol        = excluded.target_symbol,
           target_security_name = excluded.target_security_name,
           cost_fraction        = excluded.cost_fraction,
           price_per_share      = excluded.price_per_share,
           quantity             = excluded.quantity,
           ratio_text           = excluded.ratio_text,
           notes                = excluded.notes,
           source               = excluded.source`
      )
      .run(
        randomUUID(),
        input.isin,
        v(input.symbol),
        v(input.security_name),
        input.action_type,
        input.ex_date,
        num(input.ratio_from),
        num(input.ratio_to),
        multiplier,
        v(input.target_isin),
        v(input.target_symbol),
        v(input.target_security_name),
        input.target_isin?.trim() || "",
        num(input.cost_fraction),
        num(input.price_per_share),
        num(input.quantity),
        v(input.ratio_text),
        v(input.notes),
        input.source ?? "manual",
        new Date().toISOString()
      );

    const row = conn
      .prepare(
        `select id from corporate_actions
          where isin = ? and action_type = ? and ex_date = ? and target_key = ?`
      )
      .get(
        input.isin,
        input.action_type,
        input.ex_date,
        input.target_isin?.trim() || ""
      ) as { id: string } | undefined;

    return row?.id ?? "";
  },

  async deleteCorporateAction(id: string): Promise<boolean> {
    const res = open().prepare("delete from corporate_actions where id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  },

  // ---- accounts -----------------------------------------------------------

  async listAccounts(): Promise<Account[]> {
    const conn = open();
    const accounts = conn
      .prepare("select id, label, pan, entity_type from accounts order by label asc")
      .all() as unknown as Account[];

    const codes = conn
      .prepare("select id, account_id, broker_name, client_code from account_codes")
      .all() as unknown as Account["codes"];

    return accounts.map((a) => ({
      ...a,
      codes: (codes ?? []).filter((c) => c.account_id === a.id),
    }));
  },

  async createAccount(input: AccountInput): Promise<string> {
    const label = input.label?.trim();
    if (!label) throw new StoreError("An account needs a name.");

    const pan = normalizePan(input.pan);
    if (input.pan && !pan) {
      throw new StoreError(
        `"${input.pan}" is not a valid PAN. It should look like ABCDE1234F.`
      );
    }

    const id = randomUUID();
    const conn = open();
    try {
      conn
        .prepare(
          `insert into accounts (id, label, pan, entity_type, created_at)
           values (?, ?, ?, ?, ?)`
        )
        .run(id, label, pan, input.entity_type ?? "INDIVIDUAL", new Date().toISOString());

      // Anything already imported under this PAN belongs to the new account.
      if (pan) claimByPan(conn, id, pan);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new StoreError(`PAN ${pan} already belongs to another account.`);
      }
      throw new StoreError(`Could not create the account: ${(err as Error).message}`);
    }
    return id;
  },

  async listUnassigned(): Promise<UnassignedGroup[]> {
    return open()
      .prepare(
        `select n.pan, n.broker_name, n.client_code, n.client_name,
                count(distinct n.id) as notes,
                count(t.id)          as trades
           from contract_notes n
           left join trades t on t.contract_note_id = n.id
          where n.account_id is null
          group by n.pan, n.broker_name, n.client_code, n.client_name
          order by notes desc`
      )
      .all() as unknown as UnassignedGroup[];
  },

  async assignToAccount(args: {
    account_id: string;
    broker_name: string | null;
    client_code: string | null;
    pan?: string | null;
  }): Promise<AssignResult> {
    const conn = open();

    const account = conn
      .prepare("select id, pan from accounts where id = ?")
      .get(args.account_id) as { id: string; pan: string | null } | undefined;
    if (!account) throw new StoreError("That account no longer exists.");

    const pan = normalizePan(args.pan);

    conn.exec("begin immediate");
    try {
      // Adopting the PAN is what makes future notes route themselves, including
      // notes from brokers this account has never been seen at.
      if (pan && !account.pan) {
        conn.prepare("update accounts set pan = ? where id = ?").run(pan, account.id);
        // Newly adopted PAN — sweep up every other note carrying it, whatever
        // broker it came from.
        claimByPan(conn, account.id, pan);
      }

      // Remember the broker/client code so the next import needs no help.
      if (args.broker_name && args.client_code) {
        conn
          .prepare(
            `insert into account_codes (id, account_id, broker_name, client_code, created_at)
             values (?, ?, ?, ?, ?)
             on conflict (broker_name, client_code) do update set account_id = excluded.account_id`
          )
          .run(
            randomUUID(),
            account.id,
            args.broker_name,
            args.client_code,
            new Date().toISOString()
          );
      }

      // Match the group exactly as listUnassigned grouped it — `is` rather than
      // `=` so a group keyed on a missing broker or code still matches its rows.
      const where = `account_id is null
                       and pan is ? and broker_name is ? and client_code is ?`;
      const params = [v(args.pan), v(args.broker_name), v(args.client_code)];

      const noteIds = (
        conn
          .prepare(`select id from contract_notes where ${where}`)
          .all(...params) as { id: string }[]
      ).map((r) => r.id);

      let trades = 0;
      if (noteIds.length > 0) {
        const placeholders = noteIds.map(() => "?").join(", ");
        conn
          .prepare(
            `update contract_notes set account_id = ? where id in (${placeholders})`
          )
          .run(account.id, ...noteIds);

        const res = conn
          .prepare(
            `update trades set account_id = ? where contract_note_id in (${placeholders})`
          )
          .run(account.id, ...noteIds);
        trades = Number(res.changes ?? 0);
      }

      conn.exec("commit");
      return { notes: noteIds.length, trades };
    } catch (err) {
      conn.exec("rollback");
      throw new StoreError(`Could not assign those notes: ${(err as Error).message}`);
    }
  },
};
