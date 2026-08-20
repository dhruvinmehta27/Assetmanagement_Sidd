/**
 * Portfolio analytics: FIFO realized P&L, holdings, corporate actions, and
 * financial-year buckets.
 *
 * Everything here is pure and deterministic — it takes trades + corporate
 * actions and returns computed holdings, realized gains, and a record of what
 * each action actually did. Dividends are aggregated separately (see
 * aggregateDividends) since they come from their own table, not from trades.
 *
 * Cost-basis convention (v1):
 *   - BUY cost and SELL proceeds use `net_value` from the contract note, which
 *     is brokerage-inclusive (quantity x net_rate). Note-level statutory levies
 *     (STT, stamp duty, GST, exchange/SEBI charges) are tracked per contract
 *     note but not yet allocated per trade. STT in particular is by law NOT a
 *     deductible cost for Indian capital gains, so excluding it here is correct;
 *     finer allocation of the remaining levies can be layered on later.
 *
 * **Why this is one global loop rather than a loop per security.** It used to
 * group trades by ISIN and run each group independently, which is fine while
 * every event stays inside one security. Demergers, mergers and ISIN changes do
 * not: they move cost basis from one security to another, on a date, and the
 * receiving security's FIFO queue has to end up in the right order. So events
 * across all securities are merged into one date-ordered stream over a book of
 * positions.
 */

import { ActionType, mechanismOf, multiplierOf, specOf } from "@/app/lib/corporate-actions";

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
  id?: string | null;
  isin: string;
  symbol?: string | null;
  security_name: string | null;
  action_type: ActionType | string;
  ex_date: string;
  /** `ratio_from` shares held become `ratio_to`. See corporate-actions.ts. */
  ratio_from?: number | null;
  ratio_to?: number | null;
  target_isin?: string | null;
  target_symbol?: string | null;
  target_security_name?: string | null;
  /** Fraction of cost basis that leaves this security. Demergers only. */
  cost_fraction?: number | null;
  price_per_share?: number | null;
  quantity?: number | null;
  ratio_text?: string | null;
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
  /** Delisted holdings stay on the books but are worth nothing until relisted. */
  delisted?: boolean;
}

export type RealizedSource = "SELL" | "BUYBACK" | "LIQUIDATION";

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
  /** How the position closed. A buyback is still a disposal, just not a sale. */
  source: RealizedSource;
}

/**
 * What an action actually did, once applied to real holdings.
 *
 * This is the answer to "did I enter that ratio right?", and it is the reason
 * the page can be trusted: a wrong ratio is invisible in the input and obvious
 * here, where it says 400 shares became 2,000.
 */
export interface ActionEffect {
  action_id: string | null;
  isin: string;
  security_name: string | null;
  action_type: string;
  ex_date: string;
  applied: boolean;
  /** Why nothing happened, when nothing happened. */
  note: string | null;
  quantity_before: number;
  quantity_after: number;
  /** Positive when the action handed you shares. */
  shares_received: number;
  cost_before: number;
  /** Cost basis that left this security for another. */
  cost_moved: number;
  target_isin: string | null;
  target_quantity: number;
  realized_gain: number;
}

