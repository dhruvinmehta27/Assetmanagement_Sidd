import { NextRequest, NextResponse } from "next/server";
import { getStore, isStorageConfigured, storageNotConfiguredMessage } from "@/app/lib/store";
import { fetchPrices } from "@/app/lib/sources/prices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One request per holding, deliberately spaced.
export const maxDuration = 300;

/**
 * GET  — the prices already stored, with no network access at all.
 * POST — go and refresh them, then store and return them.
 *
 * Split so that every page can show a valuation instantly and offline, and only
 * an explicit press reaches the internet. A price request names a security, so
 * it should never be something a page does on its own.
 */
export async function GET() {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  try {
    const store = await getStore();
    const prices = await store.listPrices();
    return NextResponse.json({
      prices,
      // The oldest price is the one that decides whether a valuation is stale.
      as_of: prices.length ? prices.map((p) => p.as_of).sort()[0] : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const store = await getStore();

  let isins: string[] = [];
  try {
    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.isins)) {
      isins = body.isins.filter((i: unknown) => typeof i === "string" && i.trim());
    }
  } catch {
    // An empty body is fine — it means "everything held".
  }

  if (isins.length === 0) {
    // Everything ever traded, not just what is held now: a security sold out of
    // during the year still needs a price for nothing, but one held under a
    // different account filter does.
    const trades = await store.listTrades();
    isins = Array.from(new Set(trades.map((t) => t.isin).filter((i): i is string => Boolean(i))));
  }

  if (isins.length === 0) {
    return NextResponse.json({ prices: [], failures: [], message: "Nothing to price yet." });
  }

  try {
    const { quotes, failures } = await fetchPrices(isins);
    if (quotes.length > 0) await store.savePrices(quotes);
    return NextResponse.json({
      prices: await store.listPrices(),
      fetched: quotes.length,
      failures,
      as_of: quotes.length ? quotes[0].as_of : null,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Prices could not be fetched: ${err.message}` },
      { status: 502 }
    );
  }
}
