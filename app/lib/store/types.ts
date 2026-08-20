import { ContractNote } from "@/app/lib/schema";

/**
 * The persistence contract, implemented twice: once against Supabase (web) and
 * once against a local SQLite file (desktop).
 *
 * Deliberately small — seven operations — because that is genuinely all the app
 * needs. Every non-trivial computation (holdings, FIFO P&L, financial-year
 * buckets) happens in `app/lib/analytics.ts` over plain arrays, so the store is
 * only ever asked to write rows and hand them all back.
 */

export interface SaveResult {
  saved: boolean;
  duplicate: boolean;
  note_id: string | null;
  trades: number;
  /** Null when the note could not be routed to an account — see UnassignedGroup. */
  account_id: string | null;
}

/**
 * An account is a *person or entity*, identified by PAN — not a demat account.
 * One account pools every broker that person trades through, so FIFO lots match
 * across brokers. That is a deliberate choice: it mirrors how a return is filed,
 * at the cost of holdings no longer tying to any single broker's statement.
 */
export type EntityType = "INDIVIDUAL" | "HUF" | "COMPANY" | "TRUST" | "OTHER";

export interface Account {
  id: string;
  label: string;
  pan: string | null;
  entity_type: EntityType;
  /** Broker + client code pairs known to belong to this account. */
  codes?: AccountCode[];
}

export interface AccountCode {
  id: string;
  account_id: string;
  broker_name: string;
  client_code: string;
}

export interface AccountInput {
  label: string;
  pan?: string | null;
  entity_type?: EntityType;
}

/** Notes that could not be routed, grouped by the identity printed on them. */
export interface UnassignedGroup {
  pan: string | null;
  broker_name: string | null;
  client_code: string | null;
  client_name: string | null;
  notes: number;
  trades: number;
}

export interface AssignResult {
  notes: number;
  trades: number;
}

/**
 * Which accounts a computation covers. Omitted means "every assigned account";
 * unassigned notes are always excluded from portfolio figures until mapped.
 */
export interface PortfolioFilter {
  accountIds?: string[];
}

export interface StoredTrade {
  /** Whose trade it is. FIFO must never match lots across two of these. */
  account_id?: string | null;
  trade_date: string;
  security_name: string | null;
  symbol: string | null;
  isin: string | null;
  exchange: string | null;
  segment: string | null;
  side: "BUY" | "SELL";
  quantity: number;
  gross_rate: number | null;
  net_rate: number | null;
  gross_value: number | null;
  net_value: number | null;
}

/**
 * A note with its charge columns and its trade lines, for reconciliation.
 *
 * Kept separate from the portfolio reads because it is the one view that needs a
 * note's charges *and* the lines under it: every other computation works over a
 * flat list of trades and never looks at the note they came from.
 */
export interface StoredNoteWithTrades {
  id: string;
  contract_note_number: string | null;
  trade_date: string | null;
  broker_name: string | null;
  client_name: string | null;
  account_id: string | null;
  source_filename: string | null;
  net_amount: number | null;
  net_amount_direction: "PAYABLE" | "RECEIVABLE" | null;
  brokerage: number | null;
  exchange_transaction_charges: number | null;
  clearing_charges: number | null;
  sebi_turnover_fees: number | null;
  stt: number | null;
  stamp_duty: number | null;
  ipft: number | null;
  gst: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  demat_charges: number | null;
  rounding: number | null;
  other_charges: number | null;
  total_charges: number | null;
  trades: {
    side: "BUY" | "SELL";
    quantity: number | null;
    gross_rate: number | null;
    gross_value: number | null;
    net_rate: number | null;
    net_value: number | null;
    security_name: string | null;
    isin: string | null;
  }[];
}

export interface StoredDividend {
  id: string;
  /** Whose dividend it is. The column has always existed; the type omitted it. */
  account_id: string | null;
  isin: string;
  symbol: string | null;
  security_name: string | null;
  ex_date: string | null;
  pay_date: string | null;
  amount_per_share: number | null;
  quantity: number | null;
  gross_amount: number | null;
  tds: number | null;
  net_amount: number | null;
  source: string;
  notes: string | null;
}