export interface FYPnl {
  financial_year: string;
  /** Net of profits and losses in that bucket. */
  short_term_gain: number;
  long_term_gain: number;
  /**
   * Gross profit and gross loss, kept apart.
   *
   * Tax law does not work on the net figure: a short-term loss may be set off
   * against long-term gains, a long-term loss may not be set off against
   * short-term gains, and the ₹1.25 lakh exemption applies to long-term gains
   * only. All of that needs the two sides separately, and netting them first
   * throws the information away. Losses are positive magnitudes.
   */
  short_term_profit: number;
  short_term_loss: number;
  long_term_profit: number;
  long_term_loss: number;
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
const EPS = 1e-9;

interface Lot {
  /** Acquisition date. Drives the holding period, so transfers carry it over. */
  date: string;
  qty: number;
  costPerUnit: number;
}

interface Position {
  key: string;
  isin: string;
  name: string | null;
  lots: Lot[];
  delisted: boolean;
}

type Ev =
  | {
      kind: "TRADE";
      date: string;
      side: Side;
      qty: number;
      valuePerUnit: number;
      key: string;
      isin: string;
      name: string | null;
    }
  /**
   * `actions` is a list because a demerger into several companies is one event
   * whose percentages all refer to the same starting cost. Every other type has
   * exactly one entry.
   */
  | { kind: "ACTION"; date: string; actions: CorporateActionRow[]; key: string };

// Same-day ordering: corporate actions land before that day's trades, because
// an entitlement is settled against the holding of record, not against what was
// bought later the same morning.
const KIND_ORDER: Record<string, number> = { ACTION: 0, BUY: 1, SELL: 2 };

function evKey(e: Ev): number {
  return e.kind === "ACTION" ? KIND_ORDER.ACTION : KIND_ORDER[e.side];
}

const keyOf = (isin: string | null, name: string | null) => isin || name || "UNKNOWN";

function totalQty(pos: Position): number {
  return pos.lots.reduce((s, l) => s + l.qty, 0);
}

function totalCost(pos: Position): number {
  return pos.lots.reduce((s, l) => s + l.qty * l.costPerUnit, 0);
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

/**
 * Consume `qty` from the front of a position's lots at `pricePerUnit`, pushing a
 * realized event for each lot touched. Shared by sales, buybacks and
 * liquidations — they differ only in what they are called and what price they
 * happen at, never in how the matching works.
 *
 * Returns the gain, and leaves any unmatched quantity unmatched rather than
 * inventing a cost for it.
 */
function closeFifo(
  pos: Position,
  qty: number,
  pricePerUnit: number,
  date: string,
  source: RealizedSource,
  realized: RealizedEvent[]
): number {
  let remaining = qty;
  let gain = 0;

  while (remaining > EPS && pos.lots.length > 0) {
    const lot = pos.lots[0];
    const matched = Math.min(remaining, lot.qty);
    const cost = matched * lot.costPerUnit;
    const proceeds = matched * pricePerUnit;
    const days = daysBetween(lot.date, date);

    realized.push({
      isin: pos.isin,
      security_name: pos.name,
      buy_date: lot.date,
      sell_date: date,
      quantity: matched,
      cost,
      proceeds,
      gain: proceeds - cost,
      holding_days: days,
      term: days > LONG_TERM_DAYS ? "LONG" : "SHORT",
      financial_year: finYear(date),
      source,
    });

    gain += proceeds - cost;
    lot.qty -= matched;
    remaining -= matched;
    if (lot.qty <= EPS) pos.lots.shift();
  }

  return gain;
}

/**
 * Apply one corporate action to the book, and report what it did.
 *
 * Dispatches on mechanism, not on action name — see corporate-actions.ts. Ten
 * names, four things that can actually happen.
 */
function applyAction(
  action: CorporateActionRow,
  positions: Map<string, Position>,
  realized: RealizedEvent[]
): ActionEffect {
  const key = keyOf(action.isin, action.security_name);
  const pos = positions.get(key);
  const spec = specOf(String(action.action_type));
  const mechanism = mechanismOf(String(action.action_type));

  const before = pos ? totalQty(pos) : 0;
  const costBefore = pos ? totalCost(pos) : 0;

  const effect: ActionEffect = {
    action_id: action.id ?? null,
    isin: action.isin,
    security_name: action.security_name ?? pos?.name ?? null,
    action_type: String(action.action_type),
    ex_date: action.ex_date,
    applied: false,
    note: null,
    quantity_before: round(before, 4),
    quantity_after: round(before, 4),
    shares_received: 0,
    cost_before: round(costBefore),
    cost_moved: 0,
    target_isin: action.target_isin ?? null,
    target_quantity: 0,
    realized_gain: 0,
  };

  if (!spec) {
    effect.note = `Unknown action type "${action.action_type}".`;
    return effect;
  }

  // Delisting is the one action that does something to a position it does not
  // change: it flags it. Handled before the empty-holding check so a delisting
  // is still recorded against a security that has already been sold out of.
  if (action.action_type === "DELISTING") {
    if (pos) pos.delisted = true;
    effect.applied = Boolean(pos);
    effect.note = pos
      ? "Holding retained and flagged. No loss realised — nothing has been disposed of."
      : "No holding in this security, so there was nothing to flag.";
    return effect;
  }

  const needsHolding = mechanism !== "ENTITLEMENT" || !action.quantity;
  if ((!pos || before <= EPS) && needsHolding) {
    effect.note =
      "No holding in this security on the ex-date, so the action changed nothing. Check the ISIN and the date.";
    return effect;
  }

  if (mechanism === "RATIO") {
    const m = multiplierOf(action.ratio_from, action.ratio_to);
    if (m === null) {
      effect.note = "The ratio is missing or unusable, so nothing was applied.";
      return effect;
    }
    // Total cost is preserved: quantity scales up, cost per share scales down by
    // exactly the same factor. That is what makes a bonus tax-neutral on the day.
    for (const lot of pos!.lots) {
      lot.qty *= m;
      lot.costPerUnit /= m;
    }
    const after = totalQty(pos!);
    effect.applied = true;
    effect.quantity_after = round(after, 4);
    effect.shares_received = round(after - before, 4);
    return effect;
  }

  if (mechanism === "TRANSFER") {
    if (!action.target_isin) {
      effect.note = "No target security, so there was nowhere for the holding to go.";
      return effect;
    }

    // A demerger into several companies is one event, and its published
    // percentages are all of the *original* cost basis. Applying them one after
    // another against a shrinking balance would give the second company 12.23%
    // of what the first left behind — so the group is handled together, in
    // applyDemergerGroup, and this path only ever sees a single transfer.

    // A pure identity change moves the holding across untouched; everything else
    // converts at the stated ratio.
    const ratio =
      action.action_type === "TICKER_CHANGE"
        ? 1
        : multiplierOf(action.ratio_from, action.ratio_to);
    if (ratio === null) {
      effect.note = "The exchange ratio is missing or unusable, so nothing was applied.";
      return effect;
    }

    // A merger or a rename consumes the security, so all of its cost must move.
    // A demerger leaves the parent standing, so only the stated share moves.
    const fraction = spec.consumesSource ? 1 : Math.min(Math.max(Number(action.cost_fraction) || 0, 0), 1);

    const targetKey = keyOf(action.target_isin, action.target_security_name ?? null);
    let target = positions.get(targetKey);
    if (!target) {
      target = {
        key: targetKey,
        isin: action.target_isin,
        name: action.target_security_name ?? null,
        lots: [],
        delisted: false,
      };
      positions.set(targetKey, target);
    }

    let movedQty = 0;
    let movedCost = 0;

    for (const lot of pos!.lots) {
      const qty = lot.qty * ratio;
      if (qty <= EPS) continue;
      const cost = lot.qty * lot.costPerUnit * fraction;
      // The acquisition date travels with the shares. Under s.2(42A) the holding
      // period of the original shares counts towards the new ones in both a
      // demerger and an amalgamation, so resetting it here would silently turn
      // long-term gains into short-term ones.
      target.lots.push({ date: lot.date, qty, costPerUnit: cost / qty });
      lot.costPerUnit -= lot.costPerUnit * fraction;
      movedQty += qty;
      movedCost += cost;
    }

    if (spec.consumesSource) pos!.lots = [];

    // The receiving queue has to be in acquisition order or its FIFO is wrong.
    target.lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    effect.applied = movedQty > EPS;
    effect.note = effect.applied ? null : "The ratio produced no shares in the target security.";
    effect.quantity_after = round(totalQty(pos!), 4);
    effect.cost_moved = round(movedCost);
    effect.target_quantity = round(movedQty, 4);
    return effect;
  }

  if (mechanism === "ENTITLEMENT") {
    const m = multiplierOf(action.ratio_from, action.ratio_to);
    // An explicit quantity wins: rights are optional, and taking up fewer than
    // offered — or none — is the common case.
    const qty = Number(action.quantity) > 0 ? Number(action.quantity) : m === null ? 0 : before * m;
    if (qty <= EPS) {
      effect.note = "No shares were taken up, so nothing was added.";
      return effect;
    }

    const price = Number(action.price_per_share) || 0;
    let target = pos;
    if (!target) {
      target = {
        key,
        isin: action.isin,
        name: action.security_name ?? null,
        lots: [],
        delisted: false,
      };
      positions.set(key, target);
    }

    // A fresh acquisition on the ex-date: rights shares start their own holding
    // period, unlike bonus shares, which inherit the cost they dilute.
    target.lots.push({ date: action.ex_date, qty, costPerUnit: price });
    target.lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    effect.applied = true;
    effect.quantity_after = round(totalQty(target), 4);
    effect.shares_received = round(qty, 4);
    return effect;
  }

  if (mechanism === "EXIT") {
    const price = Number(action.price_per_share) || 0;
    const wanted =
      action.action_type === "LIQUIDATION"
        ? before
        : Math.min(Number(action.quantity) || 0, before);

    if (wanted <= EPS) {
      effect.note = "No quantity to close.";
      return effect;
    }

    const source: RealizedSource =
      action.action_type === "LIQUIDATION" ? "LIQUIDATION" : "BUYBACK";
    const gain = closeFifo(pos!, wanted, price, action.ex_date, source, realized);

    effect.applied = true;
    effect.quantity_after = round(totalQty(pos!), 4);
    effect.shares_received = round(-wanted, 4);
    effect.realized_gain = round(gain);
    return effect;
  }

  effect.note = "This action type has no effect on holdings.";
  return effect;
}

/**
 * A demerger of one company into several, applied as the single event it is.
 *
 * The percentages a scheme publishes are all shares of the cost basis *before*
 * the demerger — Vedanta's 2026 scheme, for instance, apportions 52.34% to the
 * parent and 7.15 / 12.23 / 21.49 / 6.79% to four resulting companies. Feeding
 * those to four independent transfers would take 12.23% of the 92.85% the first
 * one left, and so on down, and the last company would be short by a third. So
 * the original cost is snapshotted once and every target is paid out of it.
 *
 * The parent keeps whatever the fractions do not claim, which is the scheme's
 * own figure for it — nothing here has to be told the parent's percentage.
 */
function applyDemergerGroup(
  actions: CorporateActionRow[],
  positions: Map<string, Position>
): ActionEffect[] {
  const first = actions[0];
  const key = keyOf(first.isin, first.security_name);
  const pos = positions.get(key);
  const before = pos ? totalQty(pos) : 0;
  const costBefore = pos ? totalCost(pos) : 0;

  const base = (a: CorporateActionRow): ActionEffect => ({
    action_id: a.id ?? null,
    isin: a.isin,
    security_name: a.security_name ?? pos?.name ?? null,
    action_type: String(a.action_type),
    ex_date: a.ex_date,
    applied: false,
    note: null,
    quantity_before: round(before, 4),
    quantity_after: round(before, 4),
    shares_received: 0,
    cost_before: round(costBefore),
    cost_moved: 0,
    target_isin: a.target_isin ?? null,
    target_quantity: 0,
    realized_gain: 0,
  });

  if (!pos || before <= EPS) {
    return actions.map((a) => ({
      ...base(a),
      note:
        "No holding in this security on the ex-date, so the demerger changed nothing. Check the ISIN and the date.",
    }));
  }

  // Snapshot before anything moves. Every fraction below is a share of this.
  const original = pos.lots.map((l) => ({ lot: l, costPerUnit: l.costPerUnit }));
  const effects: ActionEffect[] = [];
  let claimed = 0;

  for (const action of actions) {
    const effect = base(action);
    const ratio = multiplierOf(action.ratio_from, action.ratio_to);

    if (!action.target_isin || ratio === null) {
      effect.note = !action.target_isin
        ? "No target security, so there was nowhere for the holding to go."
        : "The entitlement ratio is missing or unusable, so nothing was applied.";
      effects.push(effect);
      continue;
    }

    const fraction = Math.min(Math.max(Number(action.cost_fraction) || 0, 0), 1);
    const targetKey = keyOf(action.target_isin, action.target_security_name ?? null);
    let target = positions.get(targetKey);
    if (!target) {
      target = {
        key: targetKey,
        isin: action.target_isin,
        name: action.target_security_name ?? null,
        lots: [],
        delisted: false,
      };
      positions.set(targetKey, target);
    }

    let movedQty = 0;
    let movedCost = 0;

    for (const snap of original) {
      const qtyOut = snap.lot.qty * ratio;
      if (qtyOut <= EPS) continue;
      const cost = snap.lot.qty * snap.costPerUnit * fraction;
      // The acquisition date travels with the shares — s.2(42A) again.
      target.lots.push({ date: snap.lot.date, qty: qtyOut, costPerUnit: cost / qtyOut });
      movedQty += qtyOut;
      movedCost += cost;
    }

    target.lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    claimed += fraction;

    effect.applied = movedQty > EPS;
    effect.note = effect.applied ? null : "The ratio produced no shares in the target security.";
    effect.cost_moved = round(movedCost);
    effect.target_quantity = round(movedQty, 4);
    effects.push(effect);
  }

  // The parent keeps the unclaimed remainder, taken off the snapshot rather
  // than off whatever the loop above happened to leave behind.
  const retained = Math.min(Math.max(1 - claimed, 0), 1);
  for (const snap of original) snap.lot.costPerUnit = snap.costPerUnit * retained;

  const after = round(totalQty(pos), 4);
  for (const e of effects) e.quantity_after = after;
  return effects;
}

/**
 * Core engine. Returns current holdings, every realized (closed) lot event, and
 * what each corporate action did.
 */
export function computePortfolio(
  trades: TradeRow[],
  actions: CorporateActionRow[],
  /**
   * Stop after this ISO date, so the result is the book as it stood then.
   *
   * Needed to answer "how many shares did I hold on the ex-date", which is what
   * turns a published dividend-per-share into an amount received. It runs the
   * same engine rather than summing buys and sells, so the answer is adjusted
   * for any bonus or split that had already happened by then.
   */
  asOf?: string
): { holdings: Holding[]; realized: RealizedEvent[]; effects: ActionEffect[] } {
  const events: Ev[] = [];

  for (const t of trades) {
    if (!t.quantity || !t.side) continue;
    const perUnit =
      t.net_value != null && t.quantity
        ? Math.abs(t.net_value) / t.quantity
        : t.net_rate ?? t.gross_rate ?? 0;
    events.push({
      kind: "TRADE",
      date: t.trade_date,
      side: t.side,
      qty: t.quantity,
      valuePerUnit: perUnit,
      key: keyOf(t.isin, t.security_name),
      isin: t.isin || t.security_name || "UNKNOWN",
      name: t.security_name,
    });
  }

  // Demergers of the same security on the same date are one event; everything
  // else stands alone. Grouping here rather than in the loop keeps the ordering
  // logic below unaware of the distinction.
  const demergerGroups = new Map<string, CorporateActionRow[]>();
  for (const a of actions) {
    const key = keyOf(a.isin, a.security_name);
    if (String(a.action_type) === "DEMERGER") {
      const groupKey = `${key}|${a.ex_date}`;
      const group = demergerGroups.get(groupKey);
      if (group) {
        group.push(a);
        continue;
      }
      const started = [a];
      demergerGroups.set(groupKey, started);
      events.push({ kind: "ACTION", date: a.ex_date, actions: started, key });
      continue;
    }
    events.push({ kind: "ACTION", date: a.ex_date, actions: [a], key });
  }

  // Only when asked. Written as `const kept = asOf ? filter(...) : events`
  // first, which aliases the same array when asOf is absent — emptying it then
  // emptied the source too and every figure in the app came out zero.
  if (asOf) {
    const kept = events.filter((e) => e.date <= asOf);
    events.length = 0;
    events.push(...kept);
  }

  // Stable sort, so two actions on the same security and date stay in the order
  // they were given rather than swapping run to run.
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return evKey(a) - evKey(b);
  });

