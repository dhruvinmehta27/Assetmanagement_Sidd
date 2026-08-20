import { FYPnl } from "@/app/lib/analytics";

/**
 * Capital gains tax on listed equity — Table 2 of the spec, rows B to N.
 *
 * Pure arithmetic over figures `pnlByFinancialYear` already produces. Nothing
 * here reads the database or the network.
 *
 * **Rates are configuration, not constants.** The ones below are the regime for
 * transfers on or after 23 July 2024 — 12.5% long-term with a ₹1.25 lakh
 * exemption, 20% short-term, 4% cess on both. They have changed twice in recent
 * memory and will change again, and a rate compiled into a formula is a rate
 * nobody finds when it does. `RATES_BY_YEAR` lets an older year keep its own.
 *
 * **This computes tax on listed equity with STT paid, and nothing else.** No
 * business income, no debt, no property, no carry-forward from prior years, no
 * surcharge, and no rebate. It is a working of one part of a return, not a
 * return.
 */

export interface TaxRates {
  /** Long-term gains exempt up to this much, per year, across all equity. */
  ltcgExemption: number;
  ltcgRate: number;
  stcgRate: number;
  cessRate: number;
  /** Shown on the page so nobody has to guess which regime produced a figure. */
  label: string;
}

export const DEFAULT_RATES: TaxRates = {
  ltcgExemption: 125_000,
  ltcgRate: 0.125,
  stcgRate: 0.2,
  cessRate: 0.04,
  label: "Transfers on or after 23 July 2024",
};

/**
 * Years that are not the current regime. A year absent from here uses
 * DEFAULT_RATES, which is right for 2024-25 onwards and wrong for older years —
 * so add them here rather than editing the default when an old year is needed.
 */
export const RATES_BY_YEAR: Record<string, TaxRates> = {
  "2023-24": {
    ltcgExemption: 100_000,
    ltcgRate: 0.1,
    stcgRate: 0.15,
    cessRate: 0.04,
    label: "Pre-23 July 2024 regime",
  },
};

export function ratesFor(financialYear: string): TaxRates {
  return RATES_BY_YEAR[financialYear] ?? DEFAULT_RATES;
}

/**
 * How losses are allowed to reduce gains.
 *
 * `law` — a short-term capital loss may be set off against short-term gains and
 * then against long-term gains; a long-term capital loss may be set off only
 * against long-term gains. That is s.74 of the Income-tax Act.
 *
 * `spreadsheet` — each bucket nets only within itself, which is what the
 * colleague's Table 2 does (`=A-C-E` and `=B-D`). It is offered so the two can
 * be compared line by line, not because it is right: in a year with short-term
 * losses and long-term gains it overstates the tax due.
 */
export type SetOffMode = "law" | "spreadsheet";

export interface TaxComputation {
  financial_year: string;
  rates: TaxRates;
  mode: SetOffMode;

  // Table 2 rows B–E, as realised.
  long_term_profit: number;
  short_term_profit: number;
  long_term_loss: number;
  short_term_loss: number;

  /** Where each loss ended up. Sums to the losses above, minus anything unused. */
  stcl_against_stcg: number;
  stcl_against_ltcg: number;
  ltcl_against_ltcg: number;
  /** Loss with nothing left to absorb it — carried forward, not used here. */
  unabsorbed_loss: number;

  // Rows F–H.
  ltcg_exemption_used: number;
  taxable_ltcg: number;
  taxable_stcg: number;

