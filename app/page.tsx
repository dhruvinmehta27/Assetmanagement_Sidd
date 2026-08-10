"use client";

import { useRef, useState } from "react";
import type { ContractNote } from "./lib/schema";

type Meta = { model: string; filename: string; usage: unknown };
type ApiResponse = { data: ContractNote; meta: Meta };

type ExtractStatus = "pending" | "extracting" | "extracted" | "failed";
type SaveStatus = "unsaved" | "saving" | "saved" | "duplicate" | "error";

interface Item {
  id: number;
  name: string;
  status: ExtractStatus;
  data?: ContractNote;
  meta?: Meta;
  error?: string;
  saveStatus: SaveStatus;
  saveMessage?: string;
  trades?: number;
}

/** Extractions in flight at once. Low, to stay clear of API rate limits. */
const CONCURRENCY = 2;

function money(n: number | null | undefined): string {
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
  const [items, setItems] = useState<Item[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Files chosen but not yet uploaded. A ref, because File objects are opaque
  // handles — putting them in state buys nothing and only forces re-renders.
  const pending = useRef<File[]>([]);

  const update = (id: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  function onPick(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    setError(null);
    setSelectedId(null);
    setItems(
      files.map((f, i) => ({
        id: i,
        name: f.name,
        status: "pending",
        saveStatus: "unsaved",
      }))
    );
    pending.current = files;
  }

  async function extractAll(e: React.FormEvent) {
    e.preventDefault();
    const files = pending.current;
    if (files.length === 0) return;

    setExtracting(true);
    setError(null);

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= files.length) return;

        const file = files[index];
        update(index, { status: "extracting" });
        try {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch("/api/extract", { method: "POST", body: fd });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || "Extraction failed.");
          update(index, {
            status: "extracted",
            data: (json as ApiResponse).data,
            meta: (json as ApiResponse).meta,
          });
        } catch (err: any) {
          update(index, { status: "failed", error: err.message });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker)
    );

    setExtracting(false);
    // A single note is the old one-file flow: open it straight away rather than
    // making the user click through a one-row list.
    if (files.length === 1) setSelectedId(0);
  }

  async function saveOne(item: Item): Promise<void> {
    if (!item.data || item.saveStatus === "saved" || item.saveStatus === "duplicate") return;
    update(item.id, { saveStatus: "saving", saveMessage: undefined });
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: item.data, filename: item.meta?.filename ?? item.name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed.");
      if (json.duplicate) {
        update(item.id, {
          saveStatus: "duplicate",
          saveMessage: "Already in your portfolio.",
        });
      } else {
        update(item.id, {
          saveStatus: "saved",
          trades: json.trades,
          saveMessage: `Saved — ${json.trades} trade(s) added.`,
        });
      }
    } catch (err: any) {
      update(item.id, { saveStatus: "error", saveMessage: err.message });
    }
  }

  async function saveAll() {
    setSavingAll(true);
    // Sequential on purpose: these writes hit the same de-dupe check, and a
    // handful of saves is fast enough that parallelism buys nothing.
    for (const item of items) {
      if (item.status === "extracted" && item.saveStatus === "unsaved") {
        await saveOne(item);
      }
    }
    setSavingAll(false);
  }

  const extracted = items.filter((i) => i.status === "extracted");
  const failed = items.filter((i) => i.status === "failed");
  const savable = extracted.filter((i) => i.saveStatus === "unsaved");
  const savedCount = items.filter((i) => i.saveStatus === "saved").length;
  const dupeCount = items.filter((i) => i.saveStatus === "duplicate").length;
  const multiple = items.length > 1;
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const done = items.filter((i) => i.status === "extracted" || i.status === "failed").length;

  return (
    <main className="container">
      <header className="header">
        <nav className="nav">
          <span className="nav-active">Upload</span>
          <a href="/import">Folder Import</a>
          <a href="/portfolio">Portfolio &amp; P&amp;L →</a>
        </nav>
        <h1>Contract Note Extractor</h1>
        <p className="subtitle">
          Upload one or more broker contract note PDFs — the app extracts every
          field it can into structured data, then saves them to your portfolio.
        </p>
        <p className="footnote">
          Got a whole backlog on disk? <a href="/import">Folder Import</a> processes
          an entire folder in one go — available in the desktop app, which can read
          PDFs directly from your drive.
        </p>
      </header>

      <form onSubmit={extractAll} className="card uploader">
        <label className="filedrop">
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={(e) => onPick(e.target.files)}
          />
          <span className="filedrop-label">
            {items.length === 0
              ? "Choose contract note PDFs…"
              : items.length === 1
              ? `📄 ${items[0].name}`
              : `📄 ${items.length} PDFs selected`}
          </span>
        </label>
        <button type="submit" disabled={items.length === 0 || extracting} className="btn">
          {extracting
            ? `Extracting… ${done}/${items.length}`
            : items.length > 1
            ? `Extract ${items.length} PDFs`
            : "Extract data"}
        </button>
        {items.length > 1 && !extracting && done === 0 && (
          <p className="footnote">
            You can select several files at once (⌘-click or shift-click). Each PDF
            is one extraction billed to your API key — {items.length} in total.
          </p>
        )}
      </form>

      {error && <div className="card error">⚠️ {error}</div>}

      {extracting && (
        <div className="card muted">
          Reading {items.length === 1 ? "the PDF" : `${items.length} PDFs`} and
          structuring {items.length === 1 ? "it" : "them"}… {done}/{items.length} done.
        </div>
      )}

      {/* Batch view: the per-file list, shown whenever more than one was picked. */}
      {multiple && done > 0 && (
        <div className="card">
          <div className="savebar">
            <button onClick={saveAll} disabled={savingAll || savable.length === 0} className="btn">
              {savingAll
                ? "Saving…"
                : savable.length > 0
                ? `Save ${savable.length} to portfolio`
                : extracted.length === 0
                ? // Nothing extracted at all — "All saved" would be a lie.
                  "Nothing to save"
                : "All saved"}
            </button>
            <span className="savestate">
              {savedCount} saved · {dupeCount} already in portfolio · {failed.length} failed
            </span>
            <a href="/portfolio" className="link-right">
              View portfolio &amp; P&amp;L →
            </a>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Broker</th>
                  <th>Trade date</th>
                  <th className="num">Trades</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr
                    key={it.id}
                    onClick={() => it.status === "extracted" && setSelectedId(it.id)}
                    style={{ cursor: it.status === "extracted" ? "pointer" : "default" }}
                  >
                    <td className="mono">{it.name}</td>
                    <td>{field(it.data?.broker_name)}</td>
                    <td>{field(it.data?.trade_date)}</td>
                    <td className="num">{it.data?.trades?.length ?? "—"}</td>
                    <td>
                      {it.status === "pending" && <span className="muted">queued</span>}
                      {it.status === "extracting" && <span className="muted">extracting…</span>}
                      {it.status === "failed" && (
                        <>
                          <span className="tag neg">failed</span>
                          {/* Error messages are full sentences; without a bound
                              they stretch the table and force the card to
                              scroll sideways. */}
                          <div className="footnote wrap-cell">{it.error}</div>
                        </>
                      )}
                      {it.status === "extracted" && (
                        <>
                          {it.saveStatus === "unsaved" && <span className="tag">ready</span>}
                          {it.saveStatus === "saving" && <span className="muted">saving…</span>}
                          {it.saveStatus === "saved" && <span className="tag pos">saved</span>}
                          {it.saveStatus === "duplicate" && (
                            <span className="tag">already in portfolio</span>
                          )}
                          {it.saveStatus === "error" && (
                            <>
                              <span className="tag neg">save failed</span>
                              <div className="footnote wrap-cell">{it.saveMessage}</div>
                            </>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">Click any extracted row to see its full detail below.</p>
        </div>
      )}

      {/* Detail view: the original single-note layout, unchanged. */}
      {selected?.data && (
        <div className="results">
          {!multiple && (
            <div className="savebar card">
              <button
                onClick={() => saveOne(selected)}
                disabled={selected.saveStatus === "saving"}
                className="btn"
              >
                {selected.saveStatus === "saving" ? "Saving…" : "Save to portfolio"}
              </button>
              {selected.saveMessage && (
                <span className="savestate">{selected.saveMessage}</span>
              )}
              <a href="/portfolio" className="link-right">
                View portfolio &amp; P&amp;L →
              </a>
            </div>
          )}

          <NoteDetail data={selected.data} meta={selected.meta} />
        </div>
      )}
    </main>
  );
}

function NoteDetail({ data: d, meta }: { data: ContractNote; meta?: Meta }) {
  return (
    <>
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
                    {t.segment ? <span className="tag">{t.segment}</span> : null}
                  </td>
                  <td className="mono">{field(t.isin)}</td>
                  <td>
                    <span
                      className={`badge ${
                        t.buy_sell === "BUY" ? "buy" : t.buy_sell === "SELL" ? "sell" : ""
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

      {meta && (
        <p className="footnote">
          Extracted from <b>{meta.filename}</b> using <b>{meta.model}</b>.
        </p>
      )}
    </>
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
