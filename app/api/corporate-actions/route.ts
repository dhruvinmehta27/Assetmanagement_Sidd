import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";
import { specOf, validateAction } from "@/app/lib/corporate-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  try {
    const store = await getStore();
    return NextResponse.json({ corporateActions: await store.listCorporateActions() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Numbers arrive from a form as strings, and "" means "not given", not zero. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "" ? null : s;
}

export async function POST(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const draft = {
    isin: str(body.isin),
    action_type: str(body.action_type),
    ex_date: str(body.ex_date),
    ratio_from: num(body.ratio_from),
    ratio_to: num(body.ratio_to),
    target_isin: str(body.target_isin),
    cost_fraction: num(body.cost_fraction),
    price_per_share: num(body.price_per_share),
    quantity: num(body.quantity),
  };

  // The same validator the form runs as you type. A wrong ratio is the one
  // mistake here that corrupts a cost basis without ever looking wrong, so the
  // rules live in one place and both ends enforce them.
  const errors = validateAction(draft);
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(" "), errors }, { status: 400 });
  }

  const spec = specOf(draft.action_type!)!;

  try {
    const store = await getStore();
    const id = await store.upsertCorporateAction({
      isin: draft.isin!,
      symbol: str(body.symbol),
      security_name: str(body.security_name),
      action_type: draft.action_type!,
      ex_date: draft.ex_date!,
      // Only persist what this type actually uses. Storing a stray ratio on a
      // buyback would leave a number that reads as meaningful and is not.
      ratio_from: spec.needs.ratio ? draft.ratio_from : null,
      ratio_to: spec.needs.ratio ? draft.ratio_to : null,
      target_isin: spec.needs.target ? draft.target_isin : null,
      target_symbol: spec.needs.target ? str(body.target_symbol) : null,
      target_security_name: spec.needs.target ? str(body.target_security_name) : null,
      cost_fraction: spec.needs.costFraction ? draft.cost_fraction : null,
      price_per_share: spec.needs.price ? draft.price_per_share : null,
      quantity: spec.needs.quantity ? draft.quantity : null,
      ratio_text: str(body.ratio_text),
      notes: str(body.notes),
      source: str(body.source) ?? "manual",
    });
    return NextResponse.json({ saved: true, id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isStorageConfigured())
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "An id is required." }, { status: 400 });

  try {
    const store = await getStore();
    const deleted = await store.deleteCorporateAction(id);
    if (!deleted) {
      return NextResponse.json({ error: "That action no longer exists." }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
