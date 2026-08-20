/**
 * Corporate actions — the ten types in Table 4 of the spec, and the four
 * mechanisms they actually reduce to.
 *
 * The ten names are how a person thinks about it. The engine only needs to know
 * four things can happen to a holding:
 *
 *   RATIO        the same security, more or fewer shares, same total cost
 *                (split, reverse split, bonus)
 *   TRANSFER     cost basis moves to a different security
 *                (demerger, merger, ticker/ISIN change)
 *   ENTITLEMENT  new shares acquired at a price
 *                (rights issue)
 *   EXIT         the position closes, at a price or at nothing
 *                (buyback, liquidation) — and delisting, which deliberately
 *                does not close it
 *
 * Keeping the taxonomy here rather than in the engine is what stops the engine
 * growing a branch per action name.
 *
 * **On ratios.** This is the field that silently corrupts a cost basis for good,
 * and the notation is genuinely ambiguous in the wild: the spec writes a bonus as
 * "4:1 Bonus = 400 + 100 bonus" (four held, one received), while a split is
 * normally written "1:5" (one becomes five). Two conventions, one colon. So the
 * stored form is neither: `ratio_from` shares held **become** `ratio_to` shares,
 * always, for every type. `multiplierOf` is the single place that converts, and
 * the form asks in the words that suit each type and shows the result before
 * anything is saved.
 */

