import { NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
  PortfolioFilter,
} from "@/app/lib/store";
import {
  CorporateActionRow,
  DividendRow,
  TradeRow,
  pnlByFinancialYear,
  sharesFromActions,
  unrealisedByTerm,
} from "@/app/lib/analytics";
import { computeAcrossAccounts } from "@/app/lib/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Table 6 of the spec: the master summary, one row per account.
 *
 * Capital employed, dividends received, shares received from corporate actions,
 * realised gains, current valuation, and what the spec calls Net Capital
 * Employed — `= L-K-J-I-H-G-F-E`, which is the valuation less everything that
 * went in and everything already taken out.
 *
 * Reads stored prices; it never fetches. Refreshing them is a deliberate press
 * on the page, so a stale valuation is visible as stale rather than silently
 * refreshed behind a figure someone is about to rely on.
 */
export async function GET(req: Request) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const requested = new URL(req.url).searchParams.get("accounts");
  const filter: PortfolioFilter | undefined = requested
    ? { accountIds: requested.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

  const store = await getStore();

  let accounts: Awaited<ReturnType<typeof store.listAccounts>>;
  let prices: Awaited<ReturnType<typeof store.listPrices>>;
  try {
    [accounts, prices] = await Promise.all([store.listAccounts(), store.listPrices()]);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  const priceMap = new Map(prices.map((p) => [p.isin, p.price]));
  const priceOf = (isin: string) => priceMap.get(isin) ?? null;

  const scope = filter?.accountIds?.length
    ? accounts.filter((a) => filter!.accountIds!.includes(a.id))
    : accounts;

  const rows = [];
  for (const account of scope) {
    const one: PortfolioFilter = { accountIds: [account.id] };
    const [trades, actions, dividends, notes] = (await Promise.all([
      store.listTrades(one),
      store.listCorporateActions(),
      store.listDividends(one),
      store.countContractNotes(one),
    ])) as [TradeRow[], CorporateActionRow[], DividendRow[], number];

    const { holdings, realized, effects } = computeAcrossAccounts(trades as any, actions);
    const pnl = pnlByFinancialYear(realized);
    const shares = sharesFromActions(effects);
    const unrealised = unrealisedByTerm(holdings, priceOf);

    // Table 6 E: what was put in. Cost of what is still held — the cost of what
    // was sold has already come back out as proceeds.
    const capitalEmployed = holdings.reduce((s, h) => s + h.invested, 0);
    const dividendTotal = dividends.reduce((s, d) => s + (d.net_amount ?? d.gross_amount ?? 0), 0);
    const realisedLong = pnl.reduce((s, p) => s + p.long_term_gain, 0);
    const realisedShort = pnl.reduce((s, p) => s + p.short_term_gain, 0);
    const valuation = unrealised.market_value;

    rows.push({
      account_id: account.id,
      label: account.label,
      entity_type: account.entity_type,
      notes,
      holdings: holdings.length,
      capital_employed: round(capitalEmployed),
      dividends: round(dividendTotal),
      bonus_shares: shares.bonus,
      split_shares: shares.split,
      demerger_shares: shares.demerger,
      rights_shares: shares.rights,
      realised_ltcg: round(realisedLong),
      realised_stcg: round(realisedShort),
      valuation: round(valuation),
      /**
       * Table 6 M. The spec's formula subtracts every other column from the
       * valuation. Share counts (G, H, I) are quantities and not money, so
       * including them would be adding apples to rupees — they are reported but
       * left out of the arithmetic.
       */
      net_capital_employed: round(
        valuation - realisedShort - realisedLong - dividendTotal - capitalEmployed
      ),
      /** Cost that could not be valued, so the figures above are known to be short. */
      unpriced_cost: unrealised.unpriced_cost,
      unpriced: unrealised.unpriced,
      unrealised,
    });
  }

  return NextResponse.json({
    rows,
    accounts,
    accountsSupported: store.accountsSupported,
    prices: prices.length,
    priced_as_of: prices.length ? prices.map((p) => p.as_of).sort()[0] : null,
    note:
      "Share counts from corporate actions are quantities, not money, so they are shown but excluded from Net Capital Employed.",
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
