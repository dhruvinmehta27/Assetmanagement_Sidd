import { NextResponse } from "next/server";
import {
  Account,
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
  UnassignedGroup,
} from "@/app/lib/store";
import {
  ActionEffect,
  computePortfolio,
  pnlByFinancialYear,
  aggregateDividends,
  sharesFromActions,
  TradeRow,
  CorporateActionRow,
  DividendRow,
} from "@/app/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compute the full portfolio view: holdings, realized P&L per financial year,
 * and dividends per financial year — from all stored trades, corporate actions
 * and dividends.
 */
export async function GET(req: Request) {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });
  }

  const store = await getStore();

  // ?accounts=id,id — omitted means every assigned account. Unassigned notes are
  // never included: FIFO across two people's trades produces nonsense.
  const requested = new URL(req.url).searchParams.get("accounts");
  const filter = requested
    ? { accountIds: requested.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

  let trades: TradeRow[];
  let actions: CorporateActionRow[];
  let dividends: DividendRow[];
  let notes: number;
  let accounts: Awaited<ReturnType<typeof store.listAccounts>>;
  let unassigned: Awaited<ReturnType<typeof store.listUnassigned>>;

  try {
    [trades, actions, dividends, notes, accounts, unassigned] = (await Promise.all([
      store.listTrades(filter),
      store.listCorporateActions(),
      store.listDividends(filter),
      store.countContractNotes(filter),
      store.listAccounts(),
      store.listUnassigned(),
    ])) as [
      TradeRow[],
      CorporateActionRow[],
      DividendRow[],
      number,
      Account[],
      UnassignedGroup[]
    ];
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  const { holdings, realized, effects } = computeAcrossAccounts(trades, actions);
  const pnl = pnlByFinancialYear(realized);
  const dividendsByFY = aggregateDividends(dividends);
  // Table 6 of the spec: bonus / split / demerger shares received. Taken from
  // what the actions did to real holdings, not from what was typed in.
  const sharesReceived = sharesFromActions(effects);

  const totalInvested = holdings.reduce((s, h) => s + h.invested, 0);
  const totalRealized = realized.reduce((s, r) => s + r.gain, 0);
  const totalDividends = dividends.reduce(
    (s, d) => s + (d.net_amount ?? d.gross_amount ?? 0),
    0
  );

  return NextResponse.json({
    summary: {
      notes,
      trades: trades.length,
      holdings: holdings.length,
      total_invested: round(totalInvested),
      total_realized: round(totalRealized),
      total_dividends: round(totalDividends),
      shares_received: sharesReceived,
    },
    // Where this data physically lives, so the page can say so rather than
    // leaving the user to guess whether anything left the machine.
    storage: store.info(),
    accountsSupported: store.accountsSupported,
    accounts,
    selectedAccounts: filter?.accountIds ?? null,
    // Imported but claimed by nobody, so deliberately absent from every figure
    // above. The page says so loudly rather than quietly under-reporting.
    unassigned: {
      groups: unassigned,
      notes: unassigned.reduce((s, g) => s + g.notes, 0),
      trades: unassigned.reduce((s, g) => s + g.trades, 0),
    },
    holdings,
    pnl,
    realized,
    dividends,
    dividendsByFY,
    corporateActions: actions,
    // What each action actually did once applied to these holdings. The only
    // way to see that a ratio was entered the wrong way round.
    actionEffects: effects,
  });
}

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
function computeAcrossAccounts(
  trades: (TradeRow & { account_id?: string | null })[],
  actions: CorporateActionRow[]
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
    const result = computePortfolio(rows, actions);
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
function mergeEffects(effects: ActionEffect[]): ActionEffect[] {
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
