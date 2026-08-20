"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Reconciliation — does each contract note's own arithmetic add up?
 *
 * Every note states its trades, its charges and the net amount that changed
 * hands, and those three have to agree. Checking that they do is the cheapest
 * test there is of whether extraction read the note correctly: it uses only what
 * is already stored, makes no API calls and costs nothing to run.
 *
 * What it cannot tell you is whether a note is *missing* — for that you need a
 * holding statement to diff against.
 */

interface Flag {
  code: string;
  severity: "warn" | "info";
  message: string;
}

interface Row {
  id: string;
  contract_note_number: string | null;
  trade_date: string | null;
  broker_name: string | null;
  client_name: string | null;
  account_id: string | null;
  trade_count: number;
  gross_traded: number;
  charges: number;
  charges_source: "printed" | "components" | "none";
  charges_from_components: number;
  rounding: number;
  computed_net: number;
  printed_net: number | null;
  delta: number | null;
  implied_charges: number | null;
  status: "ties" | "off" | "unknown";
  flags: Flag[];
}

interface Payload {
  summary: {
    notes: number;
    ties: number;
    off: number;
    unknown: number;
    total_discrepancy: number;
    needs_attention: number;
  };
  rows: Row[];
  tolerance: number;
  storage?: { driver: string; location: string; local: boolean };
  accountsSupported?: boolean;
  accounts?: { id: string; label: string; pan: string | null }[];
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ReconcilePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = account ? `?accounts=${encodeURIComponent(account)}` : "";
      const res = await fetch(`/api/reconcile${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not reconcile.");
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

  // Mirrors needsAttention() on the server. Most notes carry an "info" flag
  // explaining how a figure was derived; filtering on flags of any severity
  // would show almost every row and defeat the point of the filter.
  const rows = data
    ? onlyProblems
      ? data.rows.filter(
          (r) => r.status !== "ties" || r.flags.some((f) => f.severity === "warn")
        )
      : data.rows
    : [];

  const clean =
    data && data.summary.notes > 0 && data.summary.off === 0 && data.summary.unknown === 0;

  return (
    <main className="container">
      <header className="header">
        <h1>Reconcile</h1>
        <p className="subtitle">
          Each note is checked against itself: gross traded value less charges
          should equal the net amount printed on it. Nothing here calls out to
          Claude or to the network — it reads only what is already stored, so it
          costs nothing to run as often as you like.
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {loading && <div className="card muted">Reconciling…</div>}

      {data && (
        <>
          <div className="card">
            <div className="formrow">
              {data.accountsSupported && (
                <label className="datefield">
                  Account
                  <select value={account} onChange={(e) => setAccount(e.target.value)}>
                    <option value="">All notes, assigned or not</option>
                    {(data.accounts ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                        {a.pan ? ` · ${a.pan}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="datefield">
                Show
                <select
                  value={onlyProblems ? "problems" : "all"}
                  onChange={(e) => setOnlyProblems(e.target.value === "problems")}
                >
                  <option value="all">Every note ({data.summary.notes})</option>
                  <option value="problems">
                    Only notes that need a look ({data.summary.needs_attention})
                  </option>
                </select>
              </label>
              <button className="btn" onClick={load} disabled={loading}>
                {loading ? "…" : "Re-check"}
              </button>
            </div>
            <p className="footnote">
              Unassigned notes are included here, unlike the portfolio: a note
              nobody has claimed still has arithmetic worth checking. A note
              counts as tying if it is within ₹{data.tolerance.toFixed(2)} — the
              printed total is itself rounded to the rupee.
            </p>
          </div>

          <section className="statgrid">
            <Stat label="Notes checked" value={String(data.summary.notes)} />
            <Stat
              label="Tie"
              value={String(data.summary.ties)}
              cls={data.summary.ties === data.summary.notes ? "pos" : ""}
            />
            <Stat
              label="Do not tie"
              value={String(data.summary.off)}
              cls={data.summary.off > 0 ? "neg" : ""}
            />
            <Stat label="Cannot be checked" value={String(data.summary.unknown)} />
            <Stat
              label="Money at stake"
              value={`₹${money(data.summary.total_discrepancy)}`}
              cls={data.summary.total_discrepancy > 0 ? "neg" : ""}
            />
          </section>

          {clean && (
            <div className="card">
              <p>
                <strong>
                  All {data.summary.notes} notes tie against their own printed
                  totals.
                </strong>
              </p>
              <p className="footnote">
                That says the trade lines, charges and net amount were read
                consistently. It does not say a note is missing — only a holding
                statement can tell you that.
              </p>
            </div>
          )}

          {data.summary.notes === 0 && (
            <div className="card muted">
              Nothing to reconcile yet. Import some contract notes first.
            </div>
          )}

          {rows.length > 0 && (
            <section className="card">
              <h2>
                {onlyProblems ? "Notes that need a look" : "Every note"} ({rows.length})
              </h2>
              <div className="table-wrap">
                <table className="recon-table">
                  <thead>
                    <tr>
                      <th>Note</th>
                      <th>Date</th>
                      <th className="num">Trades</th>
                      <th className="num">Gross traded</th>
                      <th className="num">Charges</th>
                      <th className="num">Computed net</th>
                      <th className="num">Printed net</th>
                      <th className="num">Difference</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <ReconcileRow key={r.id} row={r} onDeleted={load} onError={setError} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="footnote">
                <strong>Gross traded</strong> is quantity x gross rate, signed —
                money out on a buy, in on a sale. It is deliberately not the net
                value: net rates already include brokerage, so subtracting the
                charge total from them would count brokerage twice.
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function ReconcileRow({
  row,
  onDeleted,
  onError,
}: {
  row: Row;
  onDeleted: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Two presses rather than a confirm dialog: a modal blocks the Electron
  // window outright if anything goes wrong, and this is undoable only by
  // re-importing the PDF.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const bad = row.status === "off";

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not delete.");
      onDeleted();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <>
      <tr>
        <td className="mono">{row.contract_note_number || "—"}</td>
        <td>{row.trade_date || "—"}</td>
        <td className="num">{row.trade_count}</td>
        <td className="num">{money(row.gross_traded)}</td>
        {/* Where the charge total came from is in the flags below, not inline:
            an extra tag here is the ~70px that pushed Status off the card. */}
        <td className="num">{money(row.charges)}</td>
        <td className="num">{money(row.computed_net)}</td>
        <td className="num">{money(row.printed_net)}</td>
        <td className={`num ${bad ? "neg" : ""}`}>
          {row.delta === null ? "—" : money(row.delta)}
        </td>
        <td className="status-cell">
          {/* "unknown" gets the plain badge deliberately — a green one would
              read as a pass, and an unchecked note has passed nothing. */}
          <span
            className={`badge ${
              row.status === "ties" ? "buy" : row.status === "off" ? "sell" : ""
            }`}
          >
            {row.status === "ties" ? "ties" : row.status === "off" ? "off" : "unknown"}
          </span>
          {row.flags.length > 0 && (
            <button className="linkbtn" onClick={() => setOpen(!open)}>
              {open ? "hide" : `${row.flags.length} note${row.flags.length === 1 ? "" : "s"}`}
            </button>
          )}
        </td>
        <td className="status-cell">
          {confirming ? (
            <>
              <button className="linkbtn neg" onClick={remove} disabled={busy}>
                {busy ? "…" : "delete it"}
              </button>
              <button className="linkbtn" onClick={() => setConfirming(false)}>
                keep
              </button>
            </>
          ) : (
            <button className="linkbtn" onClick={() => setConfirming(true)} title="Delete this note and its trades">
              remove
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className="wrap-cell footnote recon-detail">
            <ul>
              {row.flags.map((f) => (
                <li key={f.code} className={f.severity === "warn" ? "neg" : ""}>
                  {f.message}
                </li>
              ))}
            </ul>
            {row.status === "off" && row.implied_charges !== null && (
              <p>
                For this note to tie, charges would have to be{" "}
                <strong>₹{money(row.implied_charges)}</strong> rather than ₹
                {money(row.charges)} — a gap of ₹
                {money(Math.abs(row.charges - row.implied_charges))}. The
                components on the note add to ₹{money(row.charges_from_components)}.
              </p>
            )}
          </td>
        </tr>
      )}
    </>
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
