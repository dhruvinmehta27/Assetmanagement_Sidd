"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Folder import — desktop only.
 *
 * Points at a root folder containing inbox/, extracts every PDF in it, saves to
 * Supabase, and files each file into imported/ or failed/. Progress streams as
 * newline-delimited JSON because a large batch is many minutes and real money;
 * the user needs to see what is happening and be able to stop it.
 */

type Status = "processing" | "saved" | "duplicate" | "failed";

interface Row {
  index: number;
  name: string;
  status: Status;
  broker?: string | null;
  trade_date?: string | null;
  contract_note_number?: string | null;
  trades?: number;
  movedTo?: string | null;
  error?: string;
}

interface Summary {
  saved: number;
  duplicate: number;
  failed: number;
  total: number;
  processed: number;
  aborted: boolean;
  elapsedMs: number;
}

interface DesktopApi {
  isDesktop: true;
  pickFolder: () => Promise<string | null>;
  reveal: (target: string) => Promise<void>;
}

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}

const ROOT_KEY = "importRoot";

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function ImportPage() {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [root, setRoot] = useState<string>("");
  const [scan, setScan] = useState<{ count: number; files: string[] } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // window.desktopApi only exists behind the Electron preload, so this is also
  // the check for "are we in the desktop app".
  useEffect(() => {
    setDesktop(Boolean(window.desktopApi?.isDesktop));
    const saved = localStorage.getItem(ROOT_KEY);
    if (saved) setRoot(saved);
  }, []);

  const runScan = useCallback(async (folder: string) => {
    setError(null);
    setScan(null);
    setSummary(null);
    setRows([]);
    try {
      const res = await fetch("/api/import/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: folder }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Scan failed.");
      setScan({ count: json.count, files: json.files });
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const choose = useCallback(async () => {
    const picked = await window.desktopApi?.pickFolder();
    if (!picked) return;
    setRoot(picked);
    localStorage.setItem(ROOT_KEY, picked);
    await runScan(picked);
  }, [runScan]);

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    setRows([]);
    setSummary(null);
    setProgress({ processed: 0, total: scan?.count ?? 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Import failed to start.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // NDJSON: a chunk can split mid-line, so keep the remainder for next time.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);

          if (evt.type === "start") {
            setProgress({ processed: 0, total: evt.total });
          } else if (evt.type === "file") {
            setRows((prev) => [...prev, { index: evt.index, name: evt.name, status: "processing" }]);
          } else if (evt.type === "result") {
            setRows((prev) =>
              prev.map((r) => (r.index === evt.index ? { ...r, ...evt, status: evt.status } : r))
            );
          } else if (evt.type === "progress") {
            setProgress({ processed: evt.processed, total: evt.total });
          } else if (evt.type === "done") {
            setSummary(evt as Summary);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") setError(err.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
      if (root) runScan(root);
    }
  }, [root, scan, runScan]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  if (desktop === null) return null;

  if (!desktop) {
    return (
      <main className="container">
        <div className="header">
          <nav className="nav">
            <a href="/">← Upload</a>
            <a href="/portfolio">Portfolio &amp; P&amp;L</a>
            <span className="nav-active">Folder Import</span>
          </nav>
          <h1>Folder Import</h1>
        </div>
        <div className="card muted">
          <p>
            <strong>Install the desktop app to use this feature.</strong>
          </p>
          <p>
            Importing a whole folder at once means reading PDFs straight off your
            disk and moving them as they are processed. A browser tab is not
            allowed to do either — so this page can only work in the macOS
            desktop build, which runs the same app with filesystem access.
          </p>
          <p className="footnote">
            Build it from the repo with <span className="mono">npm run desktop:build</span>,
            which produces <span className="mono">Asset Manager.dmg</span>. See the
            README for setup. In the meantime you can upload contract notes one at
            a time from the <a href="/">Upload</a> page — same extraction, same
            de-duplication, just one file per go.
          </p>
        </div>
      </main>
    );
  }

  const failures = rows.filter((r) => r.status === "failed");
  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <main className="container">
      <div className="header">
        <nav className="nav">
          <a href="/">← Upload</a>
          <a href="/portfolio">Portfolio &amp; P&amp;L</a>
          <span className="nav-active">Folder Import</span>
        </nav>
        <h1>Folder Import</h1>
        <p className="subtitle">
          Drop contract note PDFs into <span className="mono">inbox/</span> and import them
          all at once. Each file is filed into <span className="mono">imported/</span> by
          broker and financial year, or into <span className="mono">failed/</span> with a
          note explaining why.
        </p>
      </div>

      <div className="card">
        <div className="formrow">
          <button className="btn" onClick={choose} disabled={running}>
            {root ? "Change folder…" : "Choose folder…"}
          </button>
          {root && (
            <button className="btn" onClick={() => window.desktopApi?.reveal(root)}>
              Open in Finder
            </button>
          )}
        </div>

        {root && <p className="mono footnote">{root}</p>}

        {!root && (
          <p className="footnote">
            Pick any folder. The app creates <span className="mono">inbox/</span>,{" "}
            <span className="mono">imported/</span> and <span className="mono">failed/</span>{" "}
            inside it if they are not already there.
          </p>
        )}

        {scan && (
          <p className="info">
            <span className="info-label">Waiting in inbox</span>
            <span className="info-value">
              {scan.count} PDF{scan.count === 1 ? "" : "s"}
            </span>
          </p>
        )}

        {scan && scan.count > 0 && !running && (
          <>
            <p className="footnote">
              This runs one Claude extraction per PDF — {scan.count} API call
              {scan.count === 1 ? "" : "s"}, billed to your key. Already-imported notes are
              detected and skipped without being saved twice.
            </p>
            <button className="btn" onClick={start}>
              Import {scan.count} PDF{scan.count === 1 ? "" : "s"}
            </button>
          </>
        )}

        {scan && scan.count === 0 && !running && (
          <p className="footnote">
            Nothing to import. Put some PDFs in{" "}
            <span className="mono">{root}/inbox</span> and scan again.
          </p>
        )}

        {root && !running && (
          <button className="btn" onClick={() => runScan(root)}>
            Rescan
          </button>
        )}

        {running && (
          <div className="savebar">
            <span className="savestate">
              {progress?.processed ?? 0} / {progress?.total ?? 0} — {pct}%
            </span>
            <button className="btn" onClick={stop}>
              Stop
            </button>
          </div>
        )}
      </div>

      {error && <div className="card error">{error}</div>}

      {summary && (
        <div className="card">
          <h2>{summary.aborted ? "Stopped" : "Done"}</h2>
          <div className="statgrid">
            <div className="stat">
              <div className="stat-label">Saved</div>
              <div className="stat-value pos">{summary.saved}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Already imported</div>
              <div className="stat-value">{summary.duplicate}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Failed</div>
              <div className="stat-value neg">{summary.failed}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Time</div>
              <div className="stat-value">{formatElapsed(summary.elapsedMs)}</div>
            </div>
          </div>
          {failures.length > 0 && (
            <p className="footnote">
              Failed files were moved to <span className="mono">failed/</span> with a{" "}
              <span className="mono">.error.txt</span> beside each one. Fix them and move
              them back into <span className="mono">inbox/</span> to retry.
            </p>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Broker</th>
                  <th>Trade date</th>
                  <th>Trades</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.index}>
                    <td className="mono">{r.name}</td>
                    <td>{r.broker ?? "—"}</td>
                    <td>{r.trade_date ?? "—"}</td>
                    <td className="num">{r.status === "saved" ? r.trades : "—"}</td>
                    <td>
                      {r.status === "processing" && <span className="muted">extracting…</span>}
                      {r.status === "saved" && <span className="tag pos">saved</span>}
                      {r.status === "duplicate" && <span className="tag">already imported</span>}
                      {r.status === "failed" && (
                        <>
                          <span className="tag neg">failed</span>
                          <div className="footnote wrap-cell">{r.error}</div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
