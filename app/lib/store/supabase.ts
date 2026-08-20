import { getSupabase } from "@/app/lib/supabase";
import { ContractNote } from "@/app/lib/schema";
import {
  CorporateActionInput,
  DividendInput,
  SaveResult,
  Store,
  StoreError,
  StoreInfo,
  StoredCorporateAction,
  StoredDividend,
  StoredNoteWithTrades,
  StoredTrade,
} from "@/app/lib/store/types";
import { normalizeContractNote } from "@/app/lib/store/normalize";
import { multiplierOf } from "@/app/lib/corporate-actions";

/**
 * Supabase store — the web default, and unchanged from how persistence worked
 * before the local driver existed. Writes go out over the network to a hosted
 * Postgres using the service role key.
 */

/**
 * Accounts are a desktop feature for now — the web build keeps the single pooled
 * portfolio it has always had. These stubs let the shared routes run unchanged;
 * the UI checks `accountsSupported` and hides the controls rather than offering
 * ones that quietly do nothing.
 */
const ACCOUNTS_UNSUPPORTED =
  "Accounts are only available in the desktop app at the moment.";

export const supabaseStore: Store = {
  accountsSupported: false,

  async listAccounts() {
    return [];
  },

  async listUnassigned() {
    return [];
  },

  async createAccount(): Promise<string> {
    throw new StoreError(ACCOUNTS_UNSUPPORTED);
  },

  async assignToAccount() {
    throw new StoreError(ACCOUNTS_UNSUPPORTED);
  },

  info(): StoreInfo {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Not configured, or garbage in the env — show it raw rather than crash a
      // page whose only job was to say where data goes.
    }
    return { driver: "supabase", location: host, local: false };
  },

  async saveContractNote(input: ContractNote, filename?: string): Promise<SaveResult> {
    const sb = getSupabase();
    // Same convention as the local driver: direction lives in `side` and
    // `net_amount_direction`, every amount beside them is a magnitude.
    const d = normalizeContractNote(input);
    const c = d.charges;

    const { data: existing } = await sb
      .from("contract_notes")
      .select("id")
      .eq("broker_name", d.broker_name ?? "")
      .eq("contract_note_number", d.contract_note_number ?? "")
      .eq("trade_date", d.trade_date ?? null)
      .maybeSingle();

    if (existing) {
      return {
        saved: false,
        duplicate: true,
        note_id: existing.id,
        trades: 0,
        account_id: null,
      };
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
      throw new StoreError(`Failed to save contract note: ${noteErr?.message}`);
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
        throw new StoreError(
          `Note saved (${note.id}) but trades failed: ${tErr.message}`
        );
      }
    }

    return {
      saved: true,
      duplicate: false,
      note_id: note.id,
      trades: trades.length,
      account_id: null,
    };
  },

  async countContractNotes(): Promise<number> {
    const { count } = await getSupabase()
      .from("contract_notes")
      .select("id", { count: "exact", head: true });
    return count ?? 0;
  },

  async listTrades(): Promise<StoredTrade[]> {
    const { data, error } = await getSupabase()
      .from("trades")
      .select("*")
      .order("trade_date", { ascending: true });
    if (error) throw new StoreError(`Failed to read trades: ${error.message}`);
    return (data ?? []) as StoredTrade[];
  },

  async listNotesWithTrades(): Promise<StoredNoteWithTrades[]> {
    const sb = getSupabase();

    const { data: notes, error } = await sb
      .from("contract_notes")
      .select(
        `id, contract_note_number, trade_date, broker_name, client_name,
         source_filename, net_amount, net_amount_direction, brokerage,
         exchange_transaction_charges, clearing_charges, sebi_turnover_fees, stt,
         stamp_duty, ipft, gst, cgst, sgst, igst, demat_charges, rounding,
         other_charges, total_charges`
      )
      .order("trade_date", { ascending: true });

    if (error) throw new StoreError(`Failed to read contract notes: ${error.message}`);
    if (!notes || notes.length === 0) return [];

    const { data: lines, error: tErr } = await sb
      .from("trades")
      .select(
        "contract_note_id, side, quantity, gross_rate, gross_value, net_rate, net_value, security_name, isin"
      )
      .in(
        "contract_note_id",
        notes.map((n) => n.id)
      );

    if (tErr) throw new StoreError(`Failed to read trades: ${tErr.message}`);

    const byNote = new Map<string, StoredNoteWithTrades["trades"]>();
    for (const { contract_note_id, ...line } of lines ?? []) {
      const bucket = byNote.get(contract_note_id);
      if (bucket) bucket.push(line as StoredNoteWithTrades["trades"][number]);
      else byNote.set(contract_note_id, [line as StoredNoteWithTrades["trades"][number]]);
    }

    // No account dimension on this backend, so every note reads as unassigned —
    // which is exactly what it is here.
    return notes.map((n) => ({
      ...(n as unknown as StoredNoteWithTrades),
      account_id: null,
      trades: byNote.get(n.id) ?? [],
    }));
  },

  async listDividends(): Promise<StoredDividend[]> {
    const { data, error } = await getSupabase()
      .from("dividends")
      .select("*")
      .order("pay_date", { ascending: false });
    if (error) throw new StoreError(error.message);
    return (data ?? []) as StoredDividend[];
  },

  async listCorporateActions(): Promise<StoredCorporateAction[]> {
    const { data, error } = await getSupabase()
      .from("corporate_actions")
      .select("*")
      .order("ex_date", { ascending: false });
    if (error) throw new StoreError(error.message);
    return (data ?? []) as StoredCorporateAction[];
  },

  async addDividend(input: DividendInput): Promise<string> {
    const { data, error } = await getSupabase()
      .from("dividends")
      .insert({
        isin: input.isin,
        symbol: input.symbol ?? null,
        security_name: input.security_name ?? null,
        ex_date: input.ex_date || null,
        pay_date: input.pay_date || null,
        amount_per_share: input.amount_per_share ?? null,
        quantity: input.quantity ?? null,
        gross_amount: input.gross_amount ?? null,
        tds: input.tds ?? 0,
        net_amount: input.net_amount ?? null,
        source: input.source ?? "manual",
        notes: input.notes ?? null,
      })
      .select("id")
      .single();

    if (error) throw new StoreError(error.message);
    return data.id;
  },

  async upsertCorporateAction(input: CorporateActionInput): Promise<string> {
    const { data, error } = await getSupabase()
      .from("corporate_actions")
      .upsert(
        {
          isin: input.isin,
          symbol: input.symbol ?? null,
          security_name: input.security_name ?? null,
          action_type: input.action_type,
          ex_date: input.ex_date,
          ratio_from: input.ratio_from ?? null,
          ratio_to: input.ratio_to ?? null,
          quantity_multiplier: multiplierOf(input.ratio_from, input.ratio_to),
          target_isin: input.target_isin ?? null,
          target_symbol: input.target_symbol ?? null,
          target_security_name: input.target_security_name ?? null,
          cost_fraction: input.cost_fraction ?? null,
          price_per_share: input.price_per_share ?? null,
          quantity: input.quantity ?? null,
          ratio_text: input.ratio_text ?? null,
          notes: input.notes ?? null,
          source: input.source ?? "manual",
        },
        { onConflict: "isin,action_type,ex_date" }
      )
      .select("id")
      .single();

    // The hosted schema predates Table 4's columns. Say so plainly rather than
    // surfacing a Postgres column-does-not-exist error to someone who has no
    // idea the two builds have different schemas.
    if (error) {
      throw new StoreError(
        /column .* does not exist/i.test(error.message)
          ? "The hosted database has not been migrated for the full set of corporate actions yet. Use the desktop app, which manages its own schema."
          : error.message
      );
    }
    return data.id;
  },

  async deleteCorporateAction(id: string): Promise<boolean> {
    const { error, count } = await getSupabase()
      .from("corporate_actions")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw new StoreError(error.message);
    return (count ?? 0) > 0;
  },
};
