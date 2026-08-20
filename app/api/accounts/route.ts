import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The people whose portfolios this app holds, plus everything imported that no
 * account has claimed yet.
 *
 * An account is a person or entity identified by PAN, not a demat account: one
 * account pools every broker that person trades through.
 */
export async function GET() {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });
  }

  try {
    const store = await getStore();
    if (!store.accountsSupported) {
      return NextResponse.json({ supported: false, accounts: [], unassigned: [] });
    }

    const [accounts, unassigned] = await Promise.all([
      store.listAccounts(),
      store.listUnassigned(),
    ]);
    return NextResponse.json({ supported: true, accounts, unassigned });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body?.label?.trim()) {
    return NextResponse.json({ error: "An account needs a name." }, { status: 400 });
  }

  try {
    const store = await getStore();
    const id = await store.createAccount({
      label: body.label,
      pan: body.pan ?? null,
      entity_type: body.entity_type ?? "INDIVIDUAL",
    });
    return NextResponse.json({ saved: true, id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
