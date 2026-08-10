import { NextRequest, NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/app/lib/supabase";
import { saveContractNote, PersistError } from "@/app/lib/persist";
import { ContractNote } from "@/app/lib/schema";

export const runtime = "nodejs";

/**
 * Persist an extracted contract note (and its trades) into Supabase.
 * De-duplicates on (broker_name, contract_note_number, trade_date) so
 * re-uploading the same note does not double-count trades.
 */
export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      {
        error:
          "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to your environment.",
      },
      { status: 500 }
    );
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
    const result = await saveContractNote(payload.data, payload.filename);
    return NextResponse.json(result);
  } catch (err: any) {
    const status = err instanceof PersistError ? 500 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
