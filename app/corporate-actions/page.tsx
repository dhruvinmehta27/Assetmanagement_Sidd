"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ACTION_SPECS,
  ACTION_TYPES,
  ActionType,
  describeAction,
  multiplierOf,
  specOf,
  validateAction,
} from "@/app/lib/corporate-actions";

/**
 * Corporate actions — Table 4 of the spec.
 *
 * Ten action types, four mechanisms (see app/lib/corporate-actions.ts). The form
 * changes shape with the type because the types genuinely need different things:
 * a split needs a ratio, a demerger needs a ratio and a destination and a cost
 * split, a buyback needs a quantity and a price.
 *
 * **The preview is the point of this page.** A corporate action is entered from
 * a document nobody here can check, and a ratio entered the wrong way round is
 * invisible in the input and permanent in the cost basis. So before anything is
 * saved the page says, in shares, what it is about to do to the holding you
 * actually have — and after it is saved, the table says what it did.
 *
 * Note on the spec: Table 4 lists Broker and Client Code as filters. A corporate
 * action is not a fact about a broker, it is a fact about a security, and every
 * holder of that security gets it. So actions are recorded once, globally by
 * ISIN, and the account filter narrows the *effects* rather than the actions.
 */

interface Holding {
  isin: string;
  security_name: string | null;
  quantity: number;
  avg_cost: number;
  invested: number;
  delisted?: boolean;
}

interface Effect {
  action_id: string | null;
  isin: string;
  security_name: string | null;
  action_type: string;
  ex_date: string;
  applied: boolean;
  note: string | null;
  quantity_before: number;
  quantity_after: number;
  shares_received: number;
  cost_before: number;
  cost_moved: number;
  target_isin: string | null;
  target_quantity: number;
  realized_gain: number;
}

interface StoredAction {
  id: string;
  isin: string;
  symbol: string | null;
  security_name: string | null;
  action_type: string;
  ex_date: string;
  ratio_from: number | null;
  ratio_to: number | null;
  quantity_multiplier: number | null;
  target_isin: string | null;
  target_security_name: string | null;
  cost_fraction: number | null;
  price_per_share: number | null;
  quantity: number | null;
  notes: string | null;
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 4 });
}

