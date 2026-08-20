import Anthropic from "@anthropic-ai/sdk";
import { ExtractionError, getApiKey } from "@/app/lib/extract";
import { fetchBseMaster, toIsoDate } from "@/app/lib/sources/exchange";

/**
 * Demerger terms, from the document the company was legally required to file.
 *
 * The exchange corporate-action feed says a demerger happened and nothing more.
 * The three numbers the engine needs — which company the shares go to, how many,
 * and what share of the cost basis follows them — are only ever published in a
 * filing, as prose in a PDF. So this finds that filing among the company's
 * announcements, reads it with the same Claude extraction the app already uses
 * for contract notes, and hands back something a person can check.
 *
 * Vedanta's 2026 scheme is the worked example and it is not a gentle one. It
 * apportions the cost basis five ways (52.34% retained, then 7.15 / 12.23 /
 * 21.49 / 6.79%), and two of the four resulting companies were renamed between
 * the scheme document and their listing — "Talwandi Sabo Power" trades as
 * Vedanta Power, "Malco Energy" as Vedanta Oil and Gas. Nothing automatic maps
 * those names to their ISINs, which is exactly why this proposes and a person
 * disposes.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const NSE_ANNOUNCEMENTS = "https://www.nseindia.com/api/corporate-announcements";

export interface Announcement {
  date: string | null;
  kind: string;
  text: string;
  url: string | null;
  /** Higher means more likely to be the one carrying the numbers. */
  score: number;
}

/**
 * How promising an announcement looks, without opening it.
 *
 * "Apportionment of cost of acquisition" is the filing that exists solely to
 * publish the cost split, so it outranks everything. A scheme of arrangement or
 * an allotment intimation usually carries the entitlement ratio.
 */
function scoreAnnouncement(text: string, kind: string): number {
  const s = `${kind} ${text}`.toLowerCase();
  let score = 0;
  if (/apportion/.test(s)) score += 100;
  if (/cost of acquisition/.test(s)) score += 80;
  if (/scheme of arrangement|scheme of demerger/.test(s)) score += 30;
  if (/demerger/.test(s)) score += 20;
  if (/allot/.test(s)) score += 15;
  if (/record date/.test(s)) score += 10;
  if (/entitlement|ratio/.test(s)) score += 10;
  // Noise that mentions the right words for the wrong reason.
  if (/news verification|clarification|credit rating|press release/.test(s)) score -= 25;
  return score;
}

/**
 * Announcements for a symbol that look like they carry demerger terms.
 *
 * NSE's announcements endpoint is per-symbol and returns the company's whole
 * history — 2,144 rows for Vedanta — so the filtering happens here.
 */