/**
 * A corporate action, covering all ten types in Table 4 of the spec.
 *
 * The columns beyond ISIN/type/date are sparse by design: a split needs only a
 * ratio, a demerger needs a ratio, a target and a cost split, a buyback needs a
 * quantity and a price. Rather than a table per mechanism, one table carries the
 * union and `app/lib/corporate-actions.ts` says which fields each type requires.
 */
export interface StoredCorporateAction {
  id: string;
  isin: string;
  symbol: string | null;
  security_name: string | null;
  action_type: string;
  ex_date: string;
  /** `ratio_from` shares held become `ratio_to`. One convention for every type. */
  ratio_from: number | null;
  ratio_to: number | null;
  /** Derived from the ratio and stored so a reader never has to divide. */
  quantity_multiplier: number | null;
  target_isin: string | null;
  target_symbol: string | null;
  target_security_name: string | null;
  /** Fraction of cost basis leaving this security. Demergers only. */
  cost_fraction: number | null;
  price_per_share: number | null;
  quantity: number | null;
  ratio_text: string | null;
  notes: string | null;
  source: string;
}

export interface DividendInput {
  isin: string;
  /** Which person received it. Required for it to appear in any portfolio view. */
  account_id?: string | null;
  symbol?: string | null;
  security_name?: string | null;
  ex_date?: string | null;
  pay_date?: string | null;
  amount_per_share?: number | null;
  quantity?: number | null;
  gross_amount?: number | null;
  tds?: number | null;
  net_amount?: number | null;
  source?: string;
  notes?: string | null;
}

export interface CorporateActionInput {
  isin: string;
  symbol?: string | null;
  security_name?: string | null;
  action_type: string;
  ex_date: string;
  ratio_from?: number | null;
  ratio_to?: number | null;
  target_isin?: string | null;
  target_symbol?: string | null;
  target_security_name?: string | null;
  cost_fraction?: number | null;
  price_per_share?: number | null;
  quantity?: number | null;
  ratio_text?: string | null;
  source?: string;
  notes?: string | null;
}

/** What the UI shows about where data is going. */
export interface StoreInfo {
  driver: "sqlite" | "supabase";
  /** Human-readable location: a file path, or the Supabase project host. */
  location: string;
  /** True when data never leaves this machine. */
  local: boolean;
}

export interface Store {
  info(): StoreInfo;

  /**
   * False on backends that have no account dimension yet (the web build), so the
   * UI can hide the controls instead of showing ones that do nothing.
   */
  readonly accountsSupported: boolean;

  /** Write a note and its trade lines. Deduplicates; never throws on a repeat. */
  saveContractNote(note: ContractNote, filename?: string): Promise<SaveResult>;

  countContractNotes(filter?: PortfolioFilter): Promise<number>;
  listTrades(filter?: PortfolioFilter): Promise<StoredTrade[]>;
  /**
   * Notes with their charges and trade lines, for reconciliation. Unlike the
   * portfolio reads this includes unassigned notes: a note nobody has claimed
   * still has arithmetic worth checking, and checking it is free.
   */
  listNotesWithTrades(filter?: PortfolioFilter): Promise<StoredNoteWithTrades[]>;
  listDividends(filter?: PortfolioFilter): Promise<StoredDividend[]>;
  /** Market events, not account events — a split applies to every holder. */
  listCorporateActions(): Promise<StoredCorporateAction[]>;

  addDividend(input: DividendInput): Promise<string>;
  /** Insert or update on (isin, action_type, ex_date). */
  upsertCorporateAction(input: CorporateActionInput): Promise<string>;
  /** Remove one. A wrong ratio must be correctable, not permanent. */
  deleteCorporateAction(id: string): Promise<boolean>;

  // ---- accounts ----
  listAccounts(): Promise<Account[]>;
  createAccount(input: AccountInput): Promise<string>;
  /** Notes no account claims yet, grouped by the identity on the note. */
  listUnassigned(): Promise<UnassignedGroup[]>;
  /**
   * Claim one such group for an account: records the broker/client-code mapping
   * so future notes route themselves, backfills the notes and trades already
   * imported, and adopts the PAN if the account does not have one yet.
   */
  assignToAccount(args: {
    account_id: string;
    broker_name: string | null;
    client_code: string | null;
    pan?: string | null;
  }): Promise<AssignResult>;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}
