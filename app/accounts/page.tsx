"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Accounts — the people whose portfolios this app holds.
 *
 * An account is a person or entity identified by PAN, not a demat account: one
 * account pools every broker that person trades through, which is why holdings
 * and P&L are computed per account rather than per broker.
 *
 * Imported notes that match no account are held here until claimed. They are
 * deliberately absent from every portfolio figure until then — a note nobody has
 * claimed must not quietly join someone else's holdings.
 */

interface AccountCode {
  id: string;
  broker_name: string;
  client_code: string;
}

interface Account {
  id: string;
  label: string;
  pan: string | null;
  entity_type: string;
  codes?: AccountCode[];
}

interface UnassignedGroup {
  pan: string | null;
  broker_name: string | null;
  client_code: string | null;
  client_name: string | null;
  notes: number;
  trades: number;
}

const ENTITY_TYPES = ["INDIVIDUAL", "HUF", "COMPANY", "TRUST", "OTHER"];

function groupKey(g: UnassignedGroup): string {
  return [g.pan, g.broker_name, g.client_code, g.client_name].join("|");
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedGroup[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load accounts.");
      setSupported(json.supported);
      setAccounts(json.accounts ?? []);
      setUnassigned(json.unassigned ?? []);
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
        <h1>Accounts</h1>
        <p className="subtitle">
          One account per person or entity, identified by PAN. Every broker that
          person trades through pools into the same account, so holdings and gains
          are computed across all of them.
        </p>
      </header>

      {error && <div className="card error">⚠️ {error}</div>}
      {message && <div className="card muted">{message}</div>}
      {loading && <div className="card muted">Loading…</div>}

      {!supported && (
        <div className="card muted">
          <p>
            <strong>Accounts are a desktop feature.</strong>
          </p>
          <p>
            The hosted version keeps a single pooled portfolio. Use the desktop app
            to keep several people&apos;s holdings apart.
          </p>
        </div>
      )}

      {/*
        With no accounts yet, the queue below is a table of controls that cannot
        be used — every dropdown reads "Add an account first". Leading with that
        makes the page look broken rather than unfinished, so say plainly what
        the one next step is.
      */}
      {supported && !loading && accounts.length === 0 && unassigned.length > 0 && (
        <div className="card">
          <p>
            <strong>
              Nothing can be counted until you add an account — you have none yet.
            </strong>
          </p>
          <p className="footnote">
            Add one in <strong>Add an account</strong> at the bottom of this page.
            If you put the PAN in, every waiting note carrying that PAN claims
            itself immediately and there is nothing left to assign by hand.
            {unassigned[0]?.pan && (
              <>
                {" "}
                The notes waiting below are all PAN{" "}
                <span className="mono">{unassigned[0].pan}</span>
                {unassigned[0].client_name ? ` (${unassigned[0].client_name})` : ""}.
              </>
            )}
          </p>
        </div>
      )}

      {supported && !loading && (
        <>
          {unassigned.length > 0 && (
            <section className="card">
              <h2>Waiting to be assigned ({unassigned.length})</h2>
              <p className="footnote">
                These notes are imported and saved, but no account claims them yet,
                so they are <strong>not counted in any portfolio figure</strong>.
                Assign each one to an account below. Doing so also remembers the
                broker and client code, so future imports route themselves.
              </p>
              <div className="table-wrap">
                <table className="assign-table">
                  <thead>
                    <tr>
                      <th>Name on note</th>
                      <th>PAN</th>
                      <th>Broker</th>
                      <th>Client code</th>
                      <th className="num">Notes</th>
                      <th className="num">Trades</th>
                      <th>Assign to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unassigned.map((g) => (
                      <AssignRow
                        key={groupKey(g)}
                        group={g}
                        accounts={accounts}
                        onDone={(msg) => {
                          setMessage(msg);
                          load();
                        }}
                        onError={setError}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="card">
            <h2>Accounts ({accounts.length})</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>PAN</th>
                    <th>Known broker codes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      onChanged={(msg) => {
                        setMessage(msg);
                        load();
                      }}
                      onError={setError}
                    />
                  ))}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No accounts yet. Add the first one below — then anything
                        waiting above can be assigned to it.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <NewAccountForm
              onSaved={(label) => {
                setMessage(`Added ${label}.`);
                load();
              }}
              onError={setError}
            />
          </section>
        </>
      )}
    </main>
  );
}

function AssignRow({
  group,
  accounts,
  onDone,
  onError,
}: {
  group: UnassignedGroup;
  accounts: Account[];
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);

  async function assign() {
    if (!choice) return;
    setBusy(true);
    try {
      const res = await fetch("/api/accounts/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: choice,
          broker_name: group.broker_name,
          client_code: group.client_code,
          pan: group.pan,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not assign.");
      const to = accounts.find((a) => a.id === choice)?.label ?? "the account";
      onDone(`Moved ${json.notes} note(s) and ${json.trades} trade(s) to ${to}.`);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{group.client_name || "—"}</td>
      <td className="mono">{group.pan || "—"}</td>
      <td>{group.broker_name || "—"}</td>
      <td className="mono">{group.client_code || "—"}</td>
      <td className="num">{group.notes}</td>
      <td className="num">{group.trades}</td>
      <td className="assign-cell">
        {/*
          With no accounts there is nothing to choose and nothing to assign, so
          a disabled dropdown beside a disabled button is a dead end. Offer the
          action that actually moves things forward instead.
        */}
        {accounts.length === 0 ? (
          <button
            className="btn"
            onClick={() => {
              const field = document.getElementById("new-account-name");
              field?.scrollIntoView({ behavior: "smooth", block: "center" });
              (field as HTMLInputElement | null)?.focus({ preventScroll: true });
            }}
          >
            Add an account ↓
          </button>
        ) : (
          <div className="formrow">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={busy}
            >
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <button className="btn" onClick={assign} disabled={!choice || busy}>
              {busy ? "…" : "Assign"}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function NewAccountForm({
  onSaved,
  onError,
}: {
  onSaved: (label: string) => void;
  onError: (message: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({ entity_type: "INDIVIDUAL" });
  const [busy, setBusy] = useState(false);

  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: f.label,
          pan: f.pan || null,
          entity_type: f.entity_type,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not add the account.");
      const label = f.label;
      setF({ entity_type: "INDIVIDUAL" });
      onSaved(label);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="entryform">
      <h3>Add an account</h3>
      <p className="hint">
        The PAN is what links this person&apos;s notes across brokers — with it set,
        matching notes assign themselves on import. You can leave it blank and map
        broker codes by hand instead.
      </p>
      <div className="formrow">
        <input
          id="new-account-name"
          placeholder="Name *"
          value={f.label || ""}
          onChange={set("label")}
          required
        />
        <select value={f.entity_type} onChange={set("entity_type")}>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0) + t.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <input
          placeholder="PAN (ABCDE1234F)"
          value={f.pan || ""}
          onChange={set("pan")}
          style={{ textTransform: "uppercase" }}
        />
        <button className="btn" disabled={busy}>
          {busy ? "…" : "Add"}
        </button>
      </div>
    </form>
  );
}

/**
 * One account, editable in place.
 *
 * A wrong PAN is the one worth fixing rather than working around: it is what
 * routes notes to a person, so correcting it also claims every note that has
 * been sitting unassigned waiting for it.
 *
 * Deleting withdraws the claim and nothing else. The notes came from real
 * documents and go back to the unassigned queue — deleting an account is a
 * statement about the account, not about them.
 */
function AccountRow({
  account,
  onChanged,
  onError,
}: {
  account: Account;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    label: account.label,
    pan: account.pan ?? "",
    entity_type: account.entity_type,
  });

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: f.label, pan: f.pan || null, entity_type: f.entity_type }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save.");
      setEditing(false);
      onChanged(`Updated ${f.label}.`);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not delete.");
      onChanged(`Deleted ${account.label}. Its notes are back in the queue above.`);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={5}>
          <div className="formrow">
            <input
              value={f.label}
              onChange={(e) => setF({ ...f, label: e.target.value })}
              placeholder="Name *"
            />
            <select
              value={f.entity_type}
              onChange={(e) => setF({ ...f, entity_type: e.target.value })}
            >
              {ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <input
              value={f.pan}
              onChange={(e) => setF({ ...f, pan: e.target.value })}
              placeholder="PAN (ABCDE1234F)"
              style={{ textTransform: "uppercase" }}
            />
            <button className="btn" onClick={save} disabled={busy}>
              {busy ? "…" : "Save"}
            </button>
            <button className="linkbtn" onClick={() => setEditing(false)}>
              cancel
            </button>
          </div>
          <p className="footnote">
            Correcting the PAN also claims any unassigned note carrying it.
          </p>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <b>{account.label}</b>
      </td>
      <td>{account.entity_type}</td>
      <td className="mono">{account.pan || "—"}</td>
      <td className="footnote">
        {account.codes && account.codes.length > 0
          ? account.codes.map((c) => `${c.broker_name} · ${c.client_code}`).join(", ")
          : "none yet"}
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
          <>
            <button className="linkbtn" onClick={() => setEditing(true)}>
              edit
            </button>
            <button className="linkbtn" onClick={() => setConfirming(true)}>
              delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
