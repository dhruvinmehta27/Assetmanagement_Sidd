import { NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
  PortfolioFilter,
} from "@/app/lib/store";
import {
  aggregateDividends,
  CorporateActionRow,
  DividendRow,
  finYear,
  pnlByFinancialYear,
  TradeRow,
} from "@/app/lib/analytics";
import { computeAcrossAccounts } from "@/app/lib/portfolio";
import { computeTax, costsByFinancialYear, ratesFor, SetOffMode } from "@/app/lib/tax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Table 2 of the spec: the profit and loss statement, per financial year.
 *
 * Realised gains split into profit and loss, losses set off, the long-term
 * exemption applied, and tax computed. Everything comes from stored data — no
 * network, no market prices.
 *
 * The unrealised rows (Table 2 O–R) are absent on purpose: they need today's
 * price for every holding, which nothing in this app knows.
 */
export async function GET(req: Request) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const params = new URL(req.url).searchParams;
  const requested = params.get("accounts");
  const filter: PortfolioFilter | undefined = requested
    ? { accountIds: requested.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

  // Both set-off readings are computed every time so the page can show the
  // difference rather than make the user re-run it. See app/lib/tax.ts.
  const modeParam = params.get("mode");
  const mode: SetOffMode = modeParam === "spreadsheet" ? "spreadsheet" : "law";

  const store = await getStore();

  let trades: TradeRow[];
  let actions: CorporateActionRow[];
  let dividends: DividendRow[];
  let notes: Awaited<ReturnType<typeof store.listNotesWithTrades>>;
  let accounts: Awaited<ReturnType<typeof store.listAccounts>>;

  try {
    [trades, actions, dividends, notes, accounts] = (await Promise.all([
      store.listTrades(filter),
      store.listCorporateActions(),
      store.listDividends(filter),
      store.listNotesWithTrades(filter),
      store.listAccounts(),
    ])) as any;
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  const { realized } = computeAcrossAccounts(trades, actions);
  const pnl = pnlByFinancialYear(realized);
  const costs = costsByFinancialYear(notes as any, finYear);
  const dividendsByFY = aggregateDividends(dividends);

  const costsByYear = new Map(costs.map((c) => [c.financial_year, c]));
  const divByYear = new Map(dividendsByFY.map((d) => [d.financial_year, d]));

  // A year with charges but no closed lot still belongs in the statement — it
  // had costs, and its absence would read as "nothing happened".
  const years = Array.from(
    new Set([...pnl.map((p) => p.financial_year), ...costs.map((c) => c.financial_year)])
  ).sort();

  const empty = (financial_year: string) => ({
    financial_year,
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
  });

  const rows = years.map((fy) => {
    const p = pnl.find((x) => x.financial_year === fy) ?? empty(fy);
    const c = costsByYear.get(fy);
    const d = divByYear.get(fy);
    return {
      financial_year: fy,
      pnl: p,
      tax: computeTax(p, mode),
      // The other reading, so the page can say what it would have cost.
      tax_other: computeTax(p, mode === "law" ? "spreadsheet" : "law"),
      rates: ratesFor(fy),
      brokerage: c?.brokerage ?? 0,
      other_expenses: c?.other_expenses ?? 0,
      notes: c?.notes ?? 0,
      dividends: d?.total_net ?? 0,
      dividends_gross: d?.total_gross ?? 0,
      dividends_tds: d?.total_tds ?? 0,
    };
  });

  return NextResponse.json({
    years: rows,
    mode,
    accounts,
    accountsSupported: store.accountsSupported,
    selectedAccounts: filter?.accountIds ?? null,
    /**
     * Said out loud rather than left for someone to discover: this is a working
     * of listed-equity capital gains only.
     */
    caveats: [
      "Listed equity with STT paid. No debt, property, business income or F&O.",
      "No carry-forward of losses from earlier years, and no surcharge or rebate.",
      "Unrealised gains are not shown — that needs today's market prices, which this app does not fetch.",
      "Dividends are taxed at your slab rate, so they are reported here but not taxed.",
    ],
  });
}