  // Rows I–N.
  ltcg_tax: number;
  ltcg_cess: number;
  ltcg_total: number;
  stcg_tax: number;
  stcg_cess: number;
  stcg_total: number;
  total_tax: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeTax(
  pnl: FYPnl,
  mode: SetOffMode = "law",
  rates: TaxRates = ratesFor(pnl.financial_year)
): TaxComputation {
  const ltProfit = Math.max(pnl.long_term_profit, 0);
  const stProfit = Math.max(pnl.short_term_profit, 0);
  const ltLoss = Math.max(pnl.long_term_loss, 0);
  const stLoss = Math.max(pnl.short_term_loss, 0);

  // A short-term loss goes against short-term gains first — it is the only loss
  // that can reach the long-term bucket, so spending it on the cheaper bucket
  // first is what leaves the most relief available.
  const stclAgainstStcg = Math.min(stLoss, stProfit);
  let stclLeft = stLoss - stclAgainstStcg;

  // A long-term loss can only ever offset long-term gains.
  const ltclAgainstLtcg = Math.min(ltLoss, ltProfit);
  let ltAfterOwnLoss = ltProfit - ltclAgainstLtcg;

  let stclAgainstLtcg = 0;
  if (mode === "law") {
    stclAgainstLtcg = Math.min(stclLeft, ltAfterOwnLoss);
    ltAfterOwnLoss -= stclAgainstLtcg;
    stclLeft -= stclAgainstLtcg;
  }

  const stcgAfterSetOff = stProfit - stclAgainstStcg;

  // The exemption applies to long-term gains only, and only to what survives the
  // set-off — there is nothing to exempt in a loss.
  const exemptionUsed = Math.min(rates.ltcgExemption, ltAfterOwnLoss);
  const taxableLtcg = Math.max(ltAfterOwnLoss - exemptionUsed, 0);
  const taxableStcg = Math.max(stcgAfterSetOff, 0);

  const ltcgTax = taxableLtcg * rates.ltcgRate;
  const ltcgCess = ltcgTax * rates.cessRate;
  const stcgTax = taxableStcg * rates.stcgRate;
  const stcgCess = stcgTax * rates.cessRate;

  return {
    financial_year: pnl.financial_year,
    rates,
    mode,
    long_term_profit: r2(ltProfit),
    short_term_profit: r2(stProfit),
    long_term_loss: r2(ltLoss),
    short_term_loss: r2(stLoss),
    stcl_against_stcg: r2(stclAgainstStcg),
    stcl_against_ltcg: r2(stclAgainstLtcg),
    ltcl_against_ltcg: r2(ltclAgainstLtcg),
    // Whatever no gain could absorb. It carries forward for eight years, which
    // this app does not track — it is reported so it is not silently lost.
    unabsorbed_loss: r2(stclLeft + (ltLoss - ltclAgainstLtcg)),
    ltcg_exemption_used: r2(exemptionUsed),
    taxable_ltcg: r2(taxableLtcg),
    taxable_stcg: r2(taxableStcg),
    ltcg_tax: r2(ltcgTax),
    ltcg_cess: r2(ltcgCess),
    ltcg_total: r2(ltcgTax + ltcgCess),
    stcg_tax: r2(stcgTax),
    stcg_cess: r2(stcgCess),
    stcg_total: r2(stcgTax + stcgCess),
    total_tax: r2(ltcgTax + ltcgCess + stcgTax + stcgCess),
  };
}

/**
 * Table 2 rows S and T: what the trading itself cost, per financial year.
 *
 * Note on the spec's formula for "Other Expenses Total", Table 1 AB: it reads
 * `(N+S+T+U+V)`, and N is WAP — a price per share, not an expense. That is
 * taken as a slip. Everything statutory is summed here instead, with brokerage
 * kept separate because Table 2 asks for it on its own line.
 *
 * These are informational. Brokerage is already inside the cost basis (net_value
 * is brokerage-inclusive), so adding it to a gain calculation would deduct it
 * twice, and STT is not a deductible cost of acquisition at all.
 */
export interface FYCosts {
  financial_year: string;
  brokerage: number;
  other_expenses: number;
  notes: number;
}

export interface ChargeBearingNote {
  trade_date: string | null;
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
  other_charges: number | null;
}

const n = (v: number | null | undefined) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function costsByFinancialYear(
  notes: ChargeBearingNote[],
  finYear: (iso: string) => string
): FYCosts[] {
  const map = new Map<string, FYCosts>();

  for (const note of notes) {
    if (!note.trade_date) continue;
    const fy = finYear(note.trade_date);
    let row = map.get(fy);
    if (!row) {
      row = { financial_year: fy, brokerage: 0, other_expenses: 0, notes: 0 };
      map.set(fy, row);
    }
    // GST is published both as a total and split into CGST/SGST/IGST; adding
    // both would count it twice.
    const gst = note.gst !== null && note.gst !== undefined
      ? n(note.gst)
      : n(note.cgst) + n(note.sgst) + n(note.igst);

    row.brokerage += n(note.brokerage);
    row.other_expenses +=
      n(note.exchange_transaction_charges) +
      n(note.clearing_charges) +
      n(note.sebi_turnover_fees) +
      n(note.stt) +
      n(note.stamp_duty) +
      n(note.ipft) +
      gst +
      n(note.demat_charges) +
      n(note.other_charges);
    row.notes += 1;
  }

  return Array.from(map.values())
    .map((c) => ({ ...c, brokerage: r2(c.brokerage), other_expenses: r2(c.other_expenses) }))
    .sort((a, b) => (a.financial_year < b.financial_year ? -1 : 1));
}
