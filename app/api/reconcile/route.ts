import { NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";
import { DEFAULT_TOLERANCE, ReconcileNote, reconcileAll } from "@/app/lib/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check every stored contract note against its own printed net amount.
 *
 * Reads only what is already in the database — no Claude calls, no network, no
 * cost — so it is safe to run as often as you like. It is the cheapest check
 * available on whether extraction read a note correctly, because a note carries
 * its own answer in the relationship between its trade lines, its charges and
 * its total.
 */
export async function GET(req: Request) {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });
  }

  const params = new URL(req.url).searchParams;

  // ?accounts=id,id — omitted means every note, including unassigned ones. A
  // note nobody has claimed still has arithmetic worth checking.
  const requested = params.get("accounts");
  const filter = requested
    ? { accountIds: requested.split(",").map((s) => s.trim()).filter(Boolean) }
    : undefined;

  // Note the explicit null check: `Number(null)` is 0, which is a perfectly
  // valid tolerance, so testing only for finiteness would silently make the
  // default zero and report every note as off by its rounding line.
  const raw = params.get("tolerance");
  const parsed = raw === null ? NaN : Number(raw);
  const tolerance = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TOLERANCE;

  const store = await getStore();

  try {
    const [notes, accounts] = await Promise.all([
      store.listNotesWithTrades(filter),
      store.listAccounts(),
    ]);

    const { rows, summary } = reconcileAll(notes as unknown as ReconcileNote[], tolerance);

    return NextResponse.json({
      summary,
      rows,
      tolerance,
      storage: store.info(),
      accountsSupported: store.accountsSupported,
      accounts,
      selectedAccounts: filter?.accountIds ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
