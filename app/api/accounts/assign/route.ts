import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";

export const runtime = "nodejs";

/**
 * Claim a group of unassigned notes for an account.
 *
 * Besides backfilling the notes and trades already imported, this records the
 * broker/client-code pair and adopts the PAN, so nothing from that identity ever
 * needs assigning by hand again.
 */
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

  if (!body?.account_id) {
    return NextResponse.json({ error: "Choose an account first." }, { status: 400 });
  }

  try {
    const store = await getStore();
    const result = await store.assignToAccount({
      account_id: body.account_id,
      broker_name: body.broker_name ?? null,
      client_code: body.client_code ?? null,
      pan: body.pan ?? null,
    });
    return NextResponse.json({ assigned: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
