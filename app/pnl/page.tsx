"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Table 2 of the spec: the profit and loss statement.
 *
 * Laid out as the statement it is — realised profit and loss, losses set off,
 * the exemption applied, then tax — so each line can be checked against the row
 * above it rather than taken on faith. Every figure comes from stored data.
 *
 * The set-off toggle exists because the spec and the law disagree. See
 * app/lib/tax.ts.
 */

interface Year {
  financial_year: string;
  pnl: {
    short_term_profit: number;
    short_term_loss: number;
    long_term_profit: number;
    long_term_loss: number;
    short_term_gain: number;
    long_term_gain: number;
    total_gain: number;
    proceeds: number;
    cost: number;
    trades_closed: number;
  };
  tax: any;
  tax_other: any;
  rates: { ltcgExemption: number; ltcgRate: number; stcgRate: number; cessRate: number; label: string };
  brokerage: number;
  other_expenses: number;
  notes: number;
  dividends: number;
  dividends_gross: number;
  dividends_tds: number;
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const pct = (n: number) => `${(n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 1)}%`;

export default function PnlPage() {
  const [data, setData] = useState<
    {
      years: Year[];
      mode: string;
      caveats: string[];
      accounts?: any[];
      accountsSupported?: boolean;
      unrealised?: any;
      priced?: number;
      priced_as_of?: string | null;
    } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState("");
  const [mode, setMode] = useState<"law" | "spreadsheet">("law");
  const [year, setYear] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (account) qs.set("accounts", account);
      qs.set("mode", mode);
      const res = await fetch(`/api/pnl?${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not compute the statement.");
      setData(json);
      if (!year && json.years.length) setYear(json.years[json.years.length - 1].financial_year);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, mode]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.years ?? [];
  const current = rows.find((r) => r.financial_year === year) ?? rows[rows.length - 1];

  return (
    <main className="container">
      <header className="header">
        <h1>P&amp;L &amp; Tax</h1>
        <p className="subtitle">
          Realised capital gains by financial year, with losses set off, the
          long-term exemption applied and tax computed. Working only — it is one
          part of a return, not a return.
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {loading && <div className="card muted">Computing…</div>}

      {data && rows.length === 0 && (
        <div className="card muted">
          Nothing realised yet, and no charges recorded. Import some contract
          notes first.
        </div>
      )}

      {data && current && (
        <>
          <div className="card">
            <div className="formrow">
              {data.accountsSupported && (
                <label className="datefield">
                  Account
                  <select value={account} onChange={(e) => setAccount(e.target.value)}>
                    <option value="">All accounts</option>
                    {(data.accounts ?? []).map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="datefield">
                Financial year
                <select value={year} onChange={(e) => setYear(e.target.value)}>
                  {rows.map((r) => (
                    <option key={r.financial_year} value={r.financial_year}>
                      {r.financial_year}
                    </option>
                  ))}
                </select>
              </label>
              <label className="datefield">
                Loss set-off
                <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                  <option value="law">As the law allows</option>
                  <option value="spreadsheet">Within each bucket (the spreadsheet)</option>
                </select>
              </label>
            </div>
            <p className="footnote">
              {mode === "law" ? (
                <>
                  A short-term loss is set off against short-term gains and then
                  against long-term gains; a long-term loss only against long-term
                  gains. This is s.74 of the Income-tax Act.
                </>
              ) : (
                <>
                  Each bucket nets only within itself, which is what Table 2 of the
                  spreadsheet does (<span className="mono">=A-C-E</span> and{" "}
                  <span className="mono">=B-D</span>). In a year with short-term
                  losses and long-term gains this overstates the tax due.
                </>
              )}{" "}
              {current.tax.total_tax !== current.tax_other.total_tax && (
                <>
                  The other reading gives{" "}
                  <strong>₹{money(current.tax_other.total_tax)}</strong> — a
                  difference of ₹
                  {money(Math.abs(current.tax.total_tax - current.tax_other.total_tax))}.
                </>
              )}
            </p>
          </div>

          <section className="statgrid">
            <Stat label="Taxable LTCG" value={`₹${money(current.tax.taxable_ltcg)}`} sub={`at ${pct(current.rates.ltcgRate)}`} />
            <Stat label="Taxable STCG" value={`₹${money(current.tax.taxable_stcg)}`} sub={`at ${pct(current.rates.stcgRate)}`} />
            <Stat
              label={`Tax for ${current.financial_year}`}
              value={`₹${money(current.tax.total_tax)}`}
              cls={current.tax.total_tax > 0 ? "neg" : ""}
              sub={`including ${pct(current.rates.cessRate)} cess`}
            />
            <Stat
              label="Cost of trading"
              value={`₹${money(current.brokerage + current.other_expenses)}`}
              sub={`${current.notes} note${current.notes === 1 ? "" : "s"}`}
            />
          </section>

          <div className="dash-cols">
            <div>
              <section className="card">
                <h2>{current.financial_year} — the working</h2>
                <div className="table-wrap">
                  <table className="recon-table">
                    <tbody>
                      <Line label="Realised profit — long-term" value={current.pnl.long_term_profit} />
                      <Line label="Realised profit — short-term" value={current.pnl.short_term_profit} />
                      <Line label="Realised loss — long-term" value={-current.pnl.long_term_loss} />
                      <Line label="Realised loss — short-term" value={-current.pnl.short_term_loss} />

                      <Line
                        label="Long-term loss set against long-term gains"
                        value={-current.tax.ltcl_against_ltcg}
                        note
                      />
                      <Line
                        label="Short-term loss set against short-term gains"
                        value={-current.tax.stcl_against_stcg}
                        note
                      />
                      {mode === "law" && (
                        <Line
                          label="Short-term loss set against long-term gains"
                          value={-current.tax.stcl_against_ltcg}
                          note
                        />
                      )}
                      {current.tax.unabsorbed_loss > 0 && (
                        <Line
                          label="Loss with no gain to absorb it — carries forward"
                          value={-current.tax.unabsorbed_loss}
                          note
                        />
                      )}

                      <Line
                        label={`Long-term exemption used (of ₹${money(current.rates.ltcgExemption)})`}
                        value={-current.tax.ltcg_exemption_used}
                        note
                      />

                      <Line label="Taxable long-term gains" value={current.tax.taxable_ltcg} strong />
                      <Line label="Taxable short-term gains" value={current.tax.taxable_stcg} strong />

                      <Line label={`Long-term tax at ${pct(current.rates.ltcgRate)}`} value={current.tax.ltcg_tax} />
                      <Line label={`Cess at ${pct(current.rates.cessRate)}`} value={current.tax.ltcg_cess} note />
                      <Line label="Total long-term tax" value={current.tax.ltcg_total} strong />

                      <Line label={`Short-term tax at ${pct(current.rates.stcgRate)}`} value={current.tax.stcg_tax} />
                      <Line label={`Cess at ${pct(current.rates.cessRate)}`} value={current.tax.stcg_cess} note />
                      <Line label="Total short-term tax" value={current.tax.stcg_total} strong />

                      <Line label="Tax payable" value={current.tax.total_tax} strong />
                    </tbody>
                  </table>
                </div>
                <p className="footnote">{current.rates.label}.</p>
              </section>
            </div>

            <div>
              <section className="card">
                <h2>What the trading cost</h2>
                <div className="table-wrap">
                  <table className="recon-table">
                    <tbody>
                      <Line label="Brokerage" value={current.brokerage} />
                      <Line label="Other charges" value={current.other_expenses} />
                      <Line label="Total" value={current.brokerage + current.other_expenses} strong />
                    </tbody>
                  </table>
                </div>
                <p className="footnote">
                  Reported, not deducted here. Brokerage is already inside the cost
                  basis — net rates include it — so deducting it again would count
                  it twice. STT is not a deductible cost of acquisition at all.
                </p>
              </section>

              <section className="card">
                <h2>Dividends</h2>
                <div className="table-wrap">
                  <table className="recon-table">
                    <tbody>
                      <Line label="Gross" value={current.dividends_gross} />
                      <Line label="TDS" value={-current.dividends_tds} note />
                      <Line label="Net received" value={current.dividends} strong />
                    </tbody>
                  </table>
                </div>
                <p className="footnote">
                  Taxed at your slab rate rather than a capital-gains rate, so they
                  are not included in the tax above.
                </p>
              </section>

              <section className="card">
                <h2>Every year</h2>
                <div className="table-wrap">
                  <table className="recon-table">
                    <thead>
                      <tr>
                        <th>Year</th>
                        <th className="num">Net gain</th>
                        <th className="num">Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.financial_year}>
                          <td>
                            <b>{r.financial_year}</b>
                          </td>
                          <td className={`num ${r.pnl.total_gain > 0 ? "pos" : r.pnl.total_gain < 0 ? "neg" : ""}`}>
                            {money(r.pnl.total_gain)}
                          </td>
                          <td className="num">{money(r.tax.total_tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>

          {(data.priced ?? 0) > 0 && data.unrealised && (
            <section className="card">
              <h2>Unrealised, at today&apos;s prices</h2>
              <div className="table-wrap">
                <table className="recon-table">
                  <tbody>
                    <Line label="Unrealised profit — long-term (ULTCG)" value={data.unrealised.ultcg} />
                    <Line label="Unrealised profit — short-term (USTCG)" value={data.unrealised.ustcg} />
                    <Line label="Unrealised loss — long-term (ULTCL)" value={-data.unrealised.ultcl} />
                    <Line label="Unrealised loss — short-term (USTCL)" value={-data.unrealised.ustcl} />
                    <Line
                      label="Market value of what is held"
                      value={data.unrealised.market_value}
                      strong
                    />
                  </tbody>
                </table>
              </div>
              <p className="footnote">
                None of this is taxable — nothing has been sold. Split per lot
                rather than per holding, since the term depends on when each lot
                was acquired. Prices last taken{" "}
                {data.priced_as_of ? new Date(data.priced_as_of).toLocaleString("en-IN") : "never"};
                refresh them on <a href="/master">Master</a>.
                {data.unrealised.unpriced_cost > 0 && (
                  <>
                    {" "}
                    <strong>
                      ₹{money(data.unrealised.unpriced_cost)} of cost could not be
                      valued
                    </strong>{" "}
                    and is excluded above.
                  </>
                )}
              </p>
            </section>
          )}

          {(data.priced ?? 0) === 0 && (
            <section className="card muted">
              <h2>Unrealised</h2>
              <p className="footnote">
                Table 2 also asks for unrealised gains, which need today&apos;s
                prices. None are stored yet — fetch them on{" "}
                <a href="/master">Master</a> and they will appear here.
              </p>
            </section>
          )}

          <section className="card muted">
            <h2>What this does not cover</h2>
            <ul className="footnote recon-detail" style={{ margin: 0, paddingLeft: 18 }}>
              {data.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

/** One line of the working. Negative figures are shown as deductions. */
function Line({
  label,
  value,
  strong,
  note,
}: {
  label: string;
  value: number;
  strong?: boolean;
  note?: boolean;
}) {
  // Negating a zero gives -0, which formats as "−0.00" and reads like a figure
  // rather than an absence. `v === 0` is true for -0, so this flattens both.
  const v = value === 0 ? 0 : value;
  return (
    <tr>
      <td className={note ? "footnote" : undefined} style={note ? { paddingLeft: 22 } : undefined}>
        {strong ? <b>{label}</b> : label}
      </td>
      <td className={`num ${v < 0 ? "neg" : ""}`}>
        {strong ? <b>{money(v)}</b> : money(v)}
      </td>
    </tr>
  );
}

function Stat({ label, value, cls, sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="stat card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls || ""}`}>{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}
