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
import { computeAcrossAccounts } from "@/app/lib/portfolio";

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
