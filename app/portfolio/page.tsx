"use client";

import { useEffect, useState, useCallback } from "react";

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function gainClass(n: number): string {
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

type Portfolio = {
  summary: {
    notes: number;
    trades: number;
    holdings: number;
    total_invested: number;
    total_realized: number;
    total_dividends: number;
  };
  storage?: { driver: "sqlite" | "supabase"; location: string; local: boolean };
  accountsSupported?: boolean;
  accounts?: { id: string; label: string; pan: string | null; entity_type: string }[];
  unassigned?: { groups: any[]; notes: number; trades: number };
  holdings: any[];
  pnl: any[];
  realized: any[];
  dividends: any[];
  dividendsByFY: any[];
  corporateActions: any[];
  actionEffects?: any[];
};

export default function PortfolioPage() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // "" = every account combined. A single id narrows the whole page, because
  // holdings and FIFO gains only mean anything within one person's trades.
  const [account, setAccount] = useState("");
  // Financial year narrows the P&L and dividend tables only — holdings are
  // as-of-today and have no financial year.
  const [year, setYear] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = account ? `?accounts=${encodeURIComponent(account)}` : "";
      const res = await fetch(`/api/portfolio${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load portfolio.");
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  const years: string[] = data
    ? Array.from(
        new Set([
          ...data.pnl.map((p: any) => p.financial_year),
          ...data.dividendsByFY.map((d: any) => d.financial_year),
        ])
      ).sort()
    : [];

  const pnlRows = year
    ? data?.pnl.filter((p: any) => p.financial_year === year) ?? []
    : data?.pnl ?? [];
  const divRows = year
    ? data?.dividendsByFY.filter((d: any) => d.financial_year === year) ?? []
    : data?.dividendsByFY ?? [];

  return (
    <main className="container">
      <header className="header">
        <h1>Portfolio &amp; P&amp;L</h1>
        <p className="subtitle">
          Holdings, realized profit/loss by Indian financial year, and dividends
          — computed from all your saved contract notes (FIFO, corporate-action
          adjusted).
        </p>
      </header>

      {data?.accountsSupported && (
        <div className="card">
          <div className="formrow">
            <label className="datefield">
              Account
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">All accounts</option>
                {(data.accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.pan ? ` · ${a.pan}` : ""}
                  </option>
                ))}
              </select>
            </label>
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
            <a href="/accounts" className="link-right">
              Manage accounts →
            </a>
          </div>
          {(data.accounts ?? []).length === 0 && (
            <p className="footnote">
              No accounts yet, so nothing can be counted. Add one on the{" "}
              <a href="/accounts">Accounts</a> page, then assign your imported notes
              to it.
            </p>
          )}
          <p className="footnote">
            Holdings and gains are computed per person across every broker, so they
            cannot be split by broker — a sale at one broker can consume shares
            bought at another.
          </p>
        </div>
      )}

      {data?.unassigned && data.unassigned.notes > 0 && (
        <div className="card error">
          <p>
            <strong>
              {data.unassigned.notes} contract note
              {data.unassigned.notes === 1 ? "" : "s"} ({data.unassigned.trades} trade
              {data.unassigned.trades === 1 ? "" : "s"}) are not counted below.
            </strong>
          </p>
          <p className="footnote">
            They were imported but no account claims them yet. Assign them on the{" "}
            <a href="/accounts">Accounts</a> page and these figures will include them.
          </p>
        </div>
      )}

      {error && <div className="card error">⚠️ {error}</div>}
      {loading && <div className="card muted">Loading portfolio…</div>}

      {data?.storage && (
        <p className="footnote">
          {data.storage.local ? (
            <>
              Stored locally on this Mac —{" "}
              <span className="mono">{data.storage.location}</span>. Nothing in this
              view has left the machine.
            </>
          ) : (
            <>
              Stored in Supabase (<span className="mono">{data.storage.location}</span>).
            </>
          )}
        </p>
      )}

      {data && (
        <>
          <section className="statgrid">
            <Stat label="Contract notes" value={String(data.summary.notes)} />
            <Stat label="Trades" value={String(data.summary.trades)} />
            <Stat label="Open holdings" value={String(data.summary.holdings)} />
            <Stat label="Invested (open)" value={`₹${money(data.summary.total_invested)}`} />
            <Stat
              label="Realized P&L"
              value={`₹${money(data.summary.total_realized)}`}
              cls={gainClass(data.summary.total_realized)}
            />
            <Stat label="Dividends" value={`₹${money(data.summary.total_dividends)}`} />
          </section>

          {/* Holdings */}
          <section className="card">
            <h2>Current holdings ({data.holdings.length})</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Security</th>
                    <th>ISIN</th>
                    <th className="num">Qty</th>
                    <th className="num">Avg cost</th>
                    <th className="num">Invested</th>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map((h, i) => (
                    <tr key={i}>
                      <td>
                        {h.security_name || "—"}
                        {/* A delisted holding keeps its cost basis and its
                            quantity — nothing has been disposed of — but it is
                            worth nothing until it relists, so say so here
                            rather than let it sit in the total unremarked. */}
                        {h.delisted && (
                          <span className="tag" title="Delisted — retained at cost, worth nothing until it relists.">
                            delisted
                          </span>
                        )}
                      </td>
                      <td className="mono">{h.isin}</td>
                      <td className="num">{h.quantity}</td>
                      <td className="num">{money(h.avg_cost)}</td>
                      <td className="num">{money(h.invested)}</td>
                    </tr>
                  ))}
                  {data.holdings.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No open holdings yet. Upload contract notes to build your portfolio.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Realized P&L per FY */}
          <section className="card">
            <h2>Realized P&L by financial year</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Financial year</th>
                    <th className="num">Short-term</th>
                    <th className="num">Long-term</th>
                    <th className="num">Total gain</th>
                    <th className="num">Proceeds</th>
                    <th className="num">Cost</th>
                    <th className="num">Lots closed</th>
                  </tr>
                </thead>
                <tbody>
                  {pnlRows.map((p: any, i: number) => (
                    <tr key={i}>
                      <td>
                        <b>{p.financial_year}</b>
                      </td>
                      <td className={`num ${gainClass(p.short_term_gain)}`}>
                        {money(p.short_term_gain)}
                      </td>
                      <td className={`num ${gainClass(p.long_term_gain)}`}>
                        {money(p.long_term_gain)}
                      </td>
                      <td className={`num ${gainClass(p.total_gain)}`}>
                        <b>{money(p.total_gain)}</b>
                      </td>
                      <td className="num">{money(p.proceeds)}</td>
                      <td className="num">{money(p.cost)}</td>
                      <td className="num">{p.trades_closed}</td>
                    </tr>
                  ))}
                  {pnlRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        {year
                          ? `Nothing realized in ${year}.`
                          : "No realized gains yet (no sells matched to buys)."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Dividends */}
          <section className="card">
            <h2>Dividends by financial year</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Financial year</th>
                    <th className="num">Gross</th>
                    <th className="num">TDS</th>
                    <th className="num">Net</th>
                    <th className="num">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {divRows.map((d: any, i: number) => (
                    <tr key={i}>
                      <td>
                        <b>{d.financial_year}</b>
                      </td>
                      <td className="num">{money(d.total_gross)}</td>
                      <td className="num">{money(d.total_tds)}</td>
                      <td className="num pos">{money(d.total_net)}</td>
                      <td className="num">{d.count}</td>
                    </tr>
                  ))}
                  {divRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        {year
                          ? `No dividends in ${year}.`
                          : "No dividends recorded yet. Add them below."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <FindDividends account={account} onSaved={load} />
            <DividendForm
              onSaved={load}
              accounts={data.accounts ?? []}
              accountsSupported={Boolean(data.accountsSupported)}
              selected={account}
            />
          </section>

          {/* Corporate actions — recorded and edited on their own page, since a
              split is a fact about a security rather than about this portfolio.
              What is shown here is only what they did to these holdings. */}
          <section className="card">
            <h2>Corporate actions ({data.corporateActions.length})</h2>
            {data.corporateActions.length === 0 ? (
              <p className="footnote">
                None recorded. Every figure above therefore assumes no split, bonus,
                demerger or merger has touched these
                {" "}{data.holdings.length} holdings — which is an assumption, not a
                finding. <a href="/corporate-actions">Record them →</a>
              </p>
            ) : (
              <>
                {/* Deliberately narrower than the Corporate Actions page: this
                    is here to say the figures above account for these, not to
                    be the place they are read. Detail and editing live there. */}
                <div className="table-wrap">
                  <table className="recon-table">
                    <thead>
                      <tr>
                        <th>Security</th>
                        <th>Type</th>
                        <th>Ex-date</th>
                        <th className="num">Quantity</th>
                        <th>Effect</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.actionEffects ?? []).map((e: any, i: number) => (
                        <tr key={i}>
                          <td>
                            <div className="clamp">{e.security_name || e.isin}</div>
                          </td>
                          <td>
                            <div className="clamp">{e.action_type}</div>
                          </td>
                          <td>{e.ex_date}</td>
                          <td className="num">
                            {e.quantity_before} → {e.quantity_after}
                          </td>
                          <td className="status-cell">
                            <span className={`badge ${e.applied ? "buy" : "sell"}`}>
                              {e.applied ? "applied" : "no effect"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="footnote">
                  {(data.actionEffects ?? []).some((e: any) => !e.applied) && (
                    <>
                      Some of these changed nothing — usually a mismatched ISIN or
                      ex-date.{" "}
                    </>
                  )}
                  <a href="/corporate-actions">Manage corporate actions →</a>
                </p>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls || ""}`}>{value}</span>
    </div>
  );
}

