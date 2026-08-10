import { getSupabase } from "@/app/lib/supabase";
import { ContractNote } from "@/app/lib/schema";

/**
 * Write an extracted contract note and its trades to Supabase.
 *
 * Shared by the single-note route and the folder importer. De-duplication is
 * content-based — (broker_name, contract_note_number, trade_date), matching the
 * unique constraint in supabase/schema.sql — so importing the same PDF twice,
 * under any filename or path, is a no-op rather than a double-count.
 */

export interface SaveResult {
  saved: boolean;
  duplicate: boolean;
  note_id: string | null;
  trades: number;
}

export class PersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistError";
  }
}

export async function saveContractNote(
  d: ContractNote,
  filename?: string
): Promise<SaveResult> {
  const sb = getSupabase();
  const c = d.charges || ({} as ContractNote["charges"]);

  const { data: existing } = await sb
    .from("contract_notes")
    .select("id")
    .eq("broker_name", d.broker_name ?? "")
    .eq("contract_note_number", d.contract_note_number ?? "")
    .eq("trade_date", d.trade_date ?? null)
    .maybeSingle();

  if (existing) {
    return { saved: false, duplicate: true, note_id: existing.id, trades: 0 };
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
      source_filename: filename ?? null,
      raw_json: d as unknown as Record<string, unknown>,
    })
    .select("id")
    .single();

  if (noteErr || !note) {
    throw new PersistError(`Failed to save contract note: ${noteErr?.message}`);
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
      // The note row is already committed, so report the id — otherwise the
      // caller cannot tell a partial write from a total failure.
      throw new PersistError(
        `Note saved (${note.id}) but trades failed: ${tErr.message}`
      );
    }
  }

  return { saved: true, duplicate: false, note_id: note.id, trades: trades.length };
}
