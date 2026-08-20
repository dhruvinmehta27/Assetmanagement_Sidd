import { ActionType } from "@/app/lib/corporate-actions";

/**
 * Corporate actions from the exchanges.
 *
 * This is the app's only outbound call besides the Claude API, and it is the one
 * place where the "nothing leaves this machine" property is broken on purpose:
 * asking an exchange about an ISIN tells it you are interested in that security.
 * So it never runs on its own — it runs when someone presses the button.
 *
 * **NSE is primary.** Its feed carries the ISIN on every row, so no symbol or
 * scrip-code mapping is needed, and one request returns every equity action in a
 * date range (~5,500 rows for two and a half years) rather than one request per
 * holding. **BSE is the fallback**, reached through a scrip master that maps
 * ISIN to scrip code. Either is sufficient on its own: a bonus is a fact about a
 * company, not about an exchange, so a holding bought on one exchange still
 * finds its actions on the other.
 *
 * Nothing here writes to the database. Everything it returns is a *candidate*
 * for a person to accept, because the ratio it parses out of a line of English
 * is exactly the value that corrupts a cost basis for good if it is wrong.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const NSE_ENDPOINT = "https://www.nseindia.com/api/corporates-corporateActions";
const BSE_MASTER =
  "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active";
const BSE_ACTIONS = "https://api.bseindia.com/BseIndiaAPI/api/CorporateAction/w";

/** A row as the exchange published it, before any interpretation. */
export interface RawAction {
  isin: string | null;
  symbol: string | null;
  security_name: string | null;
  /** ISO date. */
  ex_date: string | null;
  /** The exchange's own words. Kept verbatim so a parse can be second-guessed. */
  subject: string;
  face_value: number | null;
  source: "NSE" | "BSE";
}

/** What we managed to read out of `subject`. */
export interface ParsedAction {
  action_type: ActionType;
  ratio_from: number | null;
  ratio_to: number | null;
  price_per_share: number | null;
  /**
   * exact   — type and every number needed are present; safe to accept as is.
   * partial — the type is clear but a required number is not published here.
   * none    — recognised as a corporate action but not one we model.
   */
  confidence: "exact" | "partial" | "none";
  /** Fields a person still has to supply, in plain words. */
  missing: string[];
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "18-Jul-2025" and "18 Jul 2025" both appear; neither is ISO. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
}

/** dd-mm-yyyy, which is what the NSE endpoint wants. */
function toNseDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