function DividendForm({
  onSaved,
  accounts,
  accountsSupported,
  selected,
}: {
  onSaved: () => void;
  accounts: { id: string; label: string }[];
  accountsSupported: boolean;
  selected: string;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default to whichever account the page is filtered to — that is almost always
  // the one being worked on.
  const accountId = f.account_id ?? selected;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (accountsSupported && !accountId) {
      setMsg("⚠️ Choose which account received this dividend.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/dividends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isin: f.isin,
          account_id: accountId || null,
          security_name: f.security_name,
          ex_date: f.ex_date,
          pay_date: f.pay_date,
          amount_per_share: f.amount_per_share ? Number(f.amount_per_share) : null,
          quantity: f.quantity ? Number(f.quantity) : null,
          tds: f.tds ? Number(f.tds) : 0,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed.");
      setMsg("Dividend added ✓");
      setF({});
      onSaved();
    } catch (err: any) {
      setMsg(`⚠️ ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  return (
    <form onSubmit={submit} className="entryform">
      <h3>Add a dividend</h3>
      <div className="formrow">
        {accountsSupported && (
          <select value={accountId} onChange={set("account_id")} required>
            <option value="">Account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <input placeholder="ISIN *" value={f.isin || ""} onChange={set("isin")} required />
        <input placeholder="Security name" value={f.security_name || ""} onChange={set("security_name")} />
        <input placeholder="Amount/share" type="number" step="any" value={f.amount_per_share || ""} onChange={set("amount_per_share")} />
        <input placeholder="Quantity" type="number" step="any" value={f.quantity || ""} onChange={set("quantity")} />
        <input placeholder="TDS" type="number" step="any" value={f.tds || ""} onChange={set("tds")} />
        <label className="datefield">Ex-date<input type="date" value={f.ex_date || ""} onChange={set("ex_date")} /></label>
        <label className="datefield">Pay-date<input type="date" value={f.pay_date || ""} onChange={set("pay_date")} /></label>
        <button className="btn" disabled={busy}>{busy ? "…" : "Add"}</button>
      </div>
      {msg && <span className="savestate">{msg}</span>}
    </form>
  );
}

/**
 * Table 5 of the spec, filled from the exchange feed.
 *
 * The corporate-action lookup already downloads these rows and throws them
 * away. What it cannot supply is the quantity held on the ex-date, which is why
 * this asks the server rather than the feed: that number comes from the FIFO
 * engine run as at the ex-date, so it is already adjusted for any bonus or split
 * that had happened by then.
 *
 * Same rule as everywhere else here — proposals, accepted one at a time. TDS is
 * not published by the exchange, so the amounts are gross; Form 26AS is the
 * authority for what was withheld.
 */
function FindDividends({ account, onSaved }: { account: string; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [heldOnly, setHeldOnly] = useState(true);

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const qs = account ? `?accounts=${encodeURIComponent(account)}` : "";
      const res = await fetch(`/api/dividends/discover${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Lookup failed.");
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function accept(c: any) {
    // A dividend belongs to a person, and the store refuses one without an
    // owner — so a specific account has to be chosen before this can be saved.
    if (!account) {
      setError("Choose a single account above first — a dividend has to belong to someone.");
      return;
    }
    setSaving(c.isin + c.ex_date);
    setError(null);
    try {
      const res = await fetch("/api/dividends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isin: c.isin,
          account_id: account,
          security_name: c.security_name,
          symbol: c.symbol,
          ex_date: c.ex_date,
          amount_per_share: c.amount_per_share,
          quantity: c.quantity,
          gross_amount: c.gross_amount,
          source: "nse",
          notes: `From NSE: "${c.subject}"`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save.");
      setData((d: any) => ({
        ...d,
        candidates: d.candidates.map((x: any) => (x === c ? { ...x, already_recorded: true } : x)),
      }));
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  const shown = data
    ? data.candidates.filter((c: any) => (heldOnly ? c.quantity > 0 : true))
    : [];

  return (
    <div className="entryform">
      <h3>Find dividends from the exchange</h3>
      <p className="hint">
        NSE publishes an amount per share and an ex-date; the quantity you held on
        that date comes from your own trades, adjusted for any bonus or split
        before it. This is the only part of the app that goes to the internet
        apart from reading a PDF.
      </p>

      {error && <p className="footnote neg">⚠️ {error}</p>}

      <div className="formrow">
        <button className="btn" type="button" onClick={search} disabled={busy}>
          {busy ? "Looking…" : "Look up dividends"}
        </button>
        {data && (
          <label className="datefield">
            Show
            <select
              value={heldOnly ? "held" : "all"}
              onChange={(e) => setHeldOnly(e.target.value === "held")}
            >
              <option value="held">Only where you held shares ({data.counts.held})</option>
              <option value="all">Everything found ({data.counts.total})</option>
            </select>
          </label>
        )}
      </div>

      {data && (
        <>
          <p className="footnote">
            {data.counts.held} dividend{data.counts.held === 1 ? "" : "s"} on securities
            you held, worth <strong>₹{money(data.counts.gross)}</strong> gross, across{" "}
            {data.isins} traded ISINs. {data.note}
          </p>
          <div className="table-wrap">
            <table className="recon-table">
              <thead>
                <tr>
                  <th>Security</th>
                  <th>Ex-date</th>
                  <th>What NSE published</th>
                  <th className="num">Per share</th>
                  <th className="num">Held</th>
                  <th className="num">Gross</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((c: any) => (
                  <tr key={c.isin + c.ex_date + c.subject}>
                    <td>
                      <div className="clamp">
                        {c.security_name || c.isin}
                        <div className="mono">{c.isin}</div>
                      </div>
                    </td>
                    <td>{c.ex_date}</td>
                    <td className="footnote recon-detail">
                      <div className="clamp">{c.subject}</div>
                    </td>
                    <td className="num">{money(c.amount_per_share)}</td>
                    <td className="num">{c.quantity}</td>
                    <td className="num">{money(c.gross_amount)}</td>
                    <td className="status-cell">
                      {c.already_recorded ? (
                        <span className="badge">recorded</span>
                      ) : c.quantity > 0 ? (
                        <button
                          className="btn"
                          type="button"
                          onClick={() => accept(c)}
                          disabled={saving === c.isin + c.ex_date}
                        >
                          {saving === c.isin + c.ex_date ? "…" : "Add"}
                        </button>
                      ) : (
                        <span className="muted footnote">not held</span>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Nothing found for your ISINs in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