/** Indian financial year label for an ISO date, mirroring analytics.finYear. */
function finYear(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export default function CorporateActionsPage() {
  const [actions, setActions] = useState<StoredAction[]>([]);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; label: string; pan: string | null }[]>([]);
  const [accountsSupported, setAccountsSupported] = useState(false);
  const [account, setAccount] = useState("");
  const [year, setYear] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Set when a discovered action needs finishing by hand — the exchange
  // published the event but not every number the engine needs.
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = account ? `?accounts=${encodeURIComponent(account)}` : "";
      const [pRes, cRes] = await Promise.all([
        fetch(`/api/portfolio${qs}`, { cache: "no-store" }),
        fetch("/api/corporate-actions", { cache: "no-store" }),
      ]);
      const [p, c] = await Promise.all([pRes.json(), cRes.json()]);
      if (!pRes.ok) throw new Error(p.error || "Could not load holdings.");
      if (!cRes.ok) throw new Error(c.error || "Could not load corporate actions.");
      setHoldings(p.holdings ?? []);
      setEffects(p.actionEffects ?? []);
      setAccounts(p.accounts ?? []);
      setAccountsSupported(Boolean(p.accountsSupported));
      setActions(c.corporateActions ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  const effectById = useMemo(() => {
    const m = new Map<string, Effect>();
    for (const e of effects) {
      m.set(e.action_id ?? `${e.isin}|${e.action_type}|${e.ex_date}`, e);
    }
    return m;
  }, [effects]);

  const years = useMemo(
    () => Array.from(new Set(actions.map((a) => finYear(a.ex_date)).filter(Boolean))).sort(),
    [actions]
  );

  const rows = year ? actions.filter((a) => finYear(a.ex_date) === year) : actions;
  const noEffect = effects.filter((e) => !e.applied).length;

  async function remove(a: StoredAction) {
    setError(null);
    try {
      const res = await fetch(`/api/corporate-actions?id=${encodeURIComponent(a.id)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not delete.");
      setMessage(`Removed the ${a.action_type.toLowerCase()} on ${a.security_name || a.isin}.`);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <main className="container">
      <header className="header">
        <h1>Corporate Actions</h1>
        <p className="subtitle">
          Splits, bonuses, demergers, mergers, rights, buybacks, delistings and the
          rest. A corporate action is a fact about a security, so it is recorded
          once here and applied to every account that held it on the ex-date.
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {message && <div className="card muted">{message}</div>}
      {loading && <div className="card muted">Loading…</div>}

      <div className="card">
        <div className="formrow">
          {accountsSupported && (
            <label className="datefield">
              Effects for
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.pan ? ` · ${a.pan}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="datefield">
            Financial year
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <a href="/portfolio" className="link-right">
            Portfolio &amp; P&amp;L →
          </a>
        </div>
        <p className="footnote">
          The action list is global. The account filter changes whose holdings the
          effects are measured against — a bonus on a security one person holds
          and another does not did something for one of them and nothing for the
          other.
        </p>
      </div>

      {noEffect > 0 && (
        <div className="card error">
          <p>
            <strong>
              {noEffect} recorded action{noEffect === 1 ? "" : "s"} changed nothing.
            </strong>
          </p>
          <p className="footnote">
            Usually the ISIN or the ex-date does not match any holding. An action
            that changes nothing is not harmless — it looks recorded, so nobody
            looks again.
          </p>
        </div>
      )}

      <section className="card">
        <h2>Recorded actions ({rows.length})</h2>
        <div className="table-wrap">
          <table className="recon-table">
            <thead>
              <tr>
                <th>Security</th>
                <th>Type</th>
                <th>Ex-date</th>
                <th>What it says</th>
                <th className="num">Quantity</th>
                <th className="num">Received</th>
                <th>Effect</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const e = effectById.get(a.id);
                return (
                  <tr key={a.id}>
                    {/* Security names off a contract note run long — "(YESBANK
                        NSE) YES BANK LTD." — and the global nowrap keeps them on
                        one line, which is what took this column to 373px and the
                        table past its card. Let them wrap. */}
                    <td>
                      <div className="clamp">
                        {/* The stored action often carries no name — it is keyed
                            by ISIN, and an ISIN is all that is needed to record
                            one. The effect knows the name: it found the holding. */}
                        {a.security_name || e?.security_name || "—"}
                        <div className="mono">{a.isin}</div>
                      </div>
                    </td>
                    <td>
                      <div className="clamp">{specOf(a.action_type)?.label ?? a.action_type}</div>
                    </td>
                    <td>{a.ex_date}</td>
                    <td className="footnote recon-detail">
                      <div className="clamp">{describeAction(a)}</div>
                    </td>
                    {/* Before and after in one column: two columns of the same
                        number either side of an arrow cost 90px and said no
                        more than the arrow does. */}
                    <td className="num">
                      {e ? `${qty(e.quantity_before)} → ${qty(e.quantity_after)}` : "—"}
                    </td>
                    <td className="num">
                      {e && e.shares_received
                        ? `${e.shares_received > 0 ? "+" : ""}${qty(e.shares_received)}`
                        : e && e.target_quantity
                        ? `→ ${qty(e.target_quantity)}`
                        : "—"}
                    </td>
                    <td className="status-cell">
                      {e?.applied ? (
                        <span className="badge buy">applied</span>
                      ) : (
                        <span className="badge sell">no effect</span>
                      )}
                    </td>
                    <td className="status-cell">
                      <button className="linkbtn" onClick={() => remove(a)}>
                        remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {year
                      ? `Nothing recorded in ${year}.`
                      : "Nothing recorded yet. Every holding figure currently assumes no corporate action has happened — which is an assumption, not a finding."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.some((a) => effectById.get(a.id) && !effectById.get(a.id)!.applied) && (
          <p className="footnote">
            {rows
              .filter((a) => effectById.get(a.id) && !effectById.get(a.id)!.applied)
              .map((a) => `${a.security_name || a.isin}: ${effectById.get(a.id)!.note}`)
              .join(" · ")}
          </p>
        )}
      </section>

      <Discover
        onSaved={(m) => {
          setMessage(m);
          load();
        }}
        onError={setError}
        onPrefill={setPrefill}
      />

      <ActionForm
        holdings={holdings}
        prefill={prefill}
        onSaved={(m) => {
          setMessage(m);
          setPrefill(null);
          load();
        }}
        onError={setError}
      />
    </main>
  );
}

export interface Prefill {
  action_type: ActionType;
  isin: string;
  security_name: string;
  ex_date: string;
  ratio_from: string;
  ratio_to: string;
  price_per_share: string;
}

interface Candidate {
  isin: string;
  security_name: string | null;
  symbol: string | null;
  ex_date: string;
  subject: string;
  sources: string[];
  parsed: {
    action_type: ActionType;
    ratio_from: number | null;
    ratio_to: number | null;
    price_per_share: number | null;
    confidence: "exact" | "partial" | "none";
    missing: string[];
  } | null;
  quantity_on_date: number;
  already_recorded: boolean;
}

/**
 * Look up what the exchanges published for the securities you have traded.
 *
 * This is the only part of the desktop app that reaches the internet apart from
 * reading a PDF, so it runs on a button press and never on page load — asking an
 * exchange about an ISIN tells it which security you are interested in.
 *
 * Nothing it finds is applied automatically. An "exact" candidate carries a
 * ratio parsed out of a line of English, which is precisely the value that
 * silently corrupts a cost basis if it is wrong, so accepting it is a decision
 * with the numbers in front of you. Anything the exchange did not fully publish
 * — a demerger's cost split, how many rights you actually took up — drops into
 * the manual form with what is known already filled in.
 */
function Discover({
  onSaved,
  onError,
  onPrefill,
}: {
  onSaved: (message: string) => void;
  onError: (message: string) => void;
  onPrefill: (p: Prefill) => void;
}) {
  const [busy, setBusy] = useState(false);
  // The demerger whose filing is being read, if any.
  const [terms, setTerms] = useState<Candidate | null>(null);
  const [result, setResult] = useState<{
    candidates: Candidate[];
    from: string;
    to: string;
    isins: number;
    sources: string[];
    problems: string[];
    counts: { total: number; held: number; exact: number; already: number };
  } | null>(null);
  const [heldOnly, setHeldOnly] = useState(true);
  const [accepting, setAccepting] = useState<string | null>(null);

  async function search() {
    setBusy(true);
    onError("");
    try {
      const res = await fetch("/api/corporate-actions/discover", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Lookup failed.");
      setResult(json);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function accept(c: Candidate) {
    if (!c.parsed) return;
    setAccepting(c.isin + c.ex_date);
    try {
      const res = await fetch("/api/corporate-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isin: c.isin,
          security_name: c.security_name,
          action_type: c.parsed.action_type,
          ex_date: c.ex_date,
          ratio_from: c.parsed.ratio_from,
          ratio_to: c.parsed.ratio_to,
          price_per_share: c.parsed.price_per_share,
          ratio_text: c.subject,
          // Recorded so it is always clear which rows a person entered and which
          // came off a feed and were only approved.
          source: c.sources.join("+").toLowerCase(),
          notes: `From ${c.sources.join(" and ")}: "${c.subject}"`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save.");
      onSaved(`Recorded the ${c.parsed.action_type.toLowerCase()} on ${c.security_name || c.isin}.`);
      setResult((r) =>
        r
          ? {
              ...r,
              candidates: r.candidates.map((x) =>
                x === c ? { ...x, already_recorded: true } : x
              ),
            }
          : r
      );
    } catch (err: any) {
      onError(err.message);
    } finally {
      setAccepting(null);
    }
  }

  const shown = result
    ? result.candidates.filter((c) => (heldOnly ? c.quantity_on_date > 0 : true))
    : [];

  return (
    <section className="card">
      <h2>Find actions from the exchanges</h2>
      <p className="footnote recon-detail">
        Looks up NSE (and BSE as a fallback) for every ISIN you have traded, from
        your first trade to today. <strong>This is the only part of the app that
        goes to the internet apart from reading a PDF</strong> — it runs when you
        press the button, never on its own, because asking an exchange about an
        ISIN tells them you hold it. Nothing found is applied until you accept it.
      </p>

      <div className="formrow">
        <button className="btn" onClick={search} disabled={busy}>
          {busy ? "Looking…" : "Look up corporate actions"}
        </button>
        {result && (
          <label className="datefield">
            Show
            <select
              value={heldOnly ? "held" : "all"}
              onChange={(e) => setHeldOnly(e.target.value === "held")}
            >
              <option value="held">Only where you held shares ({result.counts.held})</option>
              <option value="all">Everything found ({result.counts.total})</option>
            </select>
          </label>
        )}
      </div>

      {busy && (
        <p className="footnote">
          Fetching a couple of megabytes from NSE — this takes a few seconds.
        </p>
      )}

      {result && (
        <>
          <p className="footnote recon-detail">
            {result.counts.total} action{result.counts.total === 1 ? "" : "s"} across{" "}
            {result.isins} traded ISINs between {result.from} and {result.to}, via{" "}
            {result.sources.join(" and ")}. {result.counts.held} landed on a security you
            held at the time. Meetings, interest payments and dividends are filtered out —
            a dividend belongs in the dividends table, not this one.
            {result.problems.length > 0 && ` ${result.problems.join(" ")}`}
          </p>

          <div className="table-wrap">
            <table className="recon-table">
              <thead>
                <tr>
                  <th>Security</th>
                  <th>Ex-date</th>
                  <th>What the exchange published</th>
                  <th>Read as</th>
                  <th className="num">Held then</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const p = c.parsed!;
                  const key = c.isin + c.ex_date + p.action_type;
                  const exact = p.confidence === "exact";
                  return (
                    <tr key={key}>
                      <td>
                        <div className="clamp">
                          {c.security_name || c.isin}
                          <div className="mono">{c.isin}</div>
                        </div>
                      </td>
                      <td>{c.ex_date}</td>
                      <td className="footnote recon-detail">
                        {/* Verbatim, so a parse can always be checked against
                            the words it came from. */}
                        <div className="clamp">
                          {c.subject}
                          <div className="mono">{c.sources.join(" · ")}</div>
                        </div>
                      </td>
                      <td className="footnote recon-detail">
                        <div className="clamp">
                          <strong>{specOf(p.action_type)?.label ?? p.action_type}</strong>
                          {p.ratio_from && p.ratio_to ? ` ${p.ratio_from} → ${p.ratio_to}` : ""}
                          {p.price_per_share != null ? ` at ₹${money(p.price_per_share)}` : ""}
                          {!exact && (
                            <div>
                              Needs: {p.missing.join("; ")}.
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="num">{c.quantity_on_date > 0 ? qty(c.quantity_on_date) : "—"}</td>
                      <td className="status-cell">
                        {c.already_recorded ? (
                          <span className="badge">recorded</span>
                        ) : exact ? (
                          <button
                            className="btn"
                            onClick={() => accept(c)}
                            disabled={accepting === c.isin + c.ex_date}
                          >
                            {accepting === c.isin + c.ex_date ? "…" : "Accept"}
                          </button>
                        ) : p.action_type === "DEMERGER" ? (
                          // A demerger's terms are never in the feed, only in
                          // the company's own filing — so offer to go and read
                          // it rather than sending someone to the form with
                          // three blanks and no idea where to find them.
                          <button className="btn" onClick={() => setTerms(c)}>
                            Find the terms
                          </button>
                        ) : (
                          <button
                            className="linkbtn"
                            onClick={() =>
                              onPrefill({
                                action_type: p.action_type,
                                isin: c.isin,
                                security_name: c.security_name ?? "",
                                ex_date: c.ex_date,
                                ratio_from: p.ratio_from != null ? String(p.ratio_from) : "",
                                ratio_to: p.ratio_to != null ? String(p.ratio_to) : "",
                                price_per_share:
                                  p.price_per_share != null ? String(p.price_per_share) : "",
                              })
                            }
                          >
                            complete ↓
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      {heldOnly && result.counts.total > 0
                        ? "Nothing landed on a security you held at the time. Switch to “Everything found” to see the rest."
                        : "Nothing found for your ISINs in this period."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="footnote recon-detail">
            <strong>Accept</strong> records it as published. <strong>Find the terms</strong>{" "}
            goes and reads the company&apos;s own filing for a demerger&apos;s numbers.{" "}
            <strong>complete ↓</strong> fills in the form below with what is known — only
            you know how many rights you took up.
          </p>
        </>
      )}

      {terms && (
        <SchemeTerms
          candidate={terms}
          onClose={() => setTerms(null)}
          onSaved={(m) => {
            onSaved(m);
            setTerms(null);
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

interface Leg {
  company_name: string;
  undertaking: string | null;
  ratio_from: number | null;
  ratio_to: number | null;
  cost_fraction: number | null;
  matches: { isin: string; name: string; score: number }[];
}

/**
 * The demerger terms, read out of the company's filing.
 *
 * A scheme apportions cost basis across every company it creates, and the
 * percentages are all shares of the *original* cost — so these are accepted
 * together, as the one event they are, and the engine pays each out of the same
 * starting figure.
 *
 * The ISIN per company is a dropdown and not a fact. Two of Vedanta's four
 * resulting companies listed under names the scheme never used, and while the
 * business description usually bridges that, "usually" is not good enough for a
 * field that decides where a fifth of a cost basis lives.
 */
function SchemeTerms({
  candidate,
  onClose,
  onSaved,
  onError,
}: {
  candidate: Candidate;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<{
    chosen: { date: string | null; kind: string; text: string; url: string };
    terms: { parent_company: string | null; parent_cost_fraction: number | null; record_date: string | null; legs: Leg[]; notes: string | null };
    warnings: string[];
    message?: string;
  } | null>(null);
  // ISIN chosen per leg, keyed by company name. Starts at the best match.
  const [picks, setPicks] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/corporate-actions/terms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: candidate.symbol,
            isin: candidate.isin,
            ex_date: candidate.ex_date,
            security_name: candidate.security_name,
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error || "Could not read the filing.");
        setData(json);
        setPicks(
          Object.fromEntries(
            (json.terms?.legs ?? []).map((l: Leg) => [l.company_name, l.matches[0]?.isin ?? ""])
          )
        );
      } catch (err: any) {
        if (!cancelled) {
          onError(err.message);
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate]);

  const legs = data?.terms?.legs ?? [];
  const ready =
    legs.length > 0 &&
    legs.every((l) => picks[l.company_name] && l.cost_fraction !== null && l.ratio_from && l.ratio_to);

  async function acceptAll() {
    setSaving(true);
    try {
      for (const leg of legs) {
        const target = picks[leg.company_name];
        const match = leg.matches.find((m) => m.isin === target);
        const res = await fetch("/api/corporate-actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            isin: candidate.isin,
            security_name: candidate.security_name,
            action_type: "DEMERGER",
            ex_date: candidate.ex_date,
            ratio_from: leg.ratio_from,
            ratio_to: leg.ratio_to,
            target_isin: target,
            target_security_name: match?.name ?? leg.company_name,
            cost_fraction: leg.cost_fraction,
            source: "nse+filing",
            notes: `${leg.company_name}${leg.undertaking ? ` (${leg.undertaking})` : ""} — ${(
              (leg.cost_fraction ?? 0) * 100
            ).toFixed(2)}% of cost per the filing of ${data?.chosen.date ?? "the company"}.`,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(`${leg.company_name}: ${json.error}`);
      }
      onSaved(
        `Recorded ${legs.length} legs of the ${candidate.security_name || candidate.isin} demerger.`
      );
    } catch (err: any) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const retained = data?.terms?.parent_cost_fraction;

  return (
    <div className="card">
      <h3>
        Terms of the {candidate.security_name || candidate.isin} demerger
        <button className="linkbtn" onClick={onClose}>
          close
        </button>
      </h3>

      {loading && (
        <p className="footnote recon-detail">
          Looking through {candidate.symbol}&apos;s filings for the cost-apportionment
          notice, then reading it. This takes about fifteen seconds and costs one Claude
          call.
        </p>
      )}

      {!loading && data && !data.terms && (
        <p className="footnote recon-detail">{data.message}</p>
      )}

      {!loading && data?.terms && (
        <>
          <p className="footnote recon-detail">
            From{" "}
            <a href={data.chosen.url} target="_blank" rel="noreferrer">
              the company&apos;s filing of {data.chosen.date}
            </a>
            {data.terms.record_date && <> · record date {data.terms.record_date}</>}
            {retained != null && (
              <>
                {" "}
                · <strong>{candidate.security_name || "the parent"} keeps{" "}
                {(retained * 100).toFixed(2)}%</strong> of the cost basis
              </>
            )}
            .
          </p>

          {data.warnings.map((w) => (
            <p key={w} className="footnote recon-detail neg">
              ⚠️ {w}
            </p>
          ))}

          <div className="table-wrap">
            <table className="recon-table">
              <thead>
                <tr>
                  <th>Company in the filing</th>
                  <th>Business</th>
                  <th className="num">Shares</th>
                  <th className="num">Cost</th>
                  <th>Which listed security is this?</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l) => (
                  <tr key={l.company_name}>
                    <td>
                      <div className="clamp">{l.company_name}</div>
                    </td>
                    <td className="footnote recon-detail">
                      <div className="clamp">{l.undertaking || "—"}</div>
                    </td>
                    <td className="num">
                      {l.ratio_from && l.ratio_to ? `${l.ratio_to} per ${l.ratio_from}` : "—"}
                    </td>
                    <td className="num">
                      {l.cost_fraction != null ? `${(l.cost_fraction * 100).toFixed(2)}%` : "—"}
                    </td>
                    <td>
                      {/* A dropdown, not a fact — see the note above this
                          component about renamed companies. */}
                      <select
                        value={picks[l.company_name] ?? ""}
                        onChange={(e) =>
                          setPicks({ ...picks, [l.company_name]: e.target.value })
                        }
                      >
                        <option value="">Choose…</option>
                        {l.matches.map((m) => (
                          <option key={m.isin} value={m.isin}>
                            {m.name} · {m.isin}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.terms.notes && (
            <p className="footnote recon-detail">
              <strong>From the filing:</strong> {data.terms.notes}
            </p>
          )}

          <div className="formrow">
            <button className="btn" onClick={acceptAll} disabled={!ready || saving}>
              {saving ? "…" : `Record all ${legs.length} legs`}
            </button>
          </div>
          <p className="footnote recon-detail">
            These are recorded together because they are one event: every percentage is a
            share of the cost basis as it stood before the demerger, so applying them one
            at a time against a shrinking balance would short the later companies. Check
            each listed security above first — the scheme&apos;s names and the exchange&apos;s
            names do not always agree.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The entry form. Shape follows the chosen type, and it refuses to submit for
 * exactly the reasons the server would — same validator, imported.
 */
function ActionForm({
  holdings,
  prefill,
  onSaved,
  onError,
}: {
  holdings: Holding[];
  prefill: Prefill | null;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [type, setType] = useState<ActionType>("SPLIT");
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // A discovered action arriving from the panel above. Scrolled into view
  // because the form is below the fold on any real list, and a button that
  // silently fills in something off-screen looks like it did nothing.
  useEffect(() => {
    if (!prefill) return;
    setType(prefill.action_type);
    setF({
      isin: prefill.isin,
      security_name: prefill.security_name,
      ex_date: prefill.ex_date,
      ratio_from: prefill.ratio_from,
      ratio_to: prefill.ratio_to,
      price_per_share: prefill.price_per_share,
    });
    document.getElementById("action-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [prefill]);

  const spec = ACTION_SPECS[type];
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  // An untouched form fails validation for the obvious reason that it is empty.
  // Listing those failures before anyone has typed reads as a broken page, so
  // hold the box neutral until there is something to be wrong about.
  const touched = Object.values(f).some((v) => v !== "");

  const draft = {
    isin: f.isin ?? "",
    action_type: type,
    ex_date: f.ex_date ?? "",
    ratio_from: f.ratio_from === undefined || f.ratio_from === "" ? null : Number(f.ratio_from),
    ratio_to: f.ratio_to === undefined || f.ratio_to === "" ? null : Number(f.ratio_to),
    target_isin: f.target_isin ?? "",
    cost_fraction:
      f.cost_fraction === undefined || f.cost_fraction === "" ? null : Number(f.cost_fraction),
    price_per_share:
      f.price_per_share === undefined || f.price_per_share === "" ? null : Number(f.price_per_share),
    quantity: f.quantity === undefined || f.quantity === "" ? null : Number(f.quantity),
  };

  const errors = validateAction(draft);
  const holding = holdings.find((h) => h.isin === draft.isin.trim());
  const preview = previewOf(type, draft, holding);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (errors.length > 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/corporate-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          security_name: f.security_name || holding?.security_name || null,
          target_security_name: f.target_security_name || null,
          notes: f.notes || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save.");
      onSaved(`Recorded the ${spec.label.toLowerCase()}.`);
      setF({});
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="action-form">
      <h2>Record a corporate action</h2>

      <form onSubmit={submit} className="entryform">
        <div className="formrow">
          <label className="datefield">
            Type
            <select value={type} onChange={(e) => setType(e.target.value as ActionType)}>
              {ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACTION_SPECS[t].label}
                </option>
              ))}
            </select>
          </label>
          <label className="datefield">
            Ex-date
            <input type="date" value={f.ex_date || ""} onChange={set("ex_date")} required />
          </label>
        </div>
        <p className="hint">{spec.blurb}</p>

        <div className="formrow">
          {/* A datalist rather than a plain text box: the ISIN is what ties an
              action to a holding, and a typo here is the single most common way
              to record an action that silently does nothing. */}
          <input
            placeholder="ISIN *"
            list="held-isins"
            value={f.isin || ""}
            onChange={set("isin")}
            required
          />
          <datalist id="held-isins">
            {holdings.map((h) => (
              <option key={h.isin} value={h.isin}>
                {h.security_name ?? ""} — {qty(h.quantity)} held
              </option>
            ))}
          </datalist>
          <input
            placeholder="Security name"
            value={f.security_name ?? holding?.security_name ?? ""}
            onChange={set("security_name")}
          />
        </div>

        {spec.needs.ratio && spec.ratioWords && (
          <>
            <div className="formrow">
              <input
                type="number"
                step="any"
                placeholder={spec.ratioWords.from}
                value={f.ratio_from || ""}
                onChange={set("ratio_from")}
              />
              <span className="hint">→</span>
              <input
                type="number"
                step="any"
                placeholder={spec.ratioWords.to}
                value={f.ratio_to || ""}
                onChange={set("ratio_to")}
              />
            </div>
            <p className="hint">{spec.ratioWords.hint}</p>
          </>
        )}

        {spec.needs.target && (
          <div className="formrow">
            <input
              placeholder="Target ISIN *"
              value={f.target_isin || ""}
              onChange={set("target_isin")}
            />
            <input
              placeholder="Target security name"
              value={f.target_security_name || ""}
              onChange={set("target_security_name")}
            />
          </div>
        )}

        {spec.needs.costFraction && (
          <>
            <div className="formrow">
              <input
                type="number"
                step="any"
                min="0"
                max="1"
                placeholder="Share of cost that moves (0–1) *"
                value={f.cost_fraction || ""}
                onChange={set("cost_fraction")}
              />
            </div>
            <p className="hint">
              The demerger scheme sets this. 0.3 means 30% of the cost basis moves
              to the new company and the parent keeps 70%. Getting it wrong does
              not change your share count, so nothing will look wrong — it moves
              gains between the two companies for good.
            </p>
          </>
        )}

        {(spec.needs.price || spec.needs.quantity) && (
          <div className="formrow">
            {spec.needs.price && (
              <input
                type="number"
                step="any"
                placeholder={type === "LIQUIDATION" ? "Amount distributed per share" : "Price per share *"}
                value={f.price_per_share || ""}
                onChange={set("price_per_share")}
              />
            )}
            {spec.needs.quantity && (
              <input
                type="number"
                step="any"
                placeholder={
                  type === "RIGHTS_ISSUE" ? "Shares taken up (optional)" : "Shares accepted *"
                }
                value={f.quantity || ""}
                onChange={set("quantity")}
              />
            )}
          </div>
        )}

        <div className="formrow">
          <input placeholder="Note (optional)" value={f.notes || ""} onChange={set("notes")} />
        </div>

        {/* The safety net. Nothing about a ratio looks wrong on the way in. */}
        <div className={`card ${touched && errors.length > 0 ? "error" : "muted"}`}>
          {!touched ? (
            <p className="footnote recon-detail">
              Fill this in and it will say, in shares, what it is about to do to
              the holding you actually have — before anything is saved.
            </p>
          ) : errors.length > 0 ? (
            <ul className="recon-detail" style={{ margin: 0, paddingLeft: 18 }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : (
            <p>
              <strong>{preview.headline}</strong>
              {preview.detail && (
                <>
                  <br />
                  <span className="footnote">{preview.detail}</span>
                </>
              )}
            </p>
          )}
        </div>

        <div className="formrow">
          <button className="btn" disabled={busy || errors.length > 0}>
            {busy ? "…" : "Record it"}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * What this action will do, in shares, to the holding actually on file.
 *
 * Deliberately computed from the same numbers the engine will use, so if this
 * reads wrong the saved result will be wrong in the same way — which is the
 * whole point of showing it before the save rather than after.
 */
function previewOf(
  type: ActionType,
  d: {
    isin: string;
    ratio_from: number | null;
    ratio_to: number | null;
    cost_fraction: number | null;
    price_per_share: number | null;
    quantity: number | null;
    target_isin: string;
  },
  holding: Holding | undefined
): { headline: string; detail: string | null } {
  if (!holding) {
    return {
      headline: "No holding on file for that ISIN.",
      detail:
        "The action will save, but it will change nothing until a matching holding exists. Check the ISIN against the Portfolio page.",
    };
  }

  const held = holding.quantity;
  const name = holding.security_name || holding.isin;
  const m = multiplierOf(d.ratio_from, d.ratio_to);
  const spec = ACTION_SPECS[type];

  switch (spec.mechanism) {
    case "RATIO": {
      if (m === null) return { headline: "Enter the ratio to see what it does.", detail: null };
      const after = held * m;
      return {
        headline: `${qty(held)} ${name} become ${qty(after)} — ${
          after > held ? `${qty(after - held)} more` : `${qty(held - after)} fewer`
        }.`,
        detail: `Total cost stays ₹${money(holding.invested)}, so the average cost per share moves from ₹${money(
          holding.avg_cost
        )} to ₹${money(holding.invested / (after || 1))}.`,
      };
    }
    case "TRANSFER": {
      const ratio = type === "TICKER_CHANGE" ? 1 : m;
      if (ratio === null) return { headline: "Enter the exchange ratio to see what it does.", detail: null };
      const created = held * ratio;
      const fraction = spec.consumesSource ? 1 : Math.min(Math.max(d.cost_fraction ?? 0, 0), 1);
      const moved = holding.invested * fraction;
      return {
        headline: `${qty(held)} ${name} produce ${qty(created)} shares of ${
          d.target_isin || "the target"
        }.`,
        detail: spec.consumesSource
          ? `The whole ₹${money(holding.invested)} of cost moves across and ${name} disappears from the holdings.`
          : `₹${money(moved)} of the ₹${money(holding.invested)} cost basis moves; ${name} keeps ${qty(
              held
            )} shares at ₹${money(holding.invested - moved)}.`,
      };
    }
    case "ENTITLEMENT": {
      const taken = d.quantity && d.quantity > 0 ? d.quantity : m === null ? 0 : held * m;
      if (taken <= 0) return { headline: "Enter the ratio or the number taken up.", detail: null };
      const price = d.price_per_share ?? 0;
      return {
        headline: `${qty(taken)} new ${name} at ₹${money(price)} — ₹${money(taken * price)} paid.`,
        detail: `Holding goes from ${qty(held)} to ${qty(
          held + taken
        )}. These start their own holding period on the ex-date, so they are short-term for a year.`,
      };
    }
    case "EXIT": {
      if (type === "DELISTING") {
        return {
          headline: `${qty(held)} ${name} stay on the books, flagged as delisted.`,
          detail:
            "No loss is realised. Nothing has been disposed of, and a delisted share can relist.",
        };
      }
      const closing = type === "LIQUIDATION" ? held : Math.min(d.quantity ?? 0, held);
      if (closing <= 0) return { headline: "Enter the number of shares.", detail: null };
      const price = d.price_per_share ?? 0;
      const proceeds = closing * price;
      const cost = closing * holding.avg_cost;
      const gain = proceeds - cost;
      return {
        headline: `${qty(closing)} ${name} close at ₹${money(price)} — ₹${money(
          proceeds
        )} against ₹${money(cost)} of cost.`,
        detail: `${gain >= 0 ? "Gain" : "Loss"} of ₹${money(
          Math.abs(gain)
        )} realised, matched FIFO, so the split between short and long term depends on which lots it takes.`,
      };
    }
    default:
      return { headline: "This action does not change holdings.", detail: null };
  }
}