export const ACTION_TYPES = [
  "SPLIT",
  "REVERSE_SPLIT",
  "BONUS",
  "DEMERGER",
  "MERGER",
  "TICKER_CHANGE",
  "RIGHTS_ISSUE",
  "BUYBACK",
  "DELISTING",
  "LIQUIDATION",
  "OTHER",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export type Mechanism = "RATIO" | "TRANSFER" | "ENTITLEMENT" | "EXIT" | "NONE";

export interface ActionSpec {
  type: ActionType;
  label: string;
  mechanism: Mechanism;
  /** One line, shown under the type picker. Says what it will do to a holding. */
  blurb: string;
  /** Does the security this action names cease to exist? */
  consumesSource: boolean;
  /** Fields the form must collect beyond ISIN and ex-date. */
  needs: {
    ratio?: boolean;
    target?: boolean;
    costFraction?: boolean;
    price?: boolean;
    quantity?: boolean;
  };
  /** Wording for the two ratio inputs, which differs by type. */
  ratioWords?: { from: string; to: string; hint: string };
}

export const ACTION_SPECS: Record<ActionType, ActionSpec> = {
  SPLIT: {
    type: "SPLIT",
    label: "Split",
    mechanism: "RATIO",
    blurb: "More shares, same money. Quantity goes up, cost per share goes down.",
    consumesSource: false,
    needs: { ratio: true },
    ratioWords: {
      from: "shares held",
      to: "become",
      hint: "A 1-for-5 split: 1 share held becomes 5.",
    },
  },
  REVERSE_SPLIT: {
    type: "REVERSE_SPLIT",
    label: "Reverse split",
    mechanism: "RATIO",
    blurb: "Fewer shares, same money. Quantity goes down, cost per share goes up.",
    consumesSource: false,
    needs: { ratio: true },
    ratioWords: {
      from: "shares held",
      to: "become",
      hint: "A 5-into-1 consolidation: 5 shares held become 1.",
    },
  },
  BONUS: {
    type: "BONUS",
    label: "Bonus issue",
    mechanism: "RATIO",
    blurb: "Free shares. Quantity goes up, total cost is unchanged, so cost per share falls.",
    consumesSource: false,
    needs: { ratio: true },
    ratioWords: {
      from: "shares held",
      to: "become (held + bonus)",
      hint: "A 1-for-4 bonus: 4 held become 5 — enter 4 and 5, not 4 and 1.",
    },
  },
  DEMERGER: {
    type: "DEMERGER",
    label: "Demerger",
    mechanism: "TRANSFER",
    blurb:
      "A new company splits out. You keep the parent and receive shares in the child; part of the cost basis moves with them.",
    consumesSource: false,
    needs: { ratio: true, target: true, costFraction: true },
    ratioWords: {
      from: "parent shares held",
      to: "child shares received",
      hint: "1 share of the parent giving 1 of the child: enter 1 and 1.",
    },
  },
  MERGER: {
    type: "MERGER",
    label: "Merger / amalgamation",
    mechanism: "TRANSFER",
    blurb:
      "This security is absorbed into another. The whole holding and its cost move across at the exchange ratio.",
    consumesSource: true,
    needs: { ratio: true, target: true },
    ratioWords: {
      from: "shares of this company",
      to: "shares of the new one",
      hint: "Two companies merging into one: 400 of IOC + 200 of BPCL becoming 600 of the merged entity is two separate mergers.",
    },
  },
  TICKER_CHANGE: {
    type: "TICKER_CHANGE",
    label: "Name / ticker / ISIN change",
    mechanism: "TRANSFER",
    blurb:
      "Same company, new identity. Nothing about the holding changes except what it is called.",
    consumesSource: true,
    needs: { target: true },
  },
  RIGHTS_ISSUE: {
    type: "RIGHTS_ISSUE",
    label: "Rights issue",
    mechanism: "ENTITLEMENT",
    blurb:
      "New shares bought at a set price. A fresh purchase — its holding period starts on the ex-date.",
    consumesSource: false,
    needs: { ratio: true, price: true, quantity: true },
    ratioWords: {
      from: "shares held",
      to: "shares offered",
      hint: "1-for-3 rights: 3 held, 1 offered. Enter the quantity below if you took up fewer.",
    },
  },
  BUYBACK: {
    type: "BUYBACK",
    label: "Buyback",
    mechanism: "EXIT",
    blurb: "Shares sold back to the company. Matched FIFO and realised, like a sale.",
    consumesSource: false,
    needs: { price: true, quantity: true },
  },
  DELISTING: {
    type: "DELISTING",
    label: "Delisting",
    mechanism: "EXIT",
    blurb:
      "The holding stays on the books and is flagged. No loss is realised — a delisted share can relist, and until it is written off nothing has been disposed of.",
    consumesSource: false,
    needs: {},
  },
  LIQUIDATION: {
    type: "LIQUIDATION",
    label: "Liquidation",
    mechanism: "EXIT",
    blurb:
      "The company is wound up. The whole holding closes at whatever was distributed, usually nothing, realising the loss.",
    consumesSource: true,
    needs: { price: true },
  },
  OTHER: {
    type: "OTHER",
    label: "Other",
    mechanism: "RATIO",
    blurb: "Anything else that changes quantity against a fixed total cost.",
    consumesSource: false,
    needs: { ratio: true },
    ratioWords: { from: "shares held", to: "become", hint: "" },
  },
};

export function specOf(type: string): ActionSpec | null {
  return (ACTION_SPECS as Record<string, ActionSpec>)[type] ?? null;
}

export function mechanismOf(type: string): Mechanism {
  return specOf(type)?.mechanism ?? "NONE";
}

/**
 * The one conversion from a stored ratio to a quantity multiplier.
 *
 * Returns null when the ratio is unusable rather than defaulting to 1 — a
 * silent 1 is an action that appears to have been recorded and does nothing.
 */
export function multiplierOf(
  ratio_from: number | null | undefined,
  ratio_to: number | null | undefined
): number | null {
  const from = Number(ratio_from);
  const to = Number(ratio_to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from <= 0 || to <= 0) return null;
  return to / from;
}

export interface ActionDraft {
  isin?: string | null;
  action_type?: string | null;
  ex_date?: string | null;
  ratio_from?: number | null;
  ratio_to?: number | null;
  target_isin?: string | null;
  cost_fraction?: number | null;
  price_per_share?: number | null;
  quantity?: number | null;
}

/**
 * Everything wrong with a draft, as sentences. Returns [] when it is savable.
 *
 * Validation lives here rather than in the route so the form can run it as the
 * user types and refuse to submit for the same reasons the server would.
 */
export function validateAction(a: ActionDraft): string[] {
  const errors: string[] = [];

  if (!a.isin?.trim()) errors.push("An ISIN is required — it is what ties the action to a holding.");
  if (!a.ex_date?.trim()) errors.push("An ex-date is required.");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(a.ex_date.trim()))
    errors.push("The ex-date must be a calendar date (YYYY-MM-DD).");

  const spec = a.action_type ? specOf(a.action_type) : null;
  if (!spec) {
    errors.push("Pick an action type.");
    return errors;
  }

  if (spec.needs.ratio) {
    const m = multiplierOf(a.ratio_from, a.ratio_to);
    if (m === null) errors.push("Both sides of the ratio must be positive numbers.");
    else if (spec.type === "SPLIT" && m <= 1)
      errors.push("A split increases the share count — the second number must be the larger one.");
    else if (spec.type === "REVERSE_SPLIT" && m >= 1)
      errors.push("A reverse split reduces the share count — the second number must be the smaller one.");
    else if (spec.type === "BONUS" && m <= 1)
      errors.push(
        "A bonus increases the share count. Enter the total after the bonus, not the bonus alone — 4 held becoming 5, not 4 and 1."
      );
  }

  if (spec.needs.target && !a.target_isin?.trim())
    errors.push("The ISIN of the security the holding moves into is required.");

  if (spec.needs.target && a.target_isin?.trim() && a.target_isin.trim() === a.isin?.trim())
    errors.push("The target ISIN must differ from the one the action is on.");

  if (spec.needs.costFraction) {
    const f = Number(a.cost_fraction);
    if (!Number.isFinite(f) || f < 0 || f > 1)
      errors.push("The share of cost that moves must be between 0 and 1.");
  }

  if (spec.type === "BUYBACK") {
    const q = Number(a.quantity);
    if (!Number.isFinite(q) || q <= 0)
      errors.push("A buyback needs the number of shares actually accepted.");
    const p = Number(a.price_per_share);
    if (!Number.isFinite(p) || p < 0) errors.push("A buyback needs the price per share.");
  }

  if (spec.type === "RIGHTS_ISSUE") {
    const p = Number(a.price_per_share);
    if (!Number.isFinite(p) || p < 0) errors.push("A rights issue needs the issue price per share.");
    const hasRatio = multiplierOf(a.ratio_from, a.ratio_to) !== null;
    const q = Number(a.quantity);
    if (!hasRatio && !(Number.isFinite(q) && q > 0))
      errors.push("Give either the entitlement ratio or the number of shares taken up.");
  }

  return errors;
}

