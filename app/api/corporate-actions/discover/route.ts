import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
  PortfolioFilter,
} from "@/app/lib/store";
import { ParsedAction, RawAction, fetchBse, fetchNse, parseSubject } from "@/app/lib/sources/exchange";
import { specOf } from "@/app/lib/corporate-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The NSE pull is a couple of megabytes and BSE's fallback is deliberately
// throttled, so this is slower than anything else in the app.
export const maxDuration = 300;

/**
 * Find corporate actions the exchanges published for securities you have traded.
 *
 * Read-only and explicitly triggered — see the note at the top of
 * `app/lib/sources/exchange.ts` about why this is the one call that leaves the
 * machine on purpose. Nothing here is written to the database; every row comes
 * back as a candidate for a person to accept, reject, or complete by hand.
 */

interface Candidate {
  isin: string;
  security_name: string | null;
  symbol: string | null;
  ex_date: string;
  /** The exchange's own words, kept so a parse can be checked against them. */
  subject: string;
  sources: string[];
  parsed: ParsedAction | null;
  /** How many shares the trades say you held on the ex-date. */
  quantity_on_date: number;
  already_recorded: boolean;
}

export async function GET(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const params = new URL(req.url).searchParams;
  const accounts = params.get("accounts");
  const filter: PortfolioFilter | undefined = accounts
    ? { accountIds: accounts.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

  const store = await getStore();

  let trades: Awaited<ReturnType<typeof store.listTrades>>;
  let existing: Awaited<ReturnType<typeof store.listCorporateActions>>;
  try {
    [trades, existing] = await Promise.all([store.listTrades(filter), store.listCorporateActions()]);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  // Only ask about securities that have actually been traded. Fetching the
  // whole market and showing it would bury the handful of rows that matter.
  const isins = Array.from(
    new Set(trades.map((t) => t.isin).filter((i): i is string => Boolean(i)))
  );
  if (isins.length === 0) {
    return NextResponse.json({
      candidates: [],
      isins: 0,
      message: "No trades with an ISIN yet, so there is nothing to look up.",
    });
  }

  const dates = trades.map((t) => t.trade_date).filter(Boolean).sort();
  // Default range: from the first trade to today. An action before you owned
  // anything cannot have affected you.
  const from = params.get("from") || dates[0] || "2000-01-01";
  const to = params.get("to") || new Date().toISOString().slice(0, 10);
  if (from > to) {
    return NextResponse.json({ error: "The start date is after the end date." }, { status: 400 });
  }

  const wanted = new Set(isins);
  const raw: RawAction[] = [];
  const used: string[] = [];
  const problems: string[] = [];

  // NSE first: it carries the ISIN on every row and answers a whole date range
  // in one request. BSE is the fallback, one request per holding.
  try {
    const rows = await fetchNse(from, to);
    raw.push(...rows.filter((r) => r.isin && wanted.has(r.isin)));
    used.push("NSE");
  } catch (err: any) {
    problems.push(`NSE could not be reached (${err.message}).`);
  }

  if (raw.length === 0) {
    try {
      raw.push(...(await fetchBse(isins, from, to)));
      used.push("BSE");
    } catch (err: any) {
      problems.push(`BSE could not be reached (${err.message}).`);
    }
  }

  if (used.length === 0) {
    return NextResponse.json(
      {
        error:
          "Neither exchange could be reached. This needs a working internet connection; nothing else in the app does.",
        problems,
      },
      { status: 502 }
    );
  }

  // Quantity held on a date, from trades alone. It ignores any corporate action
  // that came before, so treat it as "did you hold this at all", not as a
  // precise figure — the real number comes from the engine once accepted.
  const quantityOn = (isin: string, date: string): number =>
    trades.reduce(
      (sum, t) =>
        t.isin === isin && t.trade_date <= date
          ? sum + (t.side === "SELL" ? -t.quantity : t.quantity)
          : sum,
      0
    );

  const recorded = new Set(
    existing.map((a) => `${a.isin}|${a.action_type}|${a.ex_date}`)
  );

  const byKey = new Map<string, Candidate>();

  for (const row of raw) {
    if (!row.isin || !row.ex_date) continue;
    const parsed = parseSubject(row.subject, row.face_value);
    // parseSubject returns null for meetings, interest payments and dividends —
    // the majority of the feed, and none of it a corporate action on equity.
    if (!parsed) continue;

    const key = `${row.isin}|${parsed.action_type}|${row.ex_date}`;
    const found = byKey.get(key);
    if (found) {
      if (!found.sources.includes(row.source)) found.sources.push(row.source);
      continue;
    }

    byKey.set(key, {
      isin: row.isin,
      security_name: row.security_name,
      symbol: row.symbol,
      ex_date: row.ex_date,
      subject: row.subject,
      sources: [row.source],
      parsed,
      quantity_on_date: Math.round(quantityOn(row.isin, row.ex_date) * 10000) / 10000,
      already_recorded: recorded.has(key),
    });
  }

  const candidates = Array.from(byKey.values()).sort((a, b) =>
    a.ex_date < b.ex_date ? 1 : a.ex_date > b.ex_date ? -1 : 0
  );

  return NextResponse.json({
    candidates,
    from,
    to,
    isins: isins.length,
    sources: used,
    problems,
    counts: {
      total: candidates.length,
      held: candidates.filter((c) => c.quantity_on_date > 0).length,
      exact: candidates.filter((c) => c.parsed?.confidence === "exact").length,
      already: candidates.filter((c) => c.already_recorded).length,
    },
    // Echoed so the page can label a type without repeating the taxonomy.
    labels: Object.fromEntries(
      candidates
        .map((c) => c.parsed!.action_type)
        .map((t) => [t, specOf(t)?.label ?? t])
    ),
  });
}
