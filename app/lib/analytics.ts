/**
 * Portfolio analytics: FIFO realized P&L, holdings, and financial-year buckets.
 *
 * Everything here is pure and deterministic — it takes trades + corporate
 * actions and returns computed holdings and realized gains. Dividends are
 * aggregated separately (see aggregateDividends) since they come from their own
 * table, not from trades.
 *
 * Cost-basis convention (v1):
 *   - BUY cost and SELL proceeds use `net_value` from the contract note, which
 *     is brokerage-inclusive (quantity x net_rate). Note-level statutory levies
 *     (STT, stamp duty, GST, exchange/SEBI charges) are tracked per contract
 *     note but not yet allocated per trade. STT in particular is by law NOT a
 *     deductible cost for Indian capital gains, so excluding it here is correct;
 *     finer allocation of the remaining levies can be layered on later.
 */

export type Side = "BUY" | "SELL";

export interface TradeRow {
  trade_date: string; // ISO date
  security_name: string | null;
  symbol: string | null;
  isin: string | null;
  side: Side;
  quantity: number;
  net_rate: number | null;
  net_value: number | null;
  gross_rate: number | null;
  gross_value: number | null;
}

export interface CorporateActionRow {
  isin: string;
  security_name: string | null;
  action_type: "SPLIT" | "BONUS" | "MERGER" | "OTHER";
  ex_date: string;
  quantity_multiplier: number;
  ratio_text: string | null;
}

export interface DividendRow {
  isin: string;
  security_name: string | null;
  symbol: string | null;
  ex_date: string | null;
  pay_date: string | null;
  amount_per_share: number | null;
  quantity: number | null;
  gross_amount: number | null;
  tds: number | null;
  net_amount: number | null;
}

export interface Holding {
  isin: string;
  security_name: string | null;
  quantity: number;
  avg_cost: number; // per unit
  invested: number; // quantity * avg_cost
}

export interface RealizedEvent {
  isin: string;
  security_name: string | null;
  buy_date: string;
  sell_date: string;
  quantity: number;
  cost: number;
  proceeds: number;
  gain: number;
  holding_days: number;
  term: "SHORT" | "LONG";
  financial_year: string;
}

export interface FYPnl {
  financial_year: string;
  short_term_gain: number;
  long_term_gain: number;
  total_gain: number;
  proceeds: number;
  cost: number;
  trades_closed: number;
}

/** Indian financial year label for an ISO date string. */
export function finYear(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  const start = m >= 4 ? y : y - 1;
  const end = (start + 1) % 100;
  return `${start}-${String(end).padStart(2, "0")}`;
}

const LONG_TERM_DAYS = 365; // equity: held > 12 months = long term

interface Lot {
  date: string;
  qty: number;
  costPerUnit: number;
}

type Ev =
  | { kind: "ACTION"; date: string; multiplier: number }
  | { kind: "TRADE"; date: string; side: Side; qty: number; valuePerUnit: number; name: string | null };

// Same-day ordering: apply splits/bonuses first, then buys, then sells.
const KIND_ORDER: Record<string, number> = { ACTION: 0, BUY: 1, SELL: 2 };

function evKey(e: Ev): number {
  if (e.kind === "ACTION") return KIND_ORDER.ACTION;
  return KIND_ORDER[e.side];
}

/**
 * Core engine. Returns current holdings and every realized (closed) lot event.
 */