  const positions = new Map<string, Position>();
  const realized: RealizedEvent[] = [];
  const effects: ActionEffect[] = [];

  const ensure = (key: string, isin: string, name: string | null): Position => {
    let pos = positions.get(key);
    if (!pos) {
      pos = { key, isin, name, lots: [], delisted: false };
      positions.set(key, pos);
    }
    if (!pos.name && name) pos.name = name;
    return pos;
  };

  for (const e of events) {
    if (e.kind === "ACTION") {
      if (String(e.actions[0].action_type) === "DEMERGER") {
        effects.push(...applyDemergerGroup(e.actions, positions));
      } else {
        for (const a of e.actions) effects.push(applyAction(a, positions, realized));
      }
      continue;
    }

    const pos = ensure(e.key, e.isin, e.name);

    if (e.side === "BUY") {
      pos.lots.push({ date: e.date, qty: e.qty, costPerUnit: e.valuePerUnit });
    } else {
      // If the sell exceeds holdings (e.g. missing opening data) the unmatched
      // part is ignored rather than given an invented cost.
      closeFifo(pos, e.qty, e.valuePerUnit, e.date, "SELL", realized);
    }
  }

  const holdings: Holding[] = [];
  for (const pos of positions.values()) {
    const qty = totalQty(pos);
    if (qty <= EPS) continue;
    const invested = totalCost(pos);
    holdings.push({
      isin: pos.isin,
      security_name: pos.name,
      quantity: round(qty, 4),
      avg_cost: round(invested / qty, 4),
      invested: round(invested),
      delisted: pos.delisted,
    });
  }