export async function findSchemeAnnouncements(
  symbol: string,
  exDate: string
): Promise<Announcement[]> {
  const res = await fetch(`${NSE_ANNOUNCEMENTS}?index=equities&symbol=${encodeURIComponent(symbol)}`, {
    headers: {
      "User-Agent": UA,
      Referer: "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) throw new Error(`NSE announcements returned HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("NSE announcements returned an unexpected shape.");

  const out: Announcement[] = [];
  for (const r of rows) {
    const text = String(r?.attchmntText ?? "").replace(/\s+/g, " ").trim();
    const kind = String(r?.desc ?? "").trim();
    const score = scoreAnnouncement(text, kind);
    if (score <= 0) continue;

    // The apportionment filing follows the demerger rather than preceding it,
    // so the window leans forward: a year after, three months before.
    const date = toIsoDate((r?.an_dt ?? "").slice(0, 11));
    if (date) {
      const days = (Date.parse(date) - Date.parse(exDate)) / 86_400_000;
      if (days < -100 || days > 400) continue;
    }

    out.push({ date, kind, text, url: r?.attchmntFile || null, score });
  }

  out.sort((a, b) => b.score - a.score || (a.date && b.date ? (a.date < b.date ? 1 : -1) : 0));
  return out;
}

/**
 * What the engine needs, per company the scheme creates.
 */
export interface SchemeLeg {
  company_name: string;
  /** The business demerged into it, which often names the listed entity. */
  undertaking: string | null;
  /** Shares of this company received for `ratio_from` of the original. */
  ratio_from: number | null;
  ratio_to: number | null;
  /** Share of the original cost basis, as a fraction. */
  cost_fraction: number | null;
}

export interface SchemeTerms {
  parent_company: string | null;
  /** Fraction of cost the original company keeps. */
  parent_cost_fraction: number | null;
  record_date: string | null;
  legs: SchemeLeg[];
  /** Anything the model wants to flag — read it before accepting. */
  notes: string | null;
}

const SCHEME_TOOL = {
  name: "record_scheme_terms",
  description:
    "Record the demerger terms stated in a company filing: which companies result from it, how many shares of each are issued per share of the original, and how the cost of acquisition is apportioned.",
  input_schema: {
    type: "object" as const,
    properties: {
      parent_company: { type: ["string", "null"] },
      parent_cost_percent: {
        type: ["number", "null"],
        description:
          "Percentage of the total cost of acquisition retained by the original company, as printed (e.g. 52.34).",
      },
      record_date: {
        type: ["string", "null"],
        description: "Record date for the entitlement, ISO YYYY-MM-DD.",
      },
      legs: {
        type: "array",
        description: "One entry per resulting company, excluding the original.",
        items: {
          type: "object",
          properties: {
            company_name: {
              type: "string",
              description: "Exactly as named in the document, not abbreviated.",
            },
            undertaking: {
              type: ["string", "null"],
              description:
                "The business demerged into this company, as the document names it — e.g. 'Aluminium Undertaking', 'Oil and Gas Undertaking'. Often the only clue to the company's listed name, which is frequently different from the one used here.",
            },
            shares_received: {
              type: ["number", "null"],
              description: "Shares of this company issued for `shares_held` of the original.",
            },
            shares_held: {
              type: ["number", "null"],
              description: "Shares of the original company that entitle the holder to the above.",
            },
            cost_percent: {
              type: ["number", "null"],
              description: "Percentage of the total cost of acquisition apportioned to this company, as printed.",
            },
          },
          required: ["company_name"],
        },
      },
      notes: {
        type: ["string", "null"],
        description:
          "Anything ambiguous, any figure that had to be inferred, or anything a reader should check.",
      },
    },
    required: ["legs"],
  },
} as const;

const SYSTEM_PROMPT = `You are reading an Indian listed company's filing about a scheme of arrangement (a demerger).

Extract only what the document states. Never guess a ratio or a percentage.

- "legs" must contain one entry per RESULTING company. Do not include the original
  (demerged) company as a leg — its retained share goes in parent_cost_percent.
- Percentages must be returned exactly as printed (52.34, not 0.5234).
- A scheme commonly says "1 equity share of each Resulting Company for every 1 equity
  share held" — that means shares_received = 1 and shares_held = 1 for every leg.
- "undertaking" is the business transferred into that company as the document names
  it ("Aluminium Undertaking", "Oil and Gas Undertaking"). Fill it in whenever the
  document says so — a resulting company is often listed under the name of its
  business rather than the name used in the scheme.
- Company names must be copied exactly as written. They are used to look up an ISIN
  and an abbreviation will not match.
- If the document does not state a figure, return null for it rather than inferring one.
- Use "notes" to flag anything a human should check before relying on this.

Always call the record_scheme_terms tool exactly once.`;

/** Read a filing PDF into structured demerger terms. */
export async function extractSchemeTerms(pdf: Buffer): Promise<SchemeTerms> {
  const client = new Anthropic({ apiKey: getApiKey() });

  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: [SCHEME_TOOL as any],
      tool_choice: { type: "tool", name: SCHEME_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
            },
            { type: "text", text: "Extract the demerger terms into the record_scheme_terms tool." },
          ],
        },
      ],
    });
  } catch (err: any) {
    const detail = err?.error?.error?.message || err?.message || "Unknown error calling Claude API.";
    throw new ExtractionError(`Could not read the filing: ${detail}`, err?.status || 500);
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) throw new ExtractionError("The filing could not be read into structured terms.", 502);

  const raw = toolUse.input as any;
  const pct = (v: unknown): number | null => {
    const n = Number(v);
    // Percentages are asked for as printed; a fraction slipping through would
    // silently move a hundredth of the cost basis.
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : null;
  };

  return {
    parent_company: raw.parent_company ?? null,
    parent_cost_fraction: pct(raw.parent_cost_percent),
    record_date: raw.record_date ?? null,
    notes: raw.notes ?? null,
    legs: (raw.legs ?? []).map((l: any) => ({
      company_name: String(l.company_name ?? "").trim(),
      undertaking: l.undertaking ? String(l.undertaking).trim() : null,
      ratio_from: Number.isFinite(Number(l.shares_held)) ? Number(l.shares_held) : null,
      ratio_to: Number.isFinite(Number(l.shares_received)) ? Number(l.shares_received) : null,
      cost_fraction: pct(l.cost_percent),
    })),
  };
}

