"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Table 6 of the spec: one row per account, everything in and everything out.
 *
 * Also where prices are refreshed, because this is the page whose figures depend
 * on them most. The refresh is a button and never automatic — a price request
 * names a security, and this is the third and last thing in the app that reaches
 * the internet.
 */

interface Row {
  account_id: string;
  label: string;
  entity_type: string;
  notes: number;
  holdings: number;
  capital_employed: number;
  dividends: number;
  bonus_shares: number;
  split_shares: number;
  demerger_shares: number;
  rights_shares: number;
  realised_ltcg: number;
  realised_stcg: number;
  valuation: number;
  net_capital_employed: number;
  unpriced_cost: number;
  unpriced: { isin: string; security_name: string | null; invested: number; delisted: boolean }[];
  unrealised: { ultcg: number; ustcg: number; ultcl: number; ustcl: number; market_value: number; priced_cost: number };
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = n === 0 ? 0 : n;
  return v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "unknown";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

export default function MasterPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/master", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not build the summary.");
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

  async function refreshPrices() {
    setPricing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/prices", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not fetch prices.");
      const failed = (json.failures ?? []).length;
      setMessage(
        `Priced ${json.fetched} securities${failed ? `; ${failed} could not be priced` : ""}.`
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPricing(false);
    }
  }

  const rows: Row[] = data?.rows ?? [];
  const total = rows.reduce(
    (a, r) => ({
      capital_employed: a.capital_employed + r.capital_employed,
      dividends: a.dividends + r.dividends,
      realised: a.realised + r.realised_ltcg + r.realised_stcg,
      valuation: a.valuation + r.valuation,
      net: a.net + r.net_capital_employed,
      unpriced: a.unpriced + r.unpriced_cost,
    }),
    { capital_employed: 0, dividends: 0, realised: 0, valuation: 0, net: 0, unpriced: 0 }
  );

  return (
    <main className="container">
      <header className="header">
        <h1>Master</h1>
        <p className="subtitle">
          One row per account: what went in, what has come out, and what it is
          worth now.
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {message && <div className="card muted">{message}</div>}
      {loading && <div className="card muted">Loading…</div>}

      {data && (
        <>
          <div className="card">
            <div className="formrow">
              <button className="btn" onClick={refreshPrices} disabled={pricing}>
                {pricing ? "Fetching prices…" : "Refresh prices"}
              </button>
              <span className="footnote">
                {data.prices > 0 ? (
                  <>
                    {data.prices} price{data.prices === 1 ? "" : "s"} stored, taken{" "}
                    <strong>{ago(data.priced_as_of)}</strong>.
                  </>
                ) : (
                  <>No prices stored yet, so nothing can be valued.</>
                )}
              </span>
            </div>
            <p className="footnote">
              Prices come from BSE and are stored, so this page renders offline
              from the last set taken. Fetching is the third and last thing in the
              app that reaches the internet, and it only happens when you press
              the button.
            </p>
          </div>

          {total.unpriced > 0 && (
            <div className="card error">
              <p>
                <strong>₹{money(total.unpriced)} of cost could not be valued.</strong>
              </p>
              <p className="footnote">
                Every figure involving a valuation below is short by whatever that
                is worth today.{" "}
                {rows
                  .flatMap((r) => r.unpriced)
                  .map((u) => `${u.security_name || u.isin}${u.delisted ? " (delisted)" : ""}`)
                  .join(", ")}
                .
              </p>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="card muted">
              No accounts yet. Add one on the <a href="/accounts">Accounts</a> page.
            </div>
          ) : (
            rows.map((r) => (
              <section className="card" key={r.account_id}>
                <h2>
                  {r.label} · {r.entity_type}
                </h2>
                <div className="dash-cols">
                  <div>
                    <div className="table-wrap">
                      <table className="recon-table">
                        <tbody>
                          <Row label="Capital employed" hint="cost of what is still held" value={r.capital_employed} />
                          <Row label="Total dividend received" value={r.dividends} />
                          <Row label="Realised profit (LTCG)" value={r.realised_ltcg} />
                          <Row label="Realised profit (STCG)" value={r.realised_stcg} />
                          <Row label="Current valuation" value={r.valuation} strong />
                          <Row
                            label="Net capital employed"
                            hint="valuation less everything in and everything out"
                            value={r.net_capital_employed}
                            strong
                          />
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <div className="table-wrap">
                      <table className="recon-table">
                        <tbody>
                          <Count label="Bonus shares received" value={r.bonus_shares} />
                          <Count label="Split shares received" value={r.split_shares} />
                          <Count label="Demerger shares received" value={r.demerger_shares} />
                          <Count label="Rights shares taken up" value={r.rights_shares} />
                          <Count label="Contract notes" value={r.notes} />
                          <Count label="Open holdings" value={r.holdings} />
                        </tbody>
                      </table>
                    </div>
                    <p className="footnote">{data.note}</p>
                  </div>
                </div>

                {r.valuation > 0 && (
                  <>
                    <h3 style={{ marginTop: 18 }}>Unrealised, at today&apos;s prices</h3>
                    <div className="table-wrap">
                      <table className="recon-table">
                        <thead>
                          <tr>
                            <th className="num">Long-term gain</th>
                            <th className="num">Short-term gain</th>
                            <th className="num">Long-term loss</th>
                            <th className="num">Short-term loss</th>
                            <th className="num">Market value</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="num pos">{money(r.unrealised.ultcg)}</td>
                            <td className="num pos">{money(r.unrealised.ustcg)}</td>
                            <td className="num neg">{money(r.unrealised.ultcl)}</td>
                            <td className="num neg">{money(r.unrealised.ustcl)}</td>
                            <td className="num">
                              <b>{money(r.unrealised.market_value)}</b>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="footnote">
                      Split per lot rather than per holding — 100 shares bought two
                      years ago and 100 bought last month are one holding and two
                      different tax treatments. Nothing here is taxable until sold.
                    </p>
                  </>
                )}
              </section>
            ))
          )}

          {rows.length > 1 && (
            <section className="card">
              <h2>All accounts</h2>
              <div className="table-wrap">
                <table className="recon-table">
                  <tbody>
                    <Row label="Capital employed" value={total.capital_employed} />
                    <Row label="Dividends" value={total.dividends} />
                    <Row label="Realised" value={total.realised} />
                    <Row label="Valuation" value={total.valuation} strong />
                    <Row label="Net capital employed" value={total.net} strong />
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Row({
  label,
  hint,
  value,
  strong,
}: {
  label: string;
  hint?: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <tr>
      <td>
        {strong ? <b>{label}</b> : label}
        {hint && <div className="footnote">{hint}</div>}
      </td>
      <td className={`num ${value < 0 ? "neg" : ""}`}>
        {strong ? <b>₹{money(value)}</b> : `₹${money(value)}`}
      </td>
    </tr>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{value.toLocaleString("en-IN")}</td>
    </tr>
  );
}