  holdings.sort((a, b) => (a.security_name || "").localeCompare(b.security_name || ""));
  realized.sort((a, b) => (a.sell_date < b.sell_date ? -1 : 1));
  return { holdings, realized, effects };
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
        short_term_profit: 0,
        short_term_loss: 0,
        long_term_profit: 0,
        long_term_loss: 0,
        total_gain: 0,
        proceeds: 0,
        cost: 0,
        trades_closed: 0,
      };
      map.set(r.financial_year, row);
    }
    if (r.term === "LONG") {
      row.long_term_gain += r.gain;
      if (r.gain >= 0) row.long_term_profit += r.gain;
      else row.long_term_loss += -r.gain;
    } else {
      row.short_term_gain += r.gain;
      if (r.gain >= 0) row.short_term_profit += r.gain;
      else row.short_term_loss += -r.gain;
    }
    row.total_gain += r.gain;
    row.proceeds += r.proceeds;
    row.cost += r.cost;
    row.trades_closed += 1;
  }
  const rows = Array.from(map.values()).map((r) => ({
    ...r,
    short_term_gain: round(r.short_term_gain),
    long_term_gain: round(r.long_term_gain),
    short_term_profit: round(r.short_term_profit),
    short_term_loss: round(r.short_term_loss),
    long_term_profit: round(r.long_term_profit),
    long_term_loss: round(r.long_term_loss),
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

export interface SharesFromActions {
  bonus: number;
  split: number;
  demerger: number;
  rights: number;
  /** Shares given up to buybacks and liquidations, as a positive number. */
  closed: number;
}

/**
 * Table 6 of the spec wants "Bonus / Split / Demerger Shares Received" as
 * standing totals. They come from what the actions actually did, not from what
 * was entered — an action against a security you did not hold contributes zero.
 */
export function sharesFromActions(effects: ActionEffect[]): SharesFromActions {
  const out: SharesFromActions = { bonus: 0, split: 0, demerger: 0, rights: 0, closed: 0 };
  for (const e of effects) {
    if (!e.applied) continue;
    switch (e.action_type) {
      case "BONUS":
        out.bonus += e.shares_received;
        break;
      case "SPLIT":
      case "REVERSE_SPLIT":
        out.split += e.shares_received;
        break;
      case "DEMERGER":
        out.demerger += e.target_quantity;
        break;
      case "RIGHTS_ISSUE":
        out.rights += e.shares_received;
        break;
      case "BUYBACK":
      case "LIQUIDATION":
        out.closed += -e.shares_received;
        break;
    }
  }
  return {
    bonus: round(out.bonus, 4),
    split: round(out.split, 4),
    demerger: round(out.demerger, 4),
    rights: round(out.rights, 4),
    closed: round(out.closed, 4),
  };
}
