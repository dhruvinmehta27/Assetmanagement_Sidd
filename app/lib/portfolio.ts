import {
  ActionEffect,
  computePortfolio,
  CorporateActionRow,
  TradeRow,
} from "@/app/lib/analytics";

/**
 * Running the engine across several people's trades.
 *
 * Extracted from the portfolio route so the P&L statement computes gains the
 * same way rather than growing its own copy — two implementations of FIFO is
 * two answers to the same question.
 */

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Run the FIFO engine once per account and merge the results.
 *
 * Never hand it two people's trades in one array: FIFO would match one person's
 * sale against another's buy lots, inventing a gain that belongs to nobody and
 * leaving the wrong cost basis behind. Merging *outputs* is safe — quantities
 * and amounts simply add up, and realized events already carry their own dates.
 */
export function computeAcrossAccounts(
  trades: (TradeRow & { account_id?: string | null })[],
  actions: CorporateActionRow[],
  asOf?: string
) {
  const byAccount = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = t.account_id ?? "__unassigned__";
    const bucket = byAccount.get(key);
    if (bucket) bucket.push(t);
    else byAccount.set(key, [t]);
  }

  const merged = new Map<
    string,
    {
      isin: string;
      security_name: string | null;
      quantity: number;
      invested: number;
      delisted: boolean;
    }
  >();
  const realized: ReturnType<typeof computePortfolio>["realized"] = [];
  const effects: ActionEffect[] = [];

  for (const rows of byAccount.values()) {
    const result = computePortfolio(rows, actions, asOf);
    realized.push(...result.realized);
    effects.push(...result.effects);

    for (const h of result.holdings) {
      const existing = merged.get(h.isin);
      if (existing) {
        existing.quantity += h.quantity;
        existing.invested += h.invested;
        existing.delisted = existing.delisted || Boolean(h.delisted);
      } else {
        merged.set(h.isin, {
          isin: h.isin,
          security_name: h.security_name,
          quantity: h.quantity,
          invested: h.invested,
          delisted: Boolean(h.delisted),
        });
      }
    }
  }

  const holdings = Array.from(merged.values())
    .map((h) => ({
      ...h,
      quantity: round(h.quantity),
      invested: round(h.invested),
      avg_cost: h.quantity ? Math.round((h.invested / h.quantity) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => (a.security_name || "").localeCompare(b.security_name || ""));

  realized.sort((a, b) => (a.sell_date < b.sell_date ? -1 : 1));
  return { holdings, realized, effects: mergeEffects(effects) };
}

/**
 * One row per action, not one per account.
 *
 * Each account's run reports the same action separately, because each holds a
 * different quantity of the security. Someone reading the page wants to know
 * what a bonus did to the portfolio, so the quantities add up — but `applied`
 * has to be an OR, not an AND: an action that moved one account's holding and
 * not another's did happen.
 */
export function mergeEffects(effects: ActionEffect[]): ActionEffect[] {
  const byAction = new Map<string, ActionEffect>();

  for (const e of effects) {
    const key = e.action_id ?? `${e.isin}|${e.action_type}|${e.ex_date}`;
    const existing = byAction.get(key);
    if (!existing) {
      byAction.set(key, { ...e });
      continue;
    }
    existing.quantity_before += e.quantity_before;
    existing.quantity_after += e.quantity_after;
    existing.shares_received += e.shares_received;
    existing.cost_before += e.cost_before;
    existing.cost_moved += e.cost_moved;
    existing.target_quantity += e.target_quantity;
    existing.realized_gain += e.realized_gain;
    if (e.applied) {
      existing.applied = true;
      // Keep the note only while nothing has applied anywhere; once something
      // did, "no holding in this security" is misleading.
      existing.note = null;
    } else if (!existing.applied && !existing.note) {
      existing.note = e.note;
    }
  }

  return Array.from(byAction.values()).sort((a, b) =>
    a.ex_date < b.ex_date ? -1 : a.ex_date > b.ex_date ? 1 : 0
  );
}
