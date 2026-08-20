/**
 * Note-level reconciliation: does each contract note's own arithmetic add up?
 *
 * Every figure here already exists in the database — this makes no API calls and
 * costs nothing to run. It is the cheapest available check on whether extraction
 * read a note correctly, because a note carries its own answer: the trade lines,
 * the charge lines and the net amount all have to agree.
 *
 *     gross traded value  −  charges  =  net amount
 *
 * Three details in that line are easy to get wrong, and getting them wrong makes
 * every note look broken:
 *
 * 1. **Gross, not net.** A trade's `net_value` is quantity x net_rate, and
 *    net_rate is already brokerage-inclusive. Subtracting the charge total from
 *    it counts brokerage twice. (Cost basis in analytics.ts does use net_value,
 *    and is right to: brokerage is a deductible cost of acquisition.)
 * 2. **`gross_value` is usually absent** — the model returns it on a minority of
 *    lines — so quantity x gross_rate is the normal path, not the fallback.
 * 3. **Rounding is inside a printed total and outside a summed one.** When the
 *    note prints `total_charges`, the sub-rupee rounding adjustment is generally
 *    already in it. When we sum the components ourselves it is not, because it
 *    is not a charge. Add it in exactly one of those two cases.
 *
 * With that, all 27 notes in the first real import tie to the rupee, including
 * the two previously recorded as failing.
 */

export type NetDirection = "PAYABLE" | "RECEIVABLE" | null;

export interface ReconcileTrade {
  side: "BUY" | "SELL";
  quantity: number | null;
  gross_rate: number | null;
  gross_value: number | null;
  net_rate: number | null;
  net_value: number | null;
}

/** The note columns this needs — a subset of the contract_notes row. */
export interface ReconcileNote {
  id: string;
  contract_note_number: string | null;
  trade_date: string | null;
  broker_name: string | null;
  client_name: string | null;
  account_id: string | null;
  net_amount: number | null;
  net_amount_direction: NetDirection;
  brokerage: number | null;
  exchange_transaction_charges: number | null;
  clearing_charges: number | null;
  sebi_turnover_fees: number | null;
  stt: number | null;
  stamp_duty: number | null;
  ipft: number | null;
  gst: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  demat_charges: number | null;
  rounding: number | null;
  other_charges: number | null;
  total_charges: number | null;
  trades: ReconcileTrade[];
}

export type FlagCode =
  | "no_printed_net"
  | "no_trades"
  | "charges_derived"
  | "charges_mismatch"
  | "rounding_residual"
  | "value_from_rate"
  | "no_trade_value";

export interface Flag {
  code: FlagCode;
  /**
   * "warn" means go and look at the PDF; "info" explains how a figure was
   * arrived at. The distinction earns its keep — on a real 27-note import 20
   * notes carry at least one flag but only the warnings are worth a human's
   * time, and a filter that cannot tell them apart is no filter at all.
   */
  severity: "warn" | "info";
  /** Written for someone deciding whether to go and look at the PDF. */
  message: string;
}

/** True when a row is worth a person's attention, for the page's filter. */
export function needsAttention(row: ReconcileRow): boolean {
  return row.status !== "ties" || row.flags.some((f) => f.severity === "warn");
}

export interface ReconcileRow {
  id: string;
  contract_note_number: string | null;
  trade_date: string | null;
  broker_name: string | null;
  client_name: string | null;
  account_id: string | null;
  trade_count: number;
  /** Signed: money out on a buy is negative, proceeds of a sale positive. */
  gross_traded: number;
  /** The charge total actually used, and where it came from. */
  charges: number;
  charges_source: "printed" | "components" | "none";
  /** The components added up, whether or not a printed total was available. */
  charges_from_components: number;
  rounding: number;
  computed_net: number;
  printed_net: number | null;
  /** computed − printed. Positive means the note says more money moved. */
  delta: number | null;
  /** What the charge total would have to be for the note to tie exactly. */
  implied_charges: number | null;
  status: "ties" | "off" | "unknown";
  flags: Flag[];
}

export interface ReconcileSummary {
  notes: number;
  ties: number;
  off: number;
  unknown: number;
  /** Total of |delta| over the notes that do not tie — the money at stake. */
  total_discrepancy: number;
  /** Rows a person should look at: off, uncheckable, or carrying a warning. */
  needs_attention: number;
}

/**
 * A rupee. The printed net amount is itself rounded to the rupee on these notes,
 * and the rounding line that absorbs the difference is always sub-rupee, so a
 * tighter tolerance would report arithmetic that is in fact correct.
 */
export const DEFAULT_TOLERANCE = 1;

const n = (x: number | null | undefined): number =>
  x === null || x === undefined || !Number.isFinite(Number(x)) ? 0 : Number(x);

const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * GST is reported twice on most notes: once as a total and once split into
 * CGST/SGST/IGST. Adding both would inflate the charge total by the GST amount,
 * so prefer the stated total and fall back to the parts.
 */
function gstOf(note: ReconcileNote): number {
  if (note.gst !== null && note.gst !== undefined) return n(note.gst);
  return n(note.cgst) + n(note.sgst) + n(note.igst);
}

/** Every cost component added up. Excludes `rounding`, which is not a cost. */
export function sumCharges(note: ReconcileNote): number {
  return r2(
    n(note.brokerage) +
      n(note.exchange_transaction_charges) +
      n(note.clearing_charges) +
      n(note.sebi_turnover_fees) +
      n(note.stt) +
      n(note.stamp_duty) +
      n(note.ipft) +
      gstOf(note) +
      n(note.demat_charges) +
      n(note.other_charges)
  );
}

