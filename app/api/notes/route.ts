import { NextRequest, NextResponse } from "next/server";
import { getSupabase, isSupabaseConfigured } from "@/app/lib/supabase";
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

  const d = payload?.data;
  if (!d) {
    return NextResponse.json({ error: "Missing contract note data." }, { status: 400 });
  }

  const sb = getSupabase();
  const c = d.charges || ({} as ContractNote["charges"]);

  // De-dupe check.
  const { data: existing } = await sb
    .from("contract_notes")
    .select("id")
    .eq("broker_name", d.broker_name ?? "")
    .eq("contract_note_number", d.contract_note_number ?? "")
    .eq("trade_date", d.trade_date ?? null)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ saved: false, duplicate: true, note_id: existing.id });
  }

  const { data: note, error: noteErr } = await sb
    .from("contract_notes")
    .insert({
      broker_name: d.broker_name,
      broker_sebi_regn: d.broker_sebi_regn,
      contract_note_number: d.contract_note_number,
      trade_date: d.trade_date,
      settlement_date: d.settlement_date,
      settlement_number: d.settlement_number,
      client_name: d.client_name,
      client_code: d.client_code,
      pan: d.pan,
      exchange: d.exchange,
      currency: d.currency ?? "INR",
      brokerage: c.brokerage,
      exchange_transaction_charges: c.exchange_transaction_charges,
      clearing_charges: c.clearing_charges,
      sebi_turnover_fees: c.sebi_turnover_fees,
      stt: c.stt,
      stamp_duty: c.stamp_duty,
      ipft: c.ipft,
      gst: c.gst,
      cgst: c.cgst,
      sgst: c.sgst,
      igst: c.igst,
      demat_charges: c.demat_charges,
      rounding: c.rounding,
      other_charges: c.other_charges,
      total_charges: c.total_charges,
      net_amount: d.net_amount,
      net_amount_direction: d.net_amount_direction,
      source_filename: payload.filename ?? null,
      raw_json: d as unknown as Record<string, unknown>,
    })
    .select("id")
    .single();

  if (noteErr || !note) {
    return NextResponse.json(
      { error: `Failed to save contract note: ${noteErr?.message}` },
      { status: 500 }
    );
  }

  const trades = (d.trades || [])
    .filter((t) => t.buy_sell && t.quantity)
    .map((t) => ({
      contract_note_id: note.id,
      trade_date: d.trade_date,
      security_name: t.security_name,
      symbol: t.symbol,
      isin: t.isin,
      exchange: t.exchange ?? d.exchange,
      segment: t.segment,
      side: t.buy_sell,
      quantity: t.quantity,
      gross_rate: t.gross_rate,
      net_rate: t.net_rate,
      gross_value: t.gross_value,
      net_value: t.net_value,
      order_no: t.order_no,
      trade_no: t.trade_no,
      trade_time: t.trade_time,
    }));

  if (trades.length > 0) {
    const { error: tErr } = await sb.from("trades").insert(trades);
    if (tErr) {
      return NextResponse.json(
        { error: `Note saved but trades failed: ${tErr.message}`, note_id: note.id },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ saved: true, note_id: note.id, trades: trades.length });
}
