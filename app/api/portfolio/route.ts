import { NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/app/lib/supabase";
import {
  computePortfolio,
  pnlByFinancialYear,
  aggregateDividends,
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
export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Supabase is not configured." },
      { status: 500 }
    );
  }

  const sb = getSupabase();

  const [tradesRes, actionsRes, divRes, notesRes] = await Promise.all([
    sb.from("trades").select("*").order("trade_date", { ascending: true }),
    sb.from("corporate_actions").select("*"),
    sb.from("dividends").select("*"),
    sb.from("contract_notes").select("id", { count: "exact", head: true }),
  ]);

  if (tradesRes.error) {
    return NextResponse.json(
      { error: `Failed to read trades: ${tradesRes.error.message}` },
      { status: 500 }
    );
  }

  const trades = (tradesRes.data ?? []) as TradeRow[];
  const actions = (actionsRes.data ?? []) as CorporateActionRow[];
  const dividends = (divRes.data ?? []) as DividendRow[];

  const { holdings, realized } = computePortfolio(trades, actions);
  const pnl = pnlByFinancialYear(realized);
  const dividendsByFY = aggregateDividends(dividends);

  const totalInvested = holdings.reduce((s, h) => s + h.invested, 0);
  const totalRealized = realized.reduce((s, r) => s + r.gain, 0);
  const totalDividends = dividends.reduce(
    (s, d) => s + (d.net_amount ?? d.gross_amount ?? 0),
    0
  );

  return NextResponse.json({
    summary: {
      notes: notesRes.count ?? 0,
      trades: trades.length,
      holdings: holdings.length,
      total_invested: round(totalInvested),
      total_realized: round(totalRealized),
      total_dividends: round(totalDividends),
    },
    holdings,
    pnl,
    realized,
    dividends,
    dividendsByFY,
    corporateActions: actions,
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
