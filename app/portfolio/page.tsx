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
  holdings: any[];
  pnl: any[];
  realized: any[];
  dividends: any[];
  dividendsByFY: any[];
  corporateActions: any[];
};

export default function PortfolioPage() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/portfolio", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load portfolio.");
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="container">
      <header className="header">
        <nav className="nav">
          <a href="/">← Upload</a>
          <a href="/import">Folder Import</a>
          <span className="nav-active">Portfolio &amp; P&amp;L</span>
        </nav>
        <h1>Portfolio &amp; P&amp;L</h1>
        <p className="subtitle">
          Holdings, realized profit/loss by Indian financial year, and dividends
          — computed from all your saved contract notes (FIFO, corporate-action
          adjusted).
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {loading && <div className="card muted">Loading portfolio…</div>}

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
                      <td>{h.security_name || "—"}</td>
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
                  {data.pnl.map((p, i) => (
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
                  {data.pnl.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No realized gains yet (no sells matched to buys).
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
                  {data.dividendsByFY.map((d, i) => (
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
                  {data.dividendsByFY.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No dividends recorded yet. Add them below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <DividendForm onSaved={load} />
          </section>

          {/* Corporate actions */}
          <section className="card">
            <h2>Corporate actions ({data.corporateActions.length})</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Security</th>
                    <th>ISIN</th>
                    <th>Type</th>
                    <th>Ex-date</th>
                    <th>Ratio</th>
                    <th className="num">Qty ×</th>
                  </tr>
                </thead>
                <tbody>
                  {data.corporateActions.map((a, i) => (
                    <tr key={i}>
                      <td>{a.security_name || "—"}</td>
                      <td className="mono">{a.isin}</td>
                      <td>{a.action_type}</td>
                      <td>{a.ex_date}</td>
                      <td>{a.ratio_text || "—"}</td>
                      <td className="num">{a.quantity_multiplier}</td>
                    </tr>
                  ))}
                  {data.corporateActions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No corporate actions recorded. Add splits / bonuses below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <CorporateActionForm onSaved={load} />
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

function DividendForm({ onSaved }: { onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/dividends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isin: f.isin,
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

function CorporateActionForm({ onSaved }: { onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ action_type: "SPLIT" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/corporate-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isin: f.isin,
          security_name: f.security_name,
          action_type: f.action_type,
          ex_date: f.ex_date,
          quantity_multiplier: f.quantity_multiplier ? Number(f.quantity_multiplier) : null,
          ratio_text: f.ratio_text,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed.");
      setMsg("Corporate action added ✓");
      setF({ action_type: "SPLIT" });
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
      <h3>Add a corporate action</h3>
      <p className="hint">
        Quantity multiplier = new shares ÷ old shares. E.g. 2-for-1 split or 1:1
        bonus → <b>2</b>; 3:2 bonus → <b>2.5</b>. Cost basis is preserved automatically.
      </p>
      <div className="formrow">
        <input placeholder="ISIN *" value={f.isin || ""} onChange={set("isin")} required />
        <input placeholder="Security name" value={f.security_name || ""} onChange={set("security_name")} />
        <select value={f.action_type} onChange={set("action_type")}>
          <option value="SPLIT">Split</option>
          <option value="BONUS">Bonus</option>
          <option value="MERGER">Merger</option>
          <option value="OTHER">Other</option>
        </select>
        <input placeholder="Ratio (e.g. 1:1)" value={f.ratio_text || ""} onChange={set("ratio_text")} />
        <input placeholder="Qty multiplier *" type="number" step="any" value={f.quantity_multiplier || ""} onChange={set("quantity_multiplier")} required />
        <label className="datefield">Ex-date<input type="date" value={f.ex_date || ""} onChange={set("ex_date")} required /></label>
        <button className="btn" disabled={busy}>{busy ? "…" : "Add"}</button>
      </div>
      {msg && <span className="savestate">{msg}</span>}
    </form>
  );
}
