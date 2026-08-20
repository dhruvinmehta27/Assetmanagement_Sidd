import { fetchBseMaster } from "@/app/lib/sources/exchange";

/**
 * Last traded prices, from BSE.
 *
 * The third and last thing in this app that reaches the internet, and the only
 * one that is about a holding rather than an event — which makes it the most
 * revealing: a price request names the security. Like the others it runs on a
 * button, never on a schedule and never on page load.
 *
 * BSE rather than NSE because its quote endpoint answers cold, with no session,
 * exactly as its corporate-action endpoint does — and because the scrip master
 * the corporate-action lookup already downloads gives the ISIN-to-scrip-code
 * mapping for free. Checked against a real 24-holding portfolio: everything
 * priced, including the ETFs and four companies that had listed weeks earlier.
 *
 * A price is a fact with a timestamp. Everything here carries when it was taken,
 * because a stale price presented as current is worse than no price.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const BSE_QUOTE = "https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w";

export interface Quote {
  isin: string;
  price: number;
  change_percent: number | null;
  security_name: string | null;
  source: string;
  as_of: string;
}

export interface QuoteFailure {
  isin: string;
  reason: string;
}

/**
 * Prices for a list of ISINs, one request each, spaced out.
 *
 * There is no bulk quote endpoint, so a 24-holding portfolio is 24 requests.
 * They are deliberately unhurried — this is someone else's server and nothing
 * here is time-critical.
 */
export async function fetchPrices(
  isins: string[]
): Promise<{ quotes: Quote[]; failures: QuoteFailure[] }> {
  const master = await fetchBseMaster();
  const quotes: Quote[] = [];
  const failures: QuoteFailure[] = [];
  const takenAt = new Date().toISOString();

  for (const isin of isins) {
    const entry = master.get(isin);
    if (!entry) {
      failures.push({ isin, reason: "Not in the BSE scrip master — it may be unlisted or delisted." });
      continue;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let data: any;
      try {
        const res = await fetch(
          `${BSE_QUOTE}?Debtflag=&scripcode=${encodeURIComponent(entry.code)}&seriesid=`,
          {
            signal: controller.signal,
            headers: { "User-Agent": UA, Referer: "https://www.bseindia.com/", Accept: "application/json" },
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }

      const price = Number(data?.CurrRate?.LTP);
      if (!Number.isFinite(price) || price <= 0) {
        // A suspended or delisted scrip answers with an empty rate rather than
        // an error, so this is a normal outcome and not a fault.
        failures.push({ isin, reason: "No last traded price — the scrip may be suspended or delisted." });
      } else {
        const pc = Number(data?.CurrRate?.PcChg);
        quotes.push({
          isin,
          price,
          change_percent: Number.isFinite(pc) ? pc : null,
          security_name: data?.Cmpname?.FullN?.trim() || entry.name,
          source: "BSE",
          as_of: takenAt,
        });
      }
    } catch (err: any) {
      failures.push({ isin, reason: err?.message || "Could not be reached." });
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return { quotes, failures };
}