export function computePortfolio(
  trades: TradeRow[],
  actions: CorporateActionRow[]
): { holdings: Holding[]; realized: RealizedEvent[] } {
  // Group by ISIN (fall back to security name when ISIN missing).
  const byKey = new Map<string, { name: string | null; events: Ev[] }>();

  const keyOf = (isin: string | null, name: string | null) =>
    isin || name || "UNKNOWN";

  for (const t of trades) {
    if (!t.quantity || !t.side) continue;
    const key = keyOf(t.isin, t.security_name);
    if (!byKey.has(key)) byKey.set(key, { name: t.security_name, events: [] });
    const perUnit =
      t.net_value != null && t.quantity
        ? Math.abs(t.net_value) / t.quantity
        : t.net_rate ?? t.gross_rate ?? 0;
    byKey.get(key)!.events.push({
      kind: "TRADE",
      date: t.trade_date,
      side: t.side,
      qty: t.quantity,
      valuePerUnit: perUnit,
      name: t.security_name,
    });
  }

  for (const a of actions) {
    const key = keyOf(a.isin, a.security_name);
    if (!byKey.has(key)) byKey.set(key, { name: a.security_name, events: [] });
    byKey.get(key)!.events.push({
      kind: "ACTION",
      date: a.ex_date,
      multiplier: a.quantity_multiplier,
    });
  }

  const holdings: Holding[] = [];
  const realized: RealizedEvent[] = [];

  for (const [key, { name, events }] of byKey) {
    // Sort chronologically, then by same-day kind ordering.
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return evKey(a) - evKey(b);
    });

    const lots: Lot[] = [];

    for (const e of events) {
      if (e.kind === "ACTION") {
        // Preserve total cost: qty *= m, costPerUnit /= m.
        if (e.multiplier && e.multiplier > 0) {
          for (const lot of lots) {
            lot.qty *= e.multiplier;
            lot.costPerUnit /= e.multiplier;
          }
        }
        continue;
      }

      if (e.side === "BUY") {
        lots.push({ date: e.date, qty: e.qty, costPerUnit: e.valuePerUnit });
      } else {
        // SELL: match FIFO against open lots.
        let remaining = e.qty;
        const sellPerUnit = e.valuePerUnit;
        while (remaining > 0 && lots.length > 0) {
          const lot = lots[0];
          const matched = Math.min(remaining, lot.qty);
          const cost = matched * lot.costPerUnit;
          const proceeds = matched * sellPerUnit;
          const days = daysBetween(lot.date, e.date);
          realized.push({
            isin: key,
            security_name: name ?? e.name,
            buy_date: lot.date,
            sell_date: e.date,
            quantity: matched,
            cost,
            proceeds,
            gain: proceeds - cost,
            holding_days: days,
            term: days > LONG_TERM_DAYS ? "LONG" : "SHORT",
            financial_year: finYear(e.date),
          });
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 1e-9) lots.shift();
        }
        // If remaining > 0 here, the sell exceeded holdings (e.g. missing
        // opening data). We ignore the unmatched part rather than invent cost.
      }
    }

    // Remaining lots -> current holding.
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    if (qty > 1e-9) {
      const invested = lots.reduce((s, l) => s + l.qty * l.costPerUnit, 0);
      holdings.push({
        isin: key,
        security_name: name,
        quantity: round(qty),
        avg_cost: round(invested / qty, 4),
        invested: round(invested),
      });
    }
  }

  holdings.sort((a, b) => (a.security_name || "").localeCompare(b.security_name || ""));
  realized.sort((a, b) => (a.sell_date < b.sell_date ? -1 : 1));
  return { holdings, realized };
}

/** Aggregate realized events into per-financial-year P&L. */
export function pnlByFinancialYear(realized: RealizedEvent[]): FYPnl[] {
  const map = new Map<string, FYPnl>();
  for (const r of realized) {
    let row = map.get(r.financial_year);
    if (!row) {
      row = {
        financial_year: r.financial_year,
        short_term_gain: 0,
        long_term_gain: 0,
        total_gain: 0,
        proceeds: 0,
        cost: 0,
        trades_closed: 0,
      };
      map.set(r.financial_year, row);
    }
    if (r.term === "LONG") row.long_term_gain += r.gain;
    else row.short_term_gain += r.gain;
    row.total_gain += r.gain;
    row.proceeds += r.proceeds;
    row.cost += r.cost;
    row.trades_closed += 1;
  }
  const rows = Array.from(map.values()).map((r) => ({
    ...r,
    short_term_gain: round(r.short_term_gain),
    long_term_gain: round(r.long_term_gain),
    total_gain: round(r.total_gain),
    proceeds: round(r.proceeds),
    cost: round(r.cost),
  }));
  rows.sort((a, b) => (a.financial_year < b.financial_year ? -1 : 1));
  return rows;
}

export interface FYDividend {
  financial_year: string;
  total_gross: number;
  total_tds: number;
  total_net: number;
  count: number;
}

/** Aggregate dividends into per-financial-year totals (by pay date, else ex date). */
export function aggregateDividends(dividends: DividendRow[]): FYDividend[] {
  const map = new Map<string, FYDividend>();
  for (const d of dividends) {
    const dateStr = d.pay_date || d.ex_date;
    if (!dateStr) continue;
    const fy = finYear(dateStr);
    let row = map.get(fy);
    if (!row) {
      row = { financial_year: fy, total_gross: 0, total_tds: 0, total_net: 0, count: 0 };
      map.set(fy, row);
    }
    const gross = d.gross_amount ?? (d.amount_per_share ?? 0) * (d.quantity ?? 0);
    const tds = d.tds ?? 0;
    const net = d.net_amount ?? gross - tds;
    row.total_gross += gross;
    row.total_tds += tds;
    row.total_net += net;
    row.count += 1;
  }
  const rows = Array.from(map.values()).map((r) => ({
    ...r,
    total_gross: round(r.total_gross),
    total_tds: round(r.total_tds),
    total_net: round(r.total_net),
  }));
  rows.sort((a, b) => (a.financial_year < b.financial_year ? -1 : 1));
  return rows;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86_400_000);
}

function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