/** A one-line plain-English summary of a stored action, for lists. */
export function describeAction(a: {
  action_type: string;
  ratio_from?: number | null;
  ratio_to?: number | null;
  target_security_name?: string | null;
  target_isin?: string | null;
  price_per_share?: number | null;
  quantity?: number | null;
  cost_fraction?: number | null;
}): string {
  const spec = specOf(a.action_type);
  const m = multiplierOf(a.ratio_from, a.ratio_to);
  const target = a.target_security_name || a.target_isin || "another security";
  const ratio = a.ratio_from && a.ratio_to ? `${a.ratio_from} → ${a.ratio_to}` : "";

  switch (a.action_type) {
    case "SPLIT":
    case "REVERSE_SPLIT":
      return `${ratio} — every share becomes ${m?.toFixed(4).replace(/\.?0+$/, "")}`;
    case "BONUS":
      return `${ratio} — quantity ×${m?.toFixed(4).replace(/\.?0+$/, "")}, total cost unchanged`;
    case "DEMERGER":
      return `${ratio} into ${target}, carrying ${((a.cost_fraction ?? 0) * 100).toFixed(1)}% of the cost`;
    case "MERGER":
      return `${ratio} into ${target}`;
    case "TICKER_CHANGE":
      return `becomes ${target}`;
    case "RIGHTS_ISSUE":
      return a.quantity
        ? `${a.quantity} shares at ₹${a.price_per_share}`
        : `${ratio} at ₹${a.price_per_share}`;
    case "BUYBACK":
      return `${a.quantity} shares at ₹${a.price_per_share}`;
    case "DELISTING":
      return "holding retained, valued at nothing until relisted";
    case "LIQUIDATION":
      return `whole holding closed at ₹${a.price_per_share ?? 0}`;
    default:
      return spec?.label ?? a.action_type;
  }
}
