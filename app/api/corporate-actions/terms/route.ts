import { NextRequest, NextResponse } from "next/server";
import { getStore, isStorageConfigured, storageNotConfiguredMessage } from "@/app/lib/store";
import {
  Announcement,
  IsinMatch,
  SchemeTerms,
  extractSchemeTerms,
  fetchFiling,
  findSchemeAnnouncements,
  resolveIsin,
} from "@/app/lib/sources/scheme";
import { getApiKey } from "@/app/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Downloading a filing and reading it with Claude is the slowest thing the app
// does after a batch import.
export const maxDuration = 300;

/**
 * Find and read the filing that states a demerger's terms.
 *
 * The corporate-action feed says a demerger happened; only the company's own
 * filing says which companies result from it, how many shares of each, and how
 * the cost of acquisition splits. This locates that filing, reads it with
 * Claude, and proposes one action per resulting company.
 *
 * It proposes. Nothing is written here — see the note in
 * `app/lib/sources/scheme.ts` about renamed companies for why a person has to
 * confirm the ISINs before any of this touches a cost basis.
 */
export async function POST(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  // Reading the filing costs an API call, so fail before spending anything if
  // the key is missing rather than after downloading a megabyte.
  try {
    getApiKey();
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const symbol = String(body.symbol ?? "").trim();
  const isin = String(body.isin ?? "").trim();
  const exDate = String(body.ex_date ?? "").trim();
  if (!symbol || !exDate) {
    return NextResponse.json(
      { error: "A trading symbol and an ex-date are required to find the filing." },
      { status: 400 }
    );
  }

  let announcements: Announcement[];
  try {
    announcements = await findSchemeAnnouncements(symbol, exDate);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not read ${symbol}'s announcements: ${err.message}` },
      { status: 502 }
    );
  }

  if (announcements.length === 0) {
    return NextResponse.json({
      announcements: [],
      terms: null,
      message:
        "No filing near that date mentioned a scheme of arrangement or a cost apportionment. The terms may not be published yet — the apportionment notice usually follows the demerger by a few weeks.",
    });
  }

  // Either the one the caller picked, or the best-scoring one with a PDF.
  const chosen =
    (body.url && announcements.find((a) => a.url === body.url)) ||
    announcements.find((a) => a.url);

  if (!chosen?.url) {
    return NextResponse.json({
      announcements,
      terms: null,
      message: "Announcements were found but none of them carried a downloadable filing.",
    });
  }

  let terms: SchemeTerms;
  try {
    terms = await extractSchemeTerms(await fetchFiling(chosen.url));
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message, announcements, chosen },
      { status: err.status && err.status < 600 ? err.status : 502 }
    );
  }

  // Rank ISIN candidates per resulting company. The document names them; the
  // exchange lists them, sometimes under a different name entirely.
  // The parent's name is passed in because it is often the only thing linking a
  // renamed resulting company to its listing — see resolveIsin.
  const parentName = terms.parent_company || body.security_name || null;
  const legs = await Promise.all(
    terms.legs.map(async (leg) => ({
      ...leg,
      matches: (await resolveIsin(leg.company_name, parentName, leg.undertaking)) as IsinMatch[],
    }))
  );

  // Percentages that do not add to 100 mean something was misread, and the
  // parent silently absorbs the difference. Say so rather than let it through.
  const claimed = legs.reduce((s, l) => s + (l.cost_fraction ?? 0), 0);
  const total = claimed + (terms.parent_cost_fraction ?? 0);
  const warnings: string[] = [];
  if (terms.parent_cost_fraction !== null && Math.abs(total - 1) > 0.005) {
    warnings.push(
      `The percentages in the filing add to ${(total * 100).toFixed(2)}%, not 100%. Check them against the document before accepting.`
    );
  }
  if (legs.some((l) => l.cost_fraction === null)) {
    warnings.push("At least one company has no cost percentage — it cannot be applied without one.");
  }
  if (legs.some((l) => l.matches.length === 0)) {
    warnings.push(
      "At least one company could not be matched to a listed ISIN. It may not have listed yet, or it may trade under a different name."
    );
  }

  const store = await getStore();
  const existing = await store.listCorporateActions();
  const already = new Set(
    existing
      .filter((a) => a.isin === isin && a.action_type === "DEMERGER" && a.ex_date === exDate)
      .map((a) => a.target_isin ?? "")
  );

  return NextResponse.json({
    announcements: announcements.slice(0, 8),
    chosen,
    terms: {
      ...terms,
      legs: legs.map((l) => ({ ...l, already_recorded: already.has(l.matches[0]?.isin ?? "") })),
    },
    // What the parent should be left with, for checking against the page.
    retained: terms.parent_cost_fraction,
    warnings,
  });
}