/** yyyymmdd, which is what the BSE endpoint wants. */
function toBseDate(iso: string): string {
  return iso.replace(/-/g, "");
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Read an exchange's one-line description into an action.
 *
 * Every pattern here was written against the real corpus — 5,518 rows over two
 * and a half years — rather than from what the formats ought to look like. The
 * awkward cases in that corpus are load-bearing: "Rs10/-" with no space,
 * "Rights 11: 50", "Rights 10:121@ Premium", "Re" versus "Rs".
 *
 * Returns null for the 787 annual general meetings, the interest payments and
 * the unit distributions — things the feed carries that are not corporate
 * actions on an equity holding.
 */
export function parseSubject(subject: string, faceValue: number | null): ParsedAction | null {
  const s = (subject || "").trim();
  if (!s) return null;

  // Noise first, and before anything else, because some of it contains words the
  // patterns below would otherwise latch onto.
  if (/annual general meeting|extra ordinary general meeting|^e\.?g\.?m|^a\.?g\.?m|board meeting/i.test(s))
    return null;
  if (/interest payment|^distribution\b|^redemption/i.test(s)) return null;
  // A dividend is real, but it belongs in the dividends table, not this one.
  if (/dividend/i.test(s)) return null;

  // Bonus, anchored. Unanchored it would swallow "Scheme Of Arrangement - Bonus
  // Ncrps 4:1", which is a bonus of preference shares, not of the equity held.
  const bonus = s.match(/^bonus\s+(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  if (bonus) {
    // "Bonus a:b" is a new shares for every b held — so b shares become b + a.
    const a = num(bonus[1])!;
    const b = num(bonus[2])!;
    if (a > 0 && b > 0) {
      return {
        action_type: "BONUS",
        ratio_from: b,
        ratio_to: b + a,
        price_per_share: null,
        confidence: "exact",
        missing: [],
      };
    }
  }

  // Splits and consolidations are both published as a change of face value.
  if (/face value split|sub-division|consolidation of/i.test(s)) {
    const fv = s.match(/from\s*(?:rs|re)\.?\s*(\d+(?:\.\d+)?)[^\d]*?to\s*(?:rs|re)\.?\s*(\d+(?:\.\d+)?)/i);
    const before = fv ? num(fv[1]) : null;
    const after = fv ? num(fv[2]) : null;
    if (before && after && before > 0 && after > 0) {
      // Share count moves inversely to face value: the multiplier is always
      // before/after, whichever way it goes. Since the stored ratio means "from
      // shares become to shares", to/from must equal before/after — so the
      // assignment is the same for a split and a consolidation, and only the
      // label differs. Branching the numbers as well as the name is how a
      // consolidation came out as a tenfold increase.
      return {
        action_type: before > after ? "SPLIT" : "REVERSE_SPLIT",
        ratio_from: after,
        ratio_to: before,
        price_per_share: null,
        confidence: "exact",
        missing: [],
      };
    }
    return {
      action_type: /consolidation/i.test(s) ? "REVERSE_SPLIT" : "SPLIT",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "partial",
      missing: ["the ratio — the published text did not state the face values"],
    };
  }

  if (/^rights?\b/i.test(s)) {
    const r = s.match(/^rights?\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
    // "@ Premium Rs 24.30/-" is the premium, not the price. The price is the
    // face value plus the premium, and a premium of 0 means issued at par.
    const prem = s.match(/(?:premium|prm)\s*(?:rs|re)\.?\s*(\d+(?:\.\d+)?)/i);
    const premium = prem ? num(prem[1]) : null;
    const price = premium !== null && faceValue !== null ? premium + faceValue : null;
    const missing: string[] = [];
    if (!r) missing.push("the entitlement ratio");
    if (price === null) missing.push("the issue price per share");
    missing.push("how many shares you actually took up — rights are optional");
    return {
      action_type: "RIGHTS_ISSUE",
      ratio_from: r ? num(r[2]) : null,
      ratio_to: r ? num(r[1]) : null,
      price_per_share: price,
      // Always partial: nobody but you knows how many you subscribed for.
      confidence: "partial",
      missing,
    };
  }

  if (/buy\s*back/i.test(s)) {
    return {
      action_type: "BUYBACK",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "partial",
      missing: ["the number of shares accepted", "the buyback price per share"],
    };
  }

  if (/demerger|spin\s*off|scheme of arrangement/i.test(s)) {
    return {
      action_type: "DEMERGER",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "partial",
      missing: [
        "the ISIN of the company that splits out",
        "the entitlement ratio",
        "the share of cost basis that moves, which the scheme document sets",
      ],
    };
  }

  if (/amalgamation|\bmerger\b/i.test(s)) {
    return {
      action_type: "MERGER",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "partial",
      missing: ["the ISIN of the surviving company", "the exchange ratio"],
    };
  }

  if (/delist/i.test(s)) {
    return {
      action_type: "DELISTING",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "exact",
      missing: [],
    };
  }

  if (/liquidat|winding up/i.test(s)) {
    return {
      action_type: "LIQUIDATION",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "partial",
      missing: ["the amount distributed per share, if any"],
    };
  }

  if (/capital reduction/i.test(s)) {
    return {
      action_type: "OTHER",
      ratio_from: null,
      ratio_to: null,
      price_per_share: null,
      confidence: "partial",
      missing: ["what it did to the share count — read the scheme"],
    };
  }

  return null;
}

/**
 * A dividend, out of the same feed the corporate-action lookup already pulls.
 *
 * `parseSubject` throws these away deliberately — a dividend is not a corporate
 * action on a holding and belongs in its own table. But the feed states the
 * amount per share and the ex-date, which together with the quantity held on
 * that date is the whole of a dividend receipt. Discarding it and then asking
 * someone to type it in by hand would be perverse.
 *
 * Real forms in the corpus:
 *   "Dividend - Re 0.58 Per Share"
 *   "Interim Dividend - Rs 0.50 Per Share"
 *   "Annual General Meeting/Dividend - Re 0.80 Per Share"
 *   "Annual General Meeting/Dividend - Rs  Per Share"   <- no amount at all
 *
 * Returns null for anything that is not a dividend, and for the ones that
 * announce a dividend without saying how much.
 */
export function parseDividend(subject: string): { amount_per_share: number; kind: string } | null {
  const s = (subject || "").trim();
  if (!/dividend/i.test(s)) return null;
  // Unit trusts distribute rather than pay a dividend, and their notices mix
  // interest and capital repayment into one figure — not the same thing.
  if (/^distribution\b|per unit/i.test(s)) return null;

  const m = s.match(/(?:rs|re)\.?\s*(\d+(?:\.\d+)?)\s*(?:\/-)?\s*per\s*share/i);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const kind = /interim/i.test(s) ? "Interim" : /final/i.test(s) ? "Final" : "Dividend";
  return { amount_per_share: amount, kind };
}

async function getJson(url: string, referer: string, timeoutMs = 45_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Referer: referer,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every equity corporate action NSE published between two ISO dates.
 *
 * One call covers years — the endpoint returned 5,518 rows for a 29-month span
 * without complaint — so this does not page or chunk.
 */
export async function fetchNse(fromIso: string, toIso: string): Promise<RawAction[]> {
  const url = `${NSE_ENDPOINT}?index=equities&from_date=${toNseDate(fromIso)}&to_date=${toNseDate(toIso)}`;
  const rows = await getJson(url, "https://www.nseindia.com/companies-listing/corporate-filings-actions");
  if (!Array.isArray(rows)) throw new Error("NSE returned an unexpected shape.");

  return rows.map((r: any) => ({
    isin: r.isin?.trim() || null,
    symbol: r.symbol?.trim() || null,
    security_name: r.comp?.trim() || null,
    ex_date: toIsoDate(r.exDate),
    subject: String(r.subject ?? ""),
    face_value: Number.isFinite(Number(r.faceVal)) ? Number(r.faceVal) : null,
    source: "NSE" as const,
  }));
}

let bseMasterCache: Map<string, { code: string; name: string }> | null = null;

/** ISIN to BSE scrip code. ~5,000 active equities, so it is fetched once. */
export async function fetchBseMaster(): Promise<Map<string, { code: string; name: string }>> {
  if (bseMasterCache) return bseMasterCache;
  const rows = await getJson(BSE_MASTER, "https://www.bseindia.com/", 60_000);
  const map = new Map<string, { code: string; name: string }>();
  for (const r of rows ?? []) {
    if (r?.ISIN_NUMBER && r?.SCRIP_CD) {
      map.set(String(r.ISIN_NUMBER).trim(), {
        code: String(r.SCRIP_CD).trim(),
        name: String(r.Scrip_Name ?? "").trim(),
      });
    }
  }
  bseMasterCache = map;
  return map;
}

/**
 * BSE actions for specific ISINs — the fallback, used when NSE cannot be
 * reached. One request per holding, spaced out, because unlike NSE there is no
 * bulk-by-date endpoint.
 *
 * Note the date parameters are sent but not honoured by BSE: it returns the
 * company's whole history regardless, so the range is applied here afterwards.
 */
export async function fetchBse(
  isins: string[],
  fromIso: string,
  toIso: string
): Promise<RawAction[]> {
  const master = await fetchBseMaster();
  const out: RawAction[] = [];

  for (const isin of isins) {
    const entry = master.get(isin);
    if (!entry) continue;
    const url = `${BSE_ACTIONS}?scripcode=${encodeURIComponent(entry.code)}&Fdate=${toBseDate(
      fromIso
    )}&TDate=${toBseDate(toIso)}`;
    try {
      const data = await getJson(url, "https://www.bseindia.com/", 30_000);
      for (const r of data?.Table2 ?? []) {
        const iso = toIsoDate(r?.Ex_date);
        if (!iso || iso < fromIso || iso > toIso) continue;
        out.push({
          isin,
          symbol: r?.short_name?.trim() || null,
          security_name: r?.sLongName?.trim() || entry.name,
          ex_date: iso,
          subject: String(r?.purpose ?? "").replace(/\s+/g, " ").trim(),
          face_value: null,
          source: "BSE" as const,
        });
      }
    } catch {
      // One unreachable scrip should not lose the other twenty.
    }
    // Deliberately unhurried: this is someone else's server.
    await new Promise((r) => setTimeout(r, 350));
  }

  return out;
}