export function reconcileNote(
  note: ReconcileNote,
  tolerance = DEFAULT_TOLERANCE
): ReconcileRow {
  const flags: Flag[] = [];
  const trades = note.trades ?? [];

  let gross = 0;
  let fromRate = 0;
  let valueless = 0;

  for (const t of trades) {
    const stated = Math.abs(n(t.gross_value));
    const derived = Math.abs(n(t.quantity) * n(t.gross_rate));
    let value: number;

    if (stated > 0) {
      value = stated;
    } else if (derived > 0) {
      value = derived;
      fromRate += 1;
    } else {
      // Nothing to work with. Counted, then skipped — a zero here would quietly
      // make the note look like it is short by the value of the missing line.
      valueless += 1;
      continue;
    }

    gross += (t.side === "SELL" ? 1 : -1) * value;
  }

  gross = r2(gross);

  const components = sumCharges(note);
  const rounding = r2(n(note.rounding));
  const hasPrinted = note.total_charges !== null && note.total_charges !== undefined;

  const charges_source: ReconcileRow["charges_source"] = hasPrinted
    ? "printed"
    : trades.length > 0 || components > 0
    ? "components"
    : "none";

  // The one asymmetry worth understanding: a printed total already absorbs the
  // rounding line, a total we summed ourselves does not.
  const charges = hasPrinted ? r2(n(note.total_charges)) : components;
  const computed_net = r2(hasPrinted ? gross - charges : gross - charges + rounding);

  const printed_net = note.net_amount === null || note.net_amount === undefined
    ? null
    : r2(n(note.net_amount));

  const delta = printed_net === null ? null : r2(computed_net - printed_net);
  const implied_charges = printed_net === null ? null : r2(gross - printed_net);

  if (trades.length === 0) {
    flags.push({
      code: "no_trades",
      severity: "warn",
      message: "The note has no trade lines, so there is nothing to check it against.",
    });
  }
  if (valueless > 0) {
    flags.push({
      code: "no_trade_value",
      severity: "warn",
      message: `${valueless} trade line(s) carry neither a gross value nor a rate, and are missing from this total.`,
    });
  }
  if (fromRate > 0 && fromRate === trades.length - valueless && trades.length > 0) {
    flags.push({
      code: "value_from_rate",
      severity: "info",
      message: "Gross values came from quantity x rate; the note did not state them.",
    });
  }
  if (!hasPrinted && charges_source === "components") {
    flags.push({
      code: "charges_derived",
      severity: "info",
      message: `No total charges on the note — added the components to ${components.toFixed(2)}.`,
    });
  }
  if (hasPrinted && Math.abs(charges - components) > 0.01 + Math.abs(rounding)) {
    flags.push({
      code: "charges_mismatch",
      severity: "warn",
      message: `Printed total ${charges.toFixed(2)} but the components add to ${components.toFixed(
        2
      )} — a charge line is misread.`,
    });
  }

  let status: ReconcileRow["status"];
  if (printed_net === null) {
    status = "unknown";
    flags.push({
      code: "no_printed_net",
      severity: "warn",
      message: "The note has no net amount, so its arithmetic cannot be checked.",
    });
  } else if (Math.abs(delta!) <= tolerance) {
    status = "ties";
    // Not an error, but worth saying: the residual is the sub-rupee rounding
    // line, which this note treats the other way round from most.
    if (Math.abs(delta!) > 0.01 && Math.abs(Math.abs(delta!) - Math.abs(rounding)) <= 0.01) {
      flags.push({
        code: "rounding_residual",
        severity: "info",
        message: `Off by exactly the rounding adjustment (${rounding.toFixed(
          2
        )}), which this note counts on the other side.`,
      });
    }
  } else {
    status = "off";
  }

  return {
    id: note.id,
    contract_note_number: note.contract_note_number,
    trade_date: note.trade_date,
    broker_name: note.broker_name,
    client_name: note.client_name,
    account_id: note.account_id,
    trade_count: trades.length,
    gross_traded: gross,
    charges,
    charges_source,
    charges_from_components: components,
    rounding,
    computed_net,
    printed_net,
    delta,
    implied_charges,
    status,
    flags,
  };
}

export function reconcileAll(
  notes: ReconcileNote[],
  tolerance = DEFAULT_TOLERANCE
): { rows: ReconcileRow[]; summary: ReconcileSummary } {
  const rows = notes.map((note) => reconcileNote(note, tolerance));

  const summary: ReconcileSummary = {
    notes: rows.length,
    ties: rows.filter((r) => r.status === "ties").length,
    off: rows.filter((r) => r.status === "off").length,
    unknown: rows.filter((r) => r.status === "unknown").length,
    total_discrepancy: r2(
      rows.reduce((s, r) => (r.status === "off" ? s + Math.abs(r.delta ?? 0) : s), 0)
    ),
    needs_attention: rows.filter(needsAttention).length,
  };

  // Worst first: this page exists to be acted on, and a list sorted by date
  // buries the one note that needs a human behind twenty that do not.
  const rank = { off: 0, unknown: 1, ties: 2 };
  rows.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    const d = Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0);
    if (d !== 0) return d;
    return (a.trade_date ?? "").localeCompare(b.trade_date ?? "");
  });

  return { rows, summary };
}
