/**
 * Canonical structure for a parsed broker contract note.
 *
 * This is intentionally broad: contract notes vary a lot between brokers and
 * exchanges, so every field is optional and the LLM is instructed to return
 * `null` when a value is genuinely absent (never to guess). The same shape is
 * used as the JSON Schema handed to the Claude "tool" for structured output,
 * so the two can never drift apart.
 */

export interface Trade {
  order_no: string | null;
  trade_no: string | null;
  trade_time: string | null;
  security_name: string | null;
  symbol: string | null;
  isin: string | null;
  exchange: string | null;
  segment: string | null; // e.g. Equity, F&O, Currency
  buy_sell: "BUY" | "SELL" | null;
  quantity: number | null;
  gross_rate: number | null; // price per unit before brokerage
  brokerage_per_unit: number | null;
  net_rate: number | null; // price per unit after brokerage
  gross_value: number | null; // quantity * gross_rate
  net_value: number | null;
}

export interface Charges {
  brokerage: number | null;
  exchange_transaction_charges: number | null;
  clearing_charges: number | null;
  sebi_turnover_fees: number | null;
  stt: number | null; // Securities Transaction Tax
  stamp_duty: number | null;
  ipft: number | null; // Investor Protection Fund
  gst: number | null; // total GST
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  demat_charges: number | null; // DP / "Dmt Chgs"
  rounding: number | null; // rounding adjustment (positive = credit to client)
  other_charges: number | null;
  total_charges: number | null;
}

export interface ContractNote {
  broker_name: string | null;
  broker_sebi_regn: string | null;
  contract_note_number: string | null;
  trade_date: string | null; // ISO YYYY-MM-DD when possible
  settlement_date: string | null;
  settlement_number: string | null;
  client_name: string | null;
  client_code: string | null;
  pan: string | null;
  exchange: string | null;
  currency: string | null;
  trades: Trade[];
  charges: Charges;
  net_amount: number | null; // final payable (negative) / receivable (positive)
  net_amount_direction: "PAYABLE" | "RECEIVABLE" | null;
  notes: string | null; // anything noteworthy the parser wants to flag
}

/**
 * JSON Schema for the Anthropic tool. Kept in sync with the interfaces above.
 * Using a tool (forced tool_choice) guarantees the model returns valid,
 * parseable JSON matching this shape rather than free-form text.
 */
export const CONTRACT_NOTE_TOOL = {
  name: "record_contract_note",
  description:
    "Record the fully structured data extracted from a broker contract note PDF.",
  input_schema: {
    type: "object" as const,
    properties: {
      broker_name: { type: ["string", "null"] },
      broker_sebi_regn: { type: ["string", "null"] },
      contract_note_number: { type: ["string", "null"] },
      trade_date: {
        type: ["string", "null"],
        description: "Trade date, ISO YYYY-MM-DD when it can be determined.",
      },
      settlement_date: { type: ["string", "null"] },
      settlement_number: { type: ["string", "null"] },
      client_name: { type: ["string", "null"] },
      client_code: { type: ["string", "null"] },
      pan: { type: ["string", "null"] },
      exchange: { type: ["string", "null"] },
      currency: {
        type: ["string", "null"],
        description: "ISO currency code if inferable, e.g. INR, USD.",
      },
      trades: {
        type: "array",
        items: {
          type: "object",
          properties: {
            order_no: { type: ["string", "null"] },
            trade_no: { type: ["string", "null"] },
            trade_time: { type: ["string", "null"] },
            security_name: { type: ["string", "null"] },
            symbol: { type: ["string", "null"] },
            isin: { type: ["string", "null"] },
            exchange: { type: ["string", "null"] },
            segment: { type: ["string", "null"] },
            buy_sell: { type: ["string", "null"], enum: ["BUY", "SELL", null] },
            quantity: { type: ["number", "null"] },
            gross_rate: { type: ["number", "null"] },
            brokerage_per_unit: { type: ["number", "null"] },
            net_rate: { type: ["number", "null"] },
            gross_value: { type: ["number", "null"] },
            net_value: { type: ["number", "null"] },
          },
          required: ["buy_sell", "quantity", "gross_rate"],
        },
      },
      charges: {
        type: "object",
        properties: {
          brokerage: { type: ["number", "null"] },
          exchange_transaction_charges: { type: ["number", "null"] },
          clearing_charges: { type: ["number", "null"] },
          sebi_turnover_fees: { type: ["number", "null"] },
          stt: { type: ["number", "null"] },
          stamp_duty: { type: ["number", "null"] },
          ipft: { type: ["number", "null"] },
          gst: { type: ["number", "null"] },
          cgst: { type: ["number", "null"] },
          sgst: { type: ["number", "null"] },
          igst: { type: ["number", "null"] },
          demat_charges: {
            type: ["number", "null"],
            description: "DP / demat charges, e.g. a line labelled 'Dmt Chgs'.",
          },
          rounding: {
            type: ["number", "null"],
            description:
              "Rounding adjustment. Positive if credited to the client (CR), negative if debited (DR).",
          },
          other_charges: { type: ["number", "null"] },
          total_charges: { type: ["number", "null"] },
        },
      },
      net_amount: { type: ["number", "null"] },
      net_amount_direction: {
        type: ["string", "null"],
        enum: ["PAYABLE", "RECEIVABLE", null],
      },
      notes: { type: ["string", "null"] },
    },
    required: ["trades", "charges"],
  },
} as const;