export interface IsinMatch {
  isin: string;
  name: string;
  /** 0-1. Anything below a confident match is still offered, and labelled. */
  score: number;
}

/** Words that carry no distinguishing information in an Indian company name. */
const STOPWORDS = new Set(["ltd", "limited", "the", "india", "of", "and", "&", "co", "company"]);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

/**
 * Best guesses at the ISIN for a company named in a scheme document.
 *
 * Deliberately returns a ranked list rather than an answer. Two of Vedanta's
 * four resulting companies listed under different names from the ones the scheme
 * used, so the top match is sometimes wrong and sometimes absent — and a wrong
 * ISIN here quietly parks a fifth of a cost basis in a security that is not held.
 */
export async function resolveIsin(
  companyName: string,
  parentName?: string | null,
  undertaking?: string | null,
  limit = 6
): Promise<IsinMatch[]> {
  const master = await fetchBseMaster();
  const want = tokens(companyName);
  if (want.length === 0) return [];

  // A resulting company nearly always carries the parent's brand, and that is
  // the only handle on one that was renamed between the scheme and the listing.
  // Vedanta's scheme names "Talwandi Sabo Power" and "Malco Energy"; they trade
  // as Vedanta Power and Vedanta Oil and Gas. On name alone the top matches are
  // Adani Power and GK Energy — confidently, and completely wrong. The brand
  // token is what pulls the real ones back into view.
  const brand = new Set(tokens(parentName ?? ""));
  // "Malco Energy Limited" lists as "Vedanta Oil and Gas Ltd" — no shared word
  // at all. The scheme's own description of the business, "Oil and Gas
  // Undertaking", is the only bridge, so its words count as strongly as the
  // company's own.
  const business = tokens(undertaking ?? "").filter((w) => w !== "undertaking");
  const activity = [...want.filter((w) => !brand.has(w)), ...business];

  const scored: IsinMatch[] = [];
  for (const [isin, entry] of master) {
    const have = tokens(entry.name);
    if (have.length === 0) continue;

    const overlap = want.filter((w) => have.includes(w)).length;
    const sharesBrand = brand.size > 0 && have.some((w) => brand.has(w));
    // A brand match plus any word describing the business — "Power", "Energy",
    // "Oil", "Gas" — is a stronger signal than a full-name match on a company
    // that has nothing to do with this scheme.
    const activityHit = new Set(activity.filter((w) => have.includes(w))).size;
    if (overlap === 0 && !sharesBrand) continue;

    const base = overlap / new Set([...want, ...have]).size;
    const bonus = sharesBrand ? 0.35 + Math.min(activityHit, 2) * 0.15 : 0;
    scored.push({
      isin,
      name: entry.name,
      score: Math.round(Math.min(base + bonus, 1) * 100) / 100,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, limit);
}

/** Download a filing. Kept small and separate so a failure is easy to report. */
export async function fetchFiling(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://www.nseindia.com/" },
  });
  if (!res.ok) throw new Error(`The filing could not be downloaded (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString() !== "%PDF") {
    throw new Error("That announcement link did not return a PDF.");
  }
  return buf;
}
