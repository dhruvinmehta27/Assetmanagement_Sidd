import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isStorageConfigured,
  storageNotConfiguredMessage,
} from "@/app/lib/store";
import { ContractNote } from "@/app/lib/schema";

export const runtime = "nodejs";

/**
 * Persist an extracted contract note (and its trades) to whichever store this
 * build uses — a local SQLite file on desktop, Supabase on the web.
 * De-duplicates on (broker_name, contract_note_number, trade_date) so
 * re-uploading the same note does not double-count trades.
 */
export async function POST(req: NextRequest) {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: storageNotConfiguredMessage() }, { status: 500 });
  }

  let payload: { data: ContractNote; filename?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!payload?.data) {
    return NextResponse.json({ error: "Missing contract note data." }, { status: 400 });
  }

  try {
    const store = await getStore();
    const result = await store.saveContractNote(payload.data, payload.filename);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
