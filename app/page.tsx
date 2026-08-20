"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The dashboard.
 *
 * Two questions, in order: what is this portfolio worth, and is there anything
 * wrong with it. The second one leads, because every figure on this page is
 * computed from contract notes and is only as good as they are — an unassigned
 * note or a note that does not reconcile means the numbers below are quietly
 * understating something, and that is worth knowing before reading them.
 *
 * Everything here is derived from two endpoints the app already had. Nothing is
 * computed in the browser except proportions.
 */

interface Summary {
  notes: number;
  trades: number;
  holdings: number;
  total_invested: number;
  total_realized: number;
  total_dividends: number;
  shares_received?: { bonus: number; split: number; demerger: number; rights: number; closed: number };
}

interface Holding {
  isin: string;
  security_name: string | null;
  quantity: number;
  invested: number;
  delisted?: boolean;
}

interface Portfolio {
  summary: Summary;
  holdings: Holding[];
  pnl: any[];
  accounts?: { id: string; label: string }[];
  accountsSupported?: boolean;
  unassigned?: { notes: number; trades: number };
  corporateActions: any[];
  actionEffects?: { applied: boolean }[];
  storage?: { driver: string; location: string; local: boolean };
}

interface Recon {
  summary: { notes: number; ties: number; off: number; unknown: number; needs_attention: number; total_discrepancy: number };
}

/** Exact, grouped Indian-style. Tables and totals use this. */
function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Magnitude at a glance: ₹25.94 L rather than ₹25,94,380.32.
 *
 * A dashboard answers "roughly how much"; the exact figure belongs on the page
 * that can be reconciled against a document. The full number is still there in
 * the tooltip, so nothing is actually hidden.
 */
