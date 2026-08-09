"use client";

import { useState } from "react";
import type { ContractNote } from "./lib/schema";

type ApiResponse = {
  data: ContractNote;
  meta: { model: string; filename: string; usage: unknown };
};

function money(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function field(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!result) return;
    setSaving(true);
    setSaveState(null);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: result.data, filename: result.meta.filename }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed.");
      if (json.duplicate) setSaveState("Already in your portfolio (skipped duplicate).");
      else setSaveState(`Saved ✓ ${json.trades} trade(s) added to your portfolio.`);
    } catch (err: any) {
      setSaveState(`⚠️ ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Extraction failed.");
      setResult(json as ApiResponse);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const d = result?.data;

  return (
    <main className="container">
      <header className="header">
        <nav className="nav">
          <span className="nav-active">Upload</span>
          <a href="/portfolio">Portfolio &amp; P&amp;L →</a>
        </nav>
        <h1>Contract Note Extractor</h1>
        <p className="subtitle">
          Upload a broker contract note PDF — the app extracts every field it
          can into structured data, then saves it to your portfolio.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="card uploader">
        <label className="filedrop">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
          />
          <span className="filedrop-label">
            {file ? `📄 ${file.name}` : "Choose a contract note PDF…"}
          </span>
        </label>
        <button type="submit" disabled={!file || loading} className="btn">
          {loading ? "Extracting…" : "Extract data"}
        </button>
      </form>

      {error && <div className="card error">⚠️ {error}</div>}

      {loading && (
        <div className="card muted">Reading the PDF and structuring it…</div>
      )}

      {d && (
        <div className="results">
          <div className="savebar card">
            <button onClick={handleSave} disabled={saving} className="btn">
              {saving ? "Saving…" : "Save to portfolio"}
            </button>
            {saveState && <span className="savestate">{saveState}</span>}
            <a href="/portfolio" className="link-right">
              View portfolio &amp; P&amp;L →
            </a>
          </div>

          <section className="card">
            <h2>Summary</h2>
            <div className="grid">
              <Info label="Broker" value={field(d.broker_name)} />
              <Info label="Contract note #" value={field(d.contract_note_number)} />
              <Info label="Trade date" value={field(d.trade_date)} />
              <Info label="Settlement date" value={field(d.settlement_date)} />
              <Info label="Client" value={field(d.client_name)} />
              <Info label="Client code" value={field(d.client_code)} />
              <Info label="PAN" value={field(d.pan)} />
              <Info label="Exchange" value={field(d.exchange)} />
              <Info label="Currency" value={field(d.currency)} />
              <Info
                label="Net amount"
                value={`${money(d.net_amount)}${
                  d.net_amount_direction ? ` (${d.net_amount_direction})` : ""
                }`}
              />
            </div>
          </section>

          <section className="card">
            <h2>Trades ({d.trades?.length ?? 0})</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Security</th>
                    <th>ISIN</th>
                    <th>B/S</th>
                    <th className="num">Qty</th>
                    <th className="num">Gross rate</th>
                    <th className="num">Net rate</th>
                    <th className="num">Net value</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.trades ?? []).map((t, i) => (
                    <tr key={i}>
                      <td>
                        {field(t.security_name || t.symbol)}
                        {t.segment ? (
                          <span className="tag">{t.segment}</span>
                        ) : null}
                      </td>
                      <td className="mono">{field(t.isin)}</td>
                      <td>
                        <span
                          className={`badge ${
                            t.buy_sell === "BUY"
                              ? "buy"
                              : t.buy_sell === "SELL"
                              ? "sell"
                              : ""
                          }`}
                        >
                          {field(t.buy_sell)}
                        </span>
                      </td>
                      <td className="num">{field(t.quantity)}</td>
                      <td className="num">{money(t.gross_rate)}</td>
                      <td className="num">{money(t.net_rate)}</td>
                      <td className="num">{money(t.net_value)}</td>
                    </tr>
                  ))}
                  {(!d.trades || d.trades.length === 0) && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No individual trades parsed.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>Charges</h2>
            <div className="grid">
              <Info label="Brokerage" value={money(d.charges?.brokerage)} />
              <Info
                label="Exchange txn charges"
                value={money(d.charges?.exchange_transaction_charges)}
              />
              <Info label="Clearing charges" value={money(d.charges?.clearing_charges)} />
              <Info label="SEBI turnover fees" value={money(d.charges?.sebi_turnover_fees)} />
              <Info label="STT" value={money(d.charges?.stt)} />
              <Info label="Stamp duty" value={money(d.charges?.stamp_duty)} />
              <Info label="IPFT" value={money(d.charges?.ipft)} />
              <Info label="GST" value={money(d.charges?.gst)} />
              <Info label="CGST" value={money(d.charges?.cgst)} />
              <Info label="SGST" value={money(d.charges?.sgst)} />
              <Info label="IGST" value={money(d.charges?.igst)} />
              <Info label="Demat / DP" value={money(d.charges?.demat_charges)} />
              <Info label="Rounding" value={money(d.charges?.rounding)} />
              <Info label="Other" value={money(d.charges?.other_charges)} />
              <Info label="Total charges" value={money(d.charges?.total_charges)} />
            </div>
          </section>

          {d.notes && (
            <section className="card">
              <h2>Parser notes</h2>
              <p className="muted">{d.notes}</p>
            </section>
          )}

          <details className="card">
            <summary>Raw JSON</summary>
            <pre>{JSON.stringify(d, null, 2)}</pre>
          </details>

          {result?.meta && (
            <p className="footnote">
              Extracted from <b>{result.meta.filename}</b> using{" "}
              <b>{result.meta.model}</b>.
            </p>
          )}
        </div>
      )}
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}
