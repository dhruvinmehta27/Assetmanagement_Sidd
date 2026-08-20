import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";
import { CorporateActionRow, TradeRow } from "@/app/lib/analytics";
import { computeAcrossAccounts } from "@/app/lib/portfolio";
import { fetchNse, parseDividend } from "@/app/lib/sources/exchange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Table 5 of the spec: dividends, from the feed the app already fetches.
 *
 * The exchange publishes an amount per share and an ex-date. The missing half —
 * how many shares were held on that date — is something only this app knows, and
 * it is not a matter of adding up buys and sells: a bonus or a split before the
 * ex-date changes the answer. So the quantity comes from running the FIFO engine
 * as at the ex-date, which is corporate-action adjusted by construction.
 *
 * Proposals only. Nothing is written, for the same reason as corporate actions:
 * the figure is read out of a line of English, and a dividend that was never
 * received is worse than a dividend nobody recorded.
 */
export async function GET(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const params = new URL(req.url).searchParams;
  const requested = params.get("accounts");
  const filter = requested
    ? { accountIds: requested.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

  const store = await getStore();

  let trades: TradeRow[] & { account_id?: string | null }[];
  let actions: CorporateActionRow[];
  let existing: Awaited<ReturnType<typeof store.listDividends>>;
  let accounts: Awaited<ReturnType<typeof store.listAccounts>>;

  try {
    [trades, actions, existing, accounts] = (await Promise.all([
      store.listTrades(filter),
      store.listCorporateActions(),
      store.listDividends(filter),
      store.listAccounts(),
    ])) as any;
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  const isins = Array.from(
    new Set(trades.map((t) => t.isin).filter((i): i is string => Boolean(i)))
  );
  if (isins.length === 0) {
    return NextResponse.json({ candidates: [], isins: 0, message: "No trades with an ISIN yet." });
  }

  const dates = trades.map((t) => t.trade_date).filter(Boolean).sort();
  const from = params.get("from") || dates[0] || "2000-01-01";
  const to = params.get("to") || new Date().toISOString().slice(0, 10);

  let rows;
  try {
    rows = await fetchNse(from, to);
  } catch (err: any) {
    return NextResponse.json(
      { error: `NSE could not be reached (${err.message}). This is the only part of the app that needs the internet.` },
      { status: 502 }
    );
  }

  const wanted = new Set(isins);
  const already = new Set(
    existing.map((d) => `${d.isin}|${d.ex_date ?? ""}|${d.account_id ?? ""}`)
  );

  // Holdings as at a date, cached — a year of dividends is many ex-dates but
  // only a handful of distinct ones, and each run of the engine is not free.
  const asOfCache = new Map<string, Map<string, { qty: number; name: string | null }>>();
  const holdingsOn = (date: string) => {
    let m = asOfCache.get(date);
    if (!m) {
      const { holdings } = computeAcrossAccounts(trades as any, actions, date);
      m = new Map(holdings.map((h) => [h.isin, { qty: h.quantity, name: h.security_name }]));
      asOfCache.set(date, m);
    }
    return m;
  };

  const candidates = [];
  for (const row of rows) {
    if (!row.isin || !row.ex_date || !wanted.has(row.isin)) continue;
    const parsed = parseDividend(row.subject);
    if (!parsed) continue;

    const held = holdingsOn(row.ex_date).get(row.isin);
    const quantity = held?.qty ?? 0;

    candidates.push({
      isin: row.isin,
      security_name: row.security_name || held?.name || null,
      symbol: row.symbol,
      ex_date: row.ex_date,
      subject: row.subject,
      kind: parsed.kind,
      amount_per_share: parsed.amount_per_share,
      quantity,
      gross_amount: Math.round(quantity * parsed.amount_per_share * 100) / 100,
      already_recorded: already.has(`${row.isin}|${row.ex_date}|`) ||
        [...already].some((k) => k.startsWith(`${row.isin}|${row.ex_date}|`)),
    });
  }

  candidates.sort((a, b) => (a.ex_date < b.ex_date ? 1 : a.ex_date > b.ex_date ? -1 : 0));
  const held = candidates.filter((c) => c.quantity > 0);

  return NextResponse.json({
    candidates,
    from,
    to,
    isins: isins.length,
    accounts,
    accountsSupported: store.accountsSupported,
    counts: {
      total: candidates.length,
      held: held.length,
      already: candidates.filter((c) => c.already_recorded).length,
      gross: Math.round(held.reduce((s, c) => s + c.gross_amount, 0) * 100) / 100,
    },
    note:
      "Quantity is the holding on the ex-date, computed by the same engine as the portfolio — so it already accounts for any bonus or split before that date. TDS is not published here; add it from Form 26AS if you need the net figure.",
  });
}