function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}k`;
  return `${sign}₹${abs.toFixed(2)}`;
}

export default function Dashboard() {
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [rec, setRec] = useState<Recon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r] = await Promise.all([
        fetch("/api/portfolio", { cache: "no-store" }),
        fetch("/api/reconcile", { cache: "no-store" }),
      ]);
      const pj = await p.json();
      if (!p.ok) throw new Error(pj.error || "Could not load the portfolio.");
      setPf(pj);
      // Reconciliation is a nice-to-have here: if it fails the dashboard should
      // still show the portfolio rather than a blank page with an error.
      if (r.ok) setRec(await r.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const s = pf?.summary;
  const holdings = [...(pf?.holdings ?? [])].sort((a, b) => b.invested - a.invested);
  const largest = holdings[0]?.invested || 1;
  const totalInvested = s?.total_invested || 0;
  const noEffect = (pf?.actionEffects ?? []).filter((e) => !e.applied).length;
  const empty = Boolean(pf) && (s?.notes ?? 0) === 0;

  // Everything that wants a human, worst first. An empty list is the good case
  // and gets said out loud rather than left as an absence.
  const todos: { tone: string; href: string; title: string; detail: string }[] = [];
  if (pf?.accountsSupported && (pf.accounts ?? []).length === 0 && (s?.notes ?? 0) > 0) {
    todos.push({
      tone: "bad",
      href: "/accounts",
      title: "No accounts yet, so nothing is counted",
      detail: "Every imported note is waiting to be claimed. Add an account with its PAN and they assign themselves.",
    });
  }
  if ((pf?.unassigned?.notes ?? 0) > 0) {
    todos.push({
      tone: "bad",
      href: "/accounts",
      title: `${pf!.unassigned!.notes} note${pf!.unassigned!.notes === 1 ? "" : "s"} belong to nobody`,
      detail: `${pf!.unassigned!.trades} trades sit outside every figure on this page until they are assigned.`,
    });
  }
  if (rec && rec.summary.off > 0) {
    todos.push({
      tone: "bad",
      href: "/reconcile",
      title: `${rec.summary.off} note${rec.summary.off === 1 ? "" : "s"} do not add up`,
      detail: `₹${money(rec.summary.total_discrepancy)} between what they state and what their own lines come to.`,
    });
  }
  if (rec && rec.summary.unknown > 0) {
    todos.push({
      tone: "warn",
      href: "/reconcile",
      title: `${rec.summary.unknown} note${rec.summary.unknown === 1 ? "" : "s"} cannot be checked`,
      detail: "No printed net amount, so there is nothing to check the trade lines against.",
    });
  }
  if (noEffect > 0) {
    todos.push({
      tone: "warn",
      href: "/corporate-actions",
      title: `${noEffect} corporate action${noEffect === 1 ? "" : "s"} changed nothing`,
      detail: "Usually a mismatched ISIN or ex-date. An action that does nothing still looks recorded.",
    });
  }
  if ((s?.notes ?? 0) > 0 && (pf?.corporateActions ?? []).length === 0) {
    todos.push({
      tone: "warn",
      href: "/corporate-actions",
      title: "No corporate actions recorded",
      detail: "Holdings assume no split, bonus or demerger has happened. The exchange lookup can tell you in a few seconds.",
    });
  }

  return (
    <main className="container">
      <header className="header">
        <h1>Dashboard</h1>
        <p className="subtitle">
          Everything below is computed from your contract notes — FIFO, adjusted
          for corporate actions.
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {loading && <div className="card muted">Loading…</div>}

      {empty && (
        <section className="card">
          <h2>Nothing here yet</h2>
          <p className="footnote">
            Upload a broker contract note and it will be read, filed and counted.
            If you have a folder of them, the desktop importer will work through
            the lot in one go.
          </p>
          <div className="actions" style={{ marginTop: 14 }}>
            <a className="action" href="/upload">
              <b>Upload a note →</b>
              <span>One or more PDFs</span>
            </a>
            <a className="action" href="/import">
              <b>Import a folder →</b>
              <span>The whole backlog at once</span>
            </a>
          </div>
        </section>
      )}

      {pf && !empty && s && (
        <>
          <section className="card">
            <h2>Invested, at cost</h2>
            <div className="hero">
              <span className="hero-value" title={`₹${money(totalInvested)}`}>
                {compact(totalInvested)}
              </span>
              <span className="hero-note">
                across {s.holdings} holding{s.holdings === 1 ? "" : "s"} · {s.notes} contract
                note{s.notes === 1 ? "" : "s"} · {s.trades} trades
              </span>
            </div>
            <p className="footnote">
              Cost of what is still held. It is not a market value — nothing in
              this app knows today&apos;s prices.
            </p>
          </section>

          <section className="statgrid">
            <Stat
              label="Realized P&L"
              value={`₹${money(s.total_realized)}`}
              cls={s.total_realized > 0 ? "pos" : s.total_realized < 0 ? "neg" : ""}
              sub="booked on closed lots"
            />
            <Stat
              label="Dividends"
              value={`₹${money(s.total_dividends)}`}
              sub={s.total_dividends === 0 ? "none recorded" : "received"}
            />
            <Stat
              label="Notes reconciled"
              value={rec ? `${rec.summary.ties}/${rec.summary.notes}` : "—"}
              cls={rec && rec.summary.off === 0 && rec.summary.notes > 0 ? "pos" : ""}
              sub={rec && rec.summary.off > 0 ? `${rec.summary.off} do not tie` : "against their own totals"}
            />
            <Stat
              label="Shares from actions"
              value={String(
                Math.round(
                  (s.shares_received?.bonus ?? 0) +
                    (s.shares_received?.split ?? 0) +
                    (s.shares_received?.demerger ?? 0) +
                    (s.shares_received?.rights ?? 0)
                )
              )}
              sub="bonus, split, demerger, rights"
            />
          </section>

          <div className="dash-cols">
            <div>
              <section className="card">
                <h2>Where the money is</h2>
                {holdings.length === 0 ? (
                  <p className="footnote">No open holdings.</p>
                ) : (
                  <>
                    {holdings.slice(0, 8).map((h) => (
                      <div className="alloc" key={h.isin}>
                        <div className="alloc-name" title={h.security_name || h.isin}>
                          {h.security_name || h.isin}
                          {h.delisted && <span className="tag">delisted</span>}
                        </div>
                        <div className="alloc-value" title={`₹${money(h.invested)}`}>
                          {compact(h.invested)}
                          <span className="muted">
                            {" "}
                            · {totalInvested ? ((h.invested / totalInvested) * 100).toFixed(1) : "0"}%
                          </span>
                        </div>
                        {/* Scaled against the largest holding, not the total —
                            with 24 holdings every bar against the total would be
                            a sliver and the shape would be unreadable. */}
                        <div className="bar">
                          <div
                            className="bar-fill"
                            style={{ width: `${Math.max((h.invested / largest) * 100, 1.5)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                    {holdings.length > 8 && (
                      <p className="footnote" style={{ marginTop: 12 }}>
                        <a href="/portfolio">
                          and {holdings.length - 8} more on Portfolio &amp; P&amp;L →
                        </a>
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className="card">
                <h2>Realized by financial year</h2>
                {(pf.pnl ?? []).length === 0 ? (
                  <p className="footnote">
                    Nothing closed yet — realized gains appear once a holding is sold.
                  </p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Year</th>
                          <th className="num">Short-term</th>
                          <th className="num">Long-term</th>
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pf.pnl.map((p: any) => (
                          <tr key={p.financial_year}>
                            <td>
                              <b>{p.financial_year}</b>
                            </td>
                            <td className={`num ${p.short_term_gain > 0 ? "pos" : p.short_term_gain < 0 ? "neg" : ""}`}>
                              {money(p.short_term_gain)}
                            </td>
                            <td className={`num ${p.long_term_gain > 0 ? "pos" : p.long_term_gain < 0 ? "neg" : ""}`}>
                              {money(p.long_term_gain)}
                            </td>
                            <td className={`num ${p.total_gain > 0 ? "pos" : p.total_gain < 0 ? "neg" : ""}`}>
                              <b>{money(p.total_gain)}</b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <div>
              <section className="card">
                <h2>Needs a look</h2>
                {todos.length === 0 ? (
                  <a className="todo good" href="/reconcile">
                    <span className="todo-dot" />
                    <span className="todo-text">
                      <b>Nothing outstanding.</b>
                      <span>
                        Every note is assigned and ties against its own printed total.
                      </span>
                    </span>
                  </a>
                ) : (
                  todos.map((t) => (
                    <a className={`todo ${t.tone}`} href={t.href} key={t.title}>
                      <span className="todo-dot" />
                      <span className="todo-text">
                        <b>{t.title}</b>
                        <span>{t.detail}</span>
                      </span>
                    </a>
                  ))
                )}
              </section>

              <section className="card">
                <h2>Do next</h2>
                <div className="actions">
                  <a className="action" href="/upload">
                    <b>Upload →</b>
                    <span>Read a contract note</span>
                  </a>
                  <a className="action" href="/import">
                    <b>Import a folder →</b>
                    <span>A backlog at once</span>
                  </a>
                  <a className="action" href="/corporate-actions">
                    <b>Corporate actions →</b>
                    <span>Look them up online</span>
                  </a>
                  <a className="action" href="/portfolio">
                    <b>Portfolio &amp; P&amp;L →</b>
                    <span>Holdings and gains</span>
                  </a>
                </div>
              </section>

              {pf.storage && (
                <p className="footnote">
                  {pf.storage.local ? (
                    <>
                      Stored on this Mac only. Nothing on this page has left the
                      machine.
                    </>
                  ) : (
                    <>
                      Stored in Supabase (
                      <span className="mono">{pf.storage.location}</span>).
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  exact,
  cls,
  sub,
}: {
  label: string;
  value: string;
  exact?: string;
  cls?: string;
  sub?: string;
}) {
  return (
    <div className="stat card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls || ""}`} title={exact}>
        {value}
      </span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}
