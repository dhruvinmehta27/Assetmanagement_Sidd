import { Charges, ContractNote, Trade } from "@/app/lib/schema";

/**
 * Sign normalisation, applied to every note on its way into either store.
 *
 * Extraction is not deterministic on sign. Re-running the same 27 PDFs once
 * produced 129 negative buy values and once 102 negative and 27 positive — the
 * PDFs never changed, the model simply read a bracketed or DR-marked figure as
 * negative on one pass and not the next. Nothing downstream should have to cope
 * with that, so each fact carries its direction in exactly one field and every
 * amount beside it is stored as a magnitude:
 *
 *   trades   `side` (BUY/SELL) is the direction; quantity, rates and values are
 *            magnitudes.
 *   note     `net_amount_direction` is the direction. `net_amount` keeps the
 *            documented signed convention (payable negative, receivable
 *            positive) but is *derived* from the direction rather than trusted,
 *            so the two can never disagree.
 *   charges  a charge is a cost, so it is positive. `rounding` is the one
 *            exception: it is a signed adjustment where positive means credited
 *            to the client, and its sign is the whole point of the field.
 *
 * This is deliberately not clamped to "what the model returned" — a value we
 * flip here was wrong on the page it came from, or wrong in the reading of it,
 * and either way the magnitude is the part that was never in doubt.
 */

/** Magnitude of a number, or null for anything that is not one. */
function mag(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/** Signed passthrough, for the fields where the sign carries meaning. */
function signed(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeTrade(t: Trade): Trade {
  return {
    ...t,
    quantity: mag(t.quantity),
    gross_rate: mag(t.gross_rate),
    net_rate: mag(t.net_rate),
    gross_value: mag(t.gross_value),
    net_value: mag(t.net_value),
    brokerage_per_unit: mag(t.brokerage_per_unit),
  };
}

export function normalizeCharges(c: Charges | null | undefined): Charges {
  const src = c ?? ({} as Charges);
  return {
    taxable_value_of_supply: mag(src.taxable_value_of_supply),
    brokerage: mag(src.brokerage),
    exchange_transaction_charges: mag(src.exchange_transaction_charges),
    clearing_charges: mag(src.clearing_charges),
    sebi_turnover_fees: mag(src.sebi_turnover_fees),
    stt: mag(src.stt),
    stamp_duty: mag(src.stamp_duty),
    ipft: mag(src.ipft),
    gst: mag(src.gst),
    cgst: mag(src.cgst),
    sgst: mag(src.sgst),
    igst: mag(src.igst),
    demat_charges: mag(src.demat_charges),
    // The only signed charge: positive means credited to the client.
    rounding: signed(src.rounding),
    other_charges: mag(src.other_charges),
    total_charges: mag(src.total_charges),
  };
}

/**
 * Reconcile the note total with its direction so the pair is always consistent.
 *
 * The direction wins when both are present — it comes from words printed on the
 * note ("Net amount payable"), which the model reads far more reliably than it
 * reads a minus sign or a bracket. When only the sign is available the direction
 * is inferred from it, so notes stored before this existed still say which way
 * the money went. A zero total says nothing either way and is left alone.
 */
export function normalizeNetAmount(
  amount: number | null | undefined,
  direction: ContractNote["net_amount_direction"]
): {
  net_amount: number | null;
  net_amount_direction: ContractNote["net_amount_direction"];
} {
  const magnitude = mag(amount);
  if (magnitude === null) return { net_amount: null, net_amount_direction: direction ?? null };

  if (direction === "PAYABLE") return { net_amount: -magnitude, net_amount_direction: "PAYABLE" };
  if (direction === "RECEIVABLE") return { net_amount: magnitude, net_amount_direction: "RECEIVABLE" };

  const raw = signed(amount)!;
  if (raw === 0) return { net_amount: 0, net_amount_direction: null };
  return raw < 0
    ? { net_amount: -magnitude, net_amount_direction: "PAYABLE" }
    : { net_amount: magnitude, net_amount_direction: "RECEIVABLE" };
}

/** Everything above, applied to a whole note. Pure — the input is untouched. */
export function normalizeContractNote(d: ContractNote): ContractNote {
  const { net_amount, net_amount_direction } = normalizeNetAmount(
    d.net_amount,
    d.net_amount_direction
  );

  return {
    ...d,
    trades: (d.trades ?? []).map(normalizeTrade),
    charges: normalizeCharges(d.charges),
    net_amount,
    net_amount_direction,
  };
}
