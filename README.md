# Stock Asset Management — Contract Note Extractor

Turns **unstructured broker contract note PDFs** into a **structured portfolio**:
trades, charges, holdings, FIFO realized P&L by Indian financial year, dividends
and corporate actions.

Extraction is done by the **Claude API**. The same Next.js app runs in two
places, and they store data differently:

| | how it runs | where data goes | extras |
|---|---|---|---|
| **Web** | Next.js on Vercel | Supabase | — |
| **Desktop** | the same server hosted inside an Electron macOS app | **a local SQLite file — nothing leaves the machine** | **bulk folder import** straight off your disk |

The desktop app needs **no database account, no service-role key, and no
network storage**: it creates `portfolio.db` next to its settings file on first
use. See [Where data is stored](#where-data-is-stored).

---

## Contents

- [What it does](#what-it-does)
- [Using the desktop app](#using-the-desktop-app)
- [Quick start (web / dev)](#quick-start-web--dev)
- [Architecture](#architecture)
- [Where data is stored](#where-data-is-stored)
- [Accounts](#accounts-whose-money-is-it)
- [Extraction](#extraction-pdf--structured-json)
- [Data model](#data-model)
- [Portfolio analytics](#portfolio-analytics)
- [Pages](#pages)
- [API routes](#api-routes)
- [Desktop app](#desktop-app-macos)
- [Folder import](#folder-import-bulk-pdfs--desktop-only)
- [Deploying to Vercel](#deploying-to-vercel)
- [Security model](#security-model)
- [Project structure](#project-structure)
- [Current status & roadmap](#current-status--roadmap)

---

## What it does

1. **Upload** one or more contract note PDFs (web or desktop), or point the
   desktop app at a **folder** of them.
2. Each PDF goes to Claude with a **forced tool schema**, so the response is
   valid JSON matching a fixed contract-note shape — never free-form text.
3. The note and its individual trade lines are **saved** — to a local SQLite file
   on desktop, to Supabase on the web — deduplicated on
   `(broker, contract note number, trade date)` so the same PDF can be imported
   twice with no double-counting.
4. The **Portfolio page** computes, from every stored trade: current holdings,
   FIFO realized gains split short-term / long-term, per-financial-year P&L,
   and dividend totals — with splits and bonuses applied.

---

## Using the desktop app

The short version, for someone who just wants to run it.

**1. Build it** (once, and again whenever you change the code):

```bash
npm install
npm run desktop:build          # -> dist/Asset Manager-0.1.0-arm64.dmg
```

Open the `.dmg` and drag **Asset Manager** to Applications. The build is
unsigned, so the first launch needs **right-click → Open** (double-clicking gets
you Gatekeeper's "unidentified developer" wall). After that it opens normally.

**2. First launch** opens **Settings** automatically. Paste your Anthropic API
key from [console.anthropic.com](https://console.anthropic.com) and Save. That is
the only thing you have to configure — there is no database to set up, no
account, no Supabase keys. **Quit and reopen the app** so the server picks the
key up.

**3. Add an account.** Open **Accounts** and add one per person or entity whose
notes you'll import — a name, the type (Individual / HUF / …) and ideally the
**PAN**. With the PAN set, matching notes assign themselves on import, including
from brokers that account has never used. Without it you map broker client codes
by hand, once each.

**4. Try one note first.** Go to **Upload**, choose a single contract note PDF,
click **Extract data**, check the extracted fields look right, then **Save to
portfolio**. Open **Portfolio & P&L** and you should see one contract note and
its trades. Extraction has never been run against a real key, so this first note
is the genuine test — do it before pointing the app at a backlog.

**5. Bulk import the rest.** Go to **Folder Import** → **Choose folder…** and
pick (or create) a folder — say `~/Documents/ContractNotes`. The app creates
`inbox/`, `imported/` and `failed/` inside it. Drop your PDFs into `inbox/`,
nested however you like, click **Rescan**, and it tells you how many are waiting
before anything is billed. Click **Import N PDFs**. Progress streams live and
**Stop** ends it immediately. Each file moves to `imported/<broker>/<FY>/` or to
`failed/` with a `.error.txt` explaining why.

Start with 2–3 PDFs rather than all of them: each PDF is one Claude API call
billed to your key.

**6. Add dividends and corporate actions** on the Portfolio page as they happen.
Splits and bonuses matter — without them a post-split sale computes the wrong
gain. The multiplier is new shares ÷ old shares (2-for-1 split or 1:1 bonus →
`2`; 3:2 bonus → `2.5`).

**Things worth knowing:**

- **Everything stays on your Mac.** Portfolio data goes into
  `~/Library/Application Support/Asset Manager/portfolio.db`. **Settings → Show
  in Finder** reveals it. Back up that one file and you have your whole portfolio.
- **The PDFs themselves are sent to the Anthropic API** for extraction — that is
  how they get read. Local storage covers where the extracted data rests, not
  that.
- **Re-importing is always safe.** Duplicates are detected by content, so a
  folder you already imported just reports "already imported".
- **Restart after changing the API key** — the server reads it at startup.
- If a batch stops halfway (crash, quit, Stop), the unprocessed PDFs are still in
  `inbox/`. Just run it again; it picks up where it left off.

---

## Quick start (web / dev)

```bash
npm install
cp .env.example .env.local     # then edit .env.local
npm run dev                    # http://localhost:3000
```

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | From [console.anthropic.com](https://console.anthropic.com) → API Keys. Server-side only. |
| `ANTHROPIC_MODEL` | no | Overrides the extraction model. Defaults to `claude-opus-5`. |
| `NEXT_PUBLIC_SUPABASE_URL` | web only | Supabase → Settings → API → Project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | web only | Supabase → Settings → API → `service_role`. **Bypasses RLS — server-side only, never commit.** |
| `STORAGE_DRIVER` | no | `sqlite` or `supabase`. Forces a backend; otherwise inferred (see below). |
| `LOCAL_DB_PATH` | no | Where the SQLite file lives. Electron sets this; the default is under Application Support. |

`.env.local` is gitignored. If a key is ever pasted into chat or committed, rotate it.

The two Supabase variables are needed only for the **web** build. The desktop app
uses a local database and ignores them — `npm run desktop:dev` needs nothing but
the Anthropic key.

The Supabase URL is trimmed and any trailing `/` stripped before use — a trailing
slash produces `https://xxx.supabase.co//rest/v1/...`, which Supabase rejects with
"Invalid path specified in request URL".

### Database (web only)

Open Supabase → SQL Editor → New query, paste all of
[`supabase/schema.sql`](supabase/schema.sql), Run. It is idempotent
(`IF NOT EXISTS` / `CREATE OR REPLACE`), so re-running is safe.

The desktop app needs none of this — it creates its own tables on first use.

---

## Architecture

```
                ┌───────────────────────────────────────────────┐
  PDF  ────────►│  /api/extract   ──► Claude (forced tool)       │
                │                     ↓ ContractNote JSON        │
                │  /api/notes     ──► store ──┬─► SQLite (local) │
                │                             └─► Supabase (web) │
                └───────────────────────────────────────────────┘
                                       ↓
                ┌───────────────────────────────────────────────┐
  Portfolio ◄───│  /api/portfolio ──► app/lib/analytics.ts       │
                │    holdings · FIFO P&L · FY buckets            │
                └───────────────────────────────────────────────┘
```

- **Next.js 16 App Router**, React 19, TypeScript. No CSS framework — one
  `app/globals.css`.
- All Claude and database calls happen in **route handlers on the server**. No
  key ever reaches the browser, in either flavour.
- **Persistence sits behind one small interface** (`app/lib/store/types.ts`) with
  two drivers. Routes never talk to Supabase or SQLite directly, so adding or
  swapping a backend touches one file, not seven.
- `app/lib/extract.ts` and the store are shared by the single-upload path and the
  batch importer on purpose — otherwise the batch path quietly drifts and the two
  start producing different data.

---

## Where data is stored

The store interface is deliberately tiny — seven operations — because that is all
the app needs. Every non-trivial computation happens in `app/lib/analytics.ts`
over plain arrays, so the database is only ever asked to write rows and hand them
all back.

### Which driver runs

| condition | driver |
|---|---|
| `STORAGE_DRIVER` is set | whatever it says |
| else `DESKTOP_APP=1` (Electron, and `desktop:dev`) | `sqlite` |
| else (Vercel, plain `npm run dev`) | `supabase` |

The Electron main process sets both `STORAGE_DRIVER=sqlite` and `LOCAL_DB_PATH`
explicitly when it spawns the server, so the packaged app is never ambiguous.

### Local (desktop)

```
~/Library/Application Support/Asset Manager/portfolio.db
```

- Uses **`node:sqlite`, built into the Node runtime** — Electron 43 ships Node 24.
  That is the whole reason this was cheap: a native module like `better-sqlite3`
  would reintroduce platform-specific binaries into the bundle and need an ABI
  rebuild per Electron version, undoing the work that keeps a Windows build
  straightforward.
- The file and its `-wal` / `-shm` sidecars are **`0600`**. The file is created
  private *before* the database is opened, because SQLite copies the main file's
  permissions onto the sidecars — chmod-ing afterwards would leave the WAL, which
  holds recently written rows, world-readable.
- Tables are created on first use, mirroring `supabase/schema.sql`. There is no
  RLS because there is no server and no second user; the file permissions are the
  access control.
- **Backup = copy one file.** Quit the app first so the WAL is checkpointed, or
  copy `portfolio.db`, `-wal` and `-shm` together.
- Every `fs` call in the driver carries a `turbopackIgnore` hint, for the same
  reason `ensureStructure()` does — see [Build notes](#build-notes).

### Concurrency

`node:sqlite` is synchronous, and Node is single-threaded, so one statement
cannot interleave with another. That is what makes the check-then-insert in
`saveContractNote()` safe while the importer runs three files at once, with no
locking of our own. The `UNIQUE` constraint is the backstop: if two workers race
the same note, the loser catches the violation and reports `duplicate` with the
winner's id — verified by firing three identical saves concurrently.

Notes missing any part of the dedupe key are **not** deduplicated — two
unidentifiable notes are not the same note. This matches how Postgres treats
NULLs in a unique constraint.

---

## Accounts — whose money is it?

Desktop only. Without this, every contract note imported lands in one pool, and
two family members' holdings blend into numbers that belong to nobody.

**An account is a person or entity, identified by PAN — not a demat account.**
One account pools every broker that person trades through. That is a deliberate
choice with a real trade-off:

- ✅ Matches how a return is filed — one PAN, one set of gains.
- ❌ Holdings will not tie to any single broker's statement, because a sale at one
  broker can consume shares bought at another.
- ❌ **Holdings and P&L cannot be filtered by broker.** Slicing a FIFO computation
  by broker would produce numbers that are simply wrong, so the broker dimension
  applies only to notes, trades and dividends.

### How a note finds its account

1. **By PAN.** If the note prints one and an account has it, done — including at
   a broker that account has never used before. PAN is normalised (uppercased,
   spaces stripped, format-checked) so it compares equal however it was printed.
2. **By broker + client code.** Client codes are broker-specific — a code at
   one broker is a different string for the same person at another — so each pair
   is mapped once, then remembered.
3. **Neither?** The note is saved **unassigned** and held out of every portfolio
   figure until someone claims it on the Accounts page. A bulk import never stops
   for this; it completes, and the Portfolio page says loudly how many notes are
   sitting outside the totals.

**Creating an account with a PAN immediately claims every unassigned note
carrying it**, whatever broker they came from — PAN identifies the person, so
there is nothing left to ask. Assigning a group by hand does the same for its
broker/client code, backfills the notes and trades already imported, and adopts
the PAN if the account did not have one, so nothing from that identity ever needs
assigning again.

### FIFO is computed per account, then merged

The engine runs once per account and the **results** are added up. Trades from
two accounts are never handed to it in one array: FIFO would match one person's
sale against another's buy lots, inventing a gain that belongs to nobody and
leaving the wrong cost basis behind. Merging outputs is safe — quantities and
amounts simply add, and realized events carry their own dates.

Corporate actions stay **global**, keyed by ISIN: a 2-for-1 split is a fact about
the security, not about an account. Dividends are per-account, because that is
where they are actually received.

---

## Extraction (PDF → structured JSON)

`app/lib/extract.ts` + `app/lib/schema.ts`.

- The PDF is sent base64 as a `document` block; Claude must call the
  `record_contract_note` tool (`tool_choice: {type: "tool"}`), so the reply is
  always schema-shaped JSON.
- `CONTRACT_NOTE_TOOL.input_schema` is **kept in lockstep with the TypeScript
  interfaces** in the same file, so the two cannot drift.
- Every field is nullable by design — contract notes vary a lot between brokers.
  The system prompt says to return `null` rather than guess, to keep every trade
  line separate, to normalise to `BUY`/`SELL`, to emit plain numbers, and to use
  ISO dates when unambiguous.
- `max_tokens: 16000` — covers thinking *and* tool output, which share one budget.
  8000 truncated notes with many trade lines.
- **Failure paths are explicit**, because a silent bad save is worse than an error:
  - `stop_reason === "refusal"` → a 200-with-empty-content decline, surfaced as
    "the model declined… re-upload it" instead of the misleading "no structured data".
  - `stop_reason === "max_tokens"` → the tool block exists but its JSON is
    half-parsed; the note is failed rather than saved.
  - No `tool_use` block → 502.
  - API errors are unwrapped to the real message and keep their HTTP status.

**Charges captured:** brokerage, exchange transaction, clearing, SEBI turnover
fees, STT, stamp duty, IPFT, GST/CGST/SGST/IGST, demat (DP), rounding, other,
total. **Per trade:** order/trade no, time, security, symbol, ISIN, exchange,
segment, side, quantity, gross rate, brokerage per unit, net rate, gross value,
net value.

---

## Data model

Four tables, the same shape in both backends: `supabase/schema.sql` for Postgres,
and the `SCHEMA` constant in `app/lib/store/sqlite.ts` for local. The Postgres
version adds three views and a helper function.

| Table | Row = | Notes |
|---|---|---|
| `accounts` 🖥 | one person or entity | label, PAN (unique), entity type. See [Accounts](#accounts-whose-money-is-it). |
| `account_codes` 🖥 | one broker's client code | maps `(broker, client code)` → account, unique on that pair |
| `contract_notes` | one PDF | full charge breakdown + `raw_json` of the whole extraction, for audit. Unique on `(broker_name, contract_note_number, trade_date)`. |
| `trades` | one trade line | `side` BUY/SELL, `quantity` always positive. Indexed on ISIN, trade date, note id. |
| `corporate_actions` | one split / bonus / merger | `quantity_multiplier`: new qty = old qty × multiplier. Unique on `(isin, action_type, ex_date)`. |
| `dividends` | one dividend receipt | gross, TDS, net; manual or auto source. |

| View / function | |
|---|---|
| `fin_year(date)` | Indian FY label, 1 Apr–31 Mar → `2024-25` |
| `v_trades_fy` | trades tagged with financial year |
| `v_net_positions` | naive net qty per ISIN (ignores corporate actions — the app's computation is authoritative) |
| `v_dividends_fy` | dividends by FY (pay date, falling back to ex date) |

In Postgres, **RLS is enabled on every table with no public policies**, so the
anon key can read and write nothing; all access is server-side with the service
role key, which bypasses RLS. The local SQLite file has no equivalent because it
has no network surface — its access control is the `0600` file mode.

Differences in the local schema, none of which the app can see: `uuid` → `text`
holding a `randomUUID()`, `numeric` → `real`, `jsonb` → `text` holding JSON,
dates → ISO `text`, and no views (the app computes everything anyway).

### De-duplication

Content-based, on `(broker_name, contract_note_number, trade_date)` — taken from
the *extracted* note, not the filename. Importing the same PDF twice, under any
name or path, reports `already imported` and saves nothing. This is why folder
names carry no meaning for the app: organise your PDFs however you like.

---

## Portfolio analytics

`app/lib/analytics.ts` — pure, deterministic, no I/O. Takes trades + corporate
actions, returns holdings and every realized lot event.

- **Grouping** is by ISIN, falling back to security name when ISIN is missing
  (some brokers print a scrip code instead of a symbol; ISIN is the reliable
  cross-broker key).
- **Event ordering:** chronological, and on the same date **corporate actions
  first, then buys, then sells** — so a split on the morning of a sale is applied
  before the sale is matched.
- **Splits / bonuses** multiply lot quantity and divide cost per unit, so total
  cost basis is preserved exactly.
- **FIFO matching:** a sell consumes the oldest open lots first, emitting one
  realized event per lot matched, with `holding_days` and FY.
- **Long vs short term:** held **> 365 days** = `LONG`, else `SHORT`.
- **A sell that exceeds holdings** (e.g. missing opening data) has its unmatched
  part ignored rather than assigned an invented cost.
- **Dividends** are aggregated separately, by pay date and falling back to ex
  date; gross defaults to `amount_per_share × quantity`, net to `gross − TDS`.

### Cost-basis convention (v1)

Buys and sells use `net_value` from the contract note — i.e. **brokerage-inclusive**
(`quantity × net_rate`). Note-level statutory levies (STT, stamp duty, GST,
exchange/SEBI charges) are stored per contract note but **not yet allocated per
trade**. STT by law is *not* a deductible cost for Indian capital gains, so
excluding it is correct; finer allocation of the remaining levies can be layered
on later without touching the stored data, since `raw_json` keeps everything.

---

## Pages

### `/` — Upload

- Select **one or many** PDFs (⌘-click / shift-click). Two extractions run
  concurrently, to stay clear of rate limits.
- A single file opens straight into the detail view (the original one-file flow);
  multiple files get a status table — queued → extracting → ready / failed, then
  saved / already in portfolio / save failed, with the error text wrapped so it
  can't stretch the table sideways.
- **Save to portfolio** per note, or **Save N to portfolio** for the batch (run
  sequentially — they hit the same de-dupe check and a handful of saves is fast
  enough that parallelism buys nothing). The button reads *"Nothing to save"*
  rather than *"All saved"* when nothing extracted successfully.
- Click any extracted row for the full detail: summary, every trade, the complete
  charges grid, parser notes, and the raw JSON.

### `/accounts` — Accounts (desktop)

- Everything **waiting to be assigned**, grouped by the identity printed on the
  notes, with the note and trade counts it is holding back from your totals.
- The accounts themselves, with their PAN and every broker code known to route to
  them.
- A form to add an account — name, entity type, PAN (validated).

### `/portfolio` — Portfolio & P&L

- **Account switcher** (one person, or all combined) and a **financial-year
  filter**, plus a banner when notes are sitting unassigned and excluded.
- Stat row: contract notes, trades, open holdings, invested, realized P&L,
  dividends.
- **Current holdings** — qty, average cost, invested.
- **Realized P&L by financial year** — short-term, long-term, total, proceeds,
  cost, lots closed.
- **Dividends by financial year** — gross, TDS, net, count — plus an inline form
  to add one.
- **Corporate actions** — with an inline form; the hint spells out the multiplier
  (2-for-1 split or 1:1 bonus → **2**; 3:2 bonus → **2.5**), and cost basis is
  preserved automatically.

### `/import` — Folder Import

Desktop only; see below. On the web it renders an explanation and a pointer back
to the upload page.

---

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/extract` | POST | multipart PDF → structured note. Rejects non-PDF content types. `maxDuration = 60`. |
| `/api/notes` | POST | persist an extracted note + trades; returns `{saved, duplicate, note_id, trades}`. |
| `/api/portfolio` | GET | holdings, realized events, FY P&L, dividends (raw + by FY), corporate actions, summary totals. `force-dynamic`. |
| `/api/dividends` | GET / POST | list / add. Derives gross from per-share × qty and net from gross − TDS when not given. |
| `/api/corporate-actions` | GET / POST | list / **upsert** on `(isin, action_type, ex_date)`. |
| `/api/accounts` | GET / POST | 🖥 list accounts and everything unassigned / create an account. |
| `/api/accounts/assign` | POST | 🖥 claim an unassigned group for an account; backfills and remembers the mapping. |
| `/api/import/scan` | POST | 🖥 pre-flight: create the folder structure, count what's in `inbox/`. |
| `/api/import` | POST | 🖥 run the batch; streams NDJSON progress. `maxDuration = 300`. |

🖥 = desktop only. The import routes return **403** unless `DESKTOP_APP=1`; the
account routes report `supported: false` on the web, where a single pooled
portfolio is kept as before.

A partial write is reported honestly: if the note row commits but the trade rows
fail, the error carries the note id, so a partial save can't be mistaken for a
total failure.

---

## Desktop app (macOS)

The same Next.js server, hosted inside an Electron app instead of on Vercel. It
binds to `127.0.0.1` on a **random free port**, and the window is a plain browser
view onto that origin — so `/api/extract` and the data routes keep running
server-side, the API key never reaches the renderer, and the local database is
opened by the server process rather than the page.

```bash
npm run desktop:dev      # next dev + Electron window, hot reload
npm run desktop:build    # -> dist/Asset Manager-<version>-arm64.dmg
```

**How it boots** (`electron/main.js`):

- Dev points the window at `http://127.0.0.1:3000` (`next dev` is already running
  via the `desktop:dev` script). Production spawns
  `.next/standalone/server.js` with Electron's own Node
  (`ELECTRON_RUN_AS_NODE=1` — without it, spawning the Electron binary launches a
  second GUI app), cwd set to the standalone root so `server.js` can resolve
  `.next/static`, then waits up to 30s for the port to accept a connection.
- The server child gets `DESKTOP_APP=1`, which is what unlocks the folder-import
  routes.
- If the server exits unexpectedly after startup you get an error dialog rather
  than a dead blank window. The server is killed on quit and on process exit.
- The main window is **sandboxed** with a deliberately tiny preload: a native
  folder picker and "reveal in Finder", nothing else. External links open in your
  real browser instead of navigating the app window.
- `app.setName("Asset Manager")` is set before any `getPath("userData")` call —
  otherwise config lands under `Application Support/stock-asset-management`.

### Credentials

There are no env vars in a packaged app, so the API key lives in a JSON file
written `0600` (readable only by your user account — written private from the
start, not chmod-ed afterwards):

```
~/Library/Application Support/Asset Manager/config.json    <- API key
~/Library/Application Support/Asset Manager/portfolio.db   <- your data
```

**The Anthropic API key is the only required setting.** There is nothing else to
configure: the database is a file the app creates itself.

Open **Asset Manager → Settings… (⌘,)** to edit it; first launch opens Settings
automatically when the key is missing, rather than letting you hit an opaque 500
from `/api/extract`. Settings also shows where `portfolio.db` lives, with a **Show
in Finder** button, since that file is the thing worth backing up.

The Next server reads the key through `process.env` exactly as it does on Vercel,
so no application code knows the desktop build exists — which also means **the app
must be restarted after changing the key**, since the running server captured the
old env at spawn time.

---

## Folder import (bulk PDFs — desktop only)

A browser cannot read a folder off your disk. Open **Folder Import**, pick a root
folder once (it's remembered in `localStorage`), and the app creates this inside it:

```
ContractNotes/            <- the folder you pick
├── inbox/                <- drop PDFs here, nested however you like
├── imported/
│   └── Zerodha/2025-26/CN-8842.pdf
└── failed/
    ├── CN-bad-scan.pdf
    └── CN-bad-scan.error.txt
```

Every `.pdf` under `inbox/` — at any depth — is extracted, saved, and then
**moved**: successes and duplicates to `imported/<broker>/<financial-year>/`,
failures to `failed/` with a sibling `.error.txt` naming the file, timestamp and
reason.

Behaviour worth knowing:

- **The destination comes from the extracted note, not the filename**, so
  `download (3).pdf` still files correctly.
- **Nothing is ever overwritten** — a name clash becomes `CN-8842 (2).pdf`.
  Moves fall back to copy+unlink across volumes (`EXDEV`).
- Path segments taken from the PDF are sanitised: filesystem-hostile characters
  replaced, whitespace collapsed, capped at 60 chars, and bare `.` / `..`
  rejected — the broker name comes out of a model, so it isn't trusted input.
- **Duplicates are free and safe** — reported as `already imported` and filed,
  never saved twice.
- **Each PDF is one Claude API call, billed to your key.** The pre-flight scan
  shows the count *before* anything runs, progress streams live as NDJSON, and
  there is a **Stop** button — a 200-note batch is several minutes and real money.
  Stopping aborts immediately rather than draining the queue.
- Runs **3 files concurrently**. Non-PDFs and dotfiles (macOS resource forks) are
  ignored. Results are sorted for a stable order.
- To retry a failure, fix the file and move it back into `inbox/`. The list
  rescans automatically when a run finishes.

---

## Deploying to Vercel

Standard Next.js app — Vercel auto-detects framework and build command.

1. Import `dhruvinmehta27/Assetmanagement_Sidd` at <https://vercel.com/new>.
2. Vercel deploys the repo's **default branch**, which is
   **`claude/stock-asset-management-setup-tkxo2j`, not `main`** — anything merged
   there ships to production. Branch off it rather than committing directly.
3. Settings → Environment Variables: add the four vars from the table above
   (Production, and Preview if you want preview deploys to work).
4. Deploy. Every push to that branch redeploys.

Notes:

- Vercel serverless functions cap the request payload at ~4.5 MB — well above a
  typical contract note PDF.
- `maxDuration` on `/api/import` must stay **≤ 300**: it is a Vercel-only knob
  that `next start` ignores entirely, but Vercel *validates it at build time* and
  the Hobby plan rejects anything larger. A value of 3600 failed every deploy on
  this branch until it was lowered.

---

## Security model

- **Keys never reach the browser.** Claude and the database are only ever called
  from route handlers. `app/lib/supabase.ts` and `app/lib/store/sqlite.ts` must
  never be imported into a client component.
- **On desktop, portfolio data never leaves the machine.** No hosted database, no
  service-role key to look after, no network storage — a `0600` SQLite file owned
  by your user account. The Portfolio page states where its data lives rather than
  leaving you to guess.
- **What does leave the machine, on both flavours: the PDFs.** Extraction sends
  each contract note to the Anthropic API. Local storage governs where extracted
  data rests, not how it is read.
- **RLS on, no public policies** (web). The anon key is useless against those
  tables; the service role key stays on the server in Vercel's encrypted env vars.
- **The import routes are gated.** `/api/import` and `/api/import/scan` take a
  filesystem path from the client and read and move files under it. That is safe
  on localhost, where the server and the user are the same person — but it would
  be an arbitrary-path hole on a hosted deploy. Both call `assertDesktop()` and
  403 unless `DESKTOP_APP=1`, which only the Electron main process sets.
  **Never make either route unconditional.**
- `.env.local`, `/dist`, `/samples/*.pdf` and `/uploads` are gitignored.

---

## Build flavours

`next.config.mjs` branches on `DESKTOP_BUILD`:

| | command | config applied |
|---|---|---|
| web | `next build` | none — identical to before the desktop work |
| desktop | `DESKTOP_BUILD=1 next build` | `output: "standalone"`, images unoptimized, sharp excluded from tracing |

The gate is deliberate: `output: "standalone"` is **not** inert on the web side —
it breaks `next start` — so applying it unconditionally would change how the app
is served outside Electron.

### Build notes

- **`electron/after-pack.js` copies `.next/standalone/node_modules` into the
  bundle.** This is not optional: electron-builder silently drops any
  `node_modules` from `extraResources`, and without the hook the app launches and
  immediately dies with `Cannot find module 'next'`. The hook throws if the source
  is missing or if `next` isn't present afterwards, rather than shipping a `.dmg`
  that cannot boot.
- **`sharp` is excluded** via `outputFileTracingExcludes`. The app renders no
  images, so the optimizer never runs; this saves ~19 MB and leaves the bundle
  with **no platform-specific binaries** — which is what makes a Windows build
  feasible. `images: { unoptimized: true }` alone does *not* stop the tracer.
- **`ensureStructure()` carries a `turbopackIgnore` hint.** It builds a path from
  a user-supplied root, which defeats static tracing and otherwise pulls the whole
  project into the server output — on the desktop build that swept `dist/` in, so
  each build packaged the previous build's `.dmg` and the size compounded
  (198 MB → 554 MB → 869 MB). With the hint, the standalone payload drops from
  737 MB to 20 MB and the `.dmg` returns to ~198 MB.
- The build is **unsigned** (`identity: null`). Fine locally; to share the `.dmg`
  you need an Apple Developer ID plus notarization, or Gatekeeper blocks it.
- The app uses the **default Electron icon** — drop an `icon.icns` in `build/` to
  replace it.

### Windows (not yet done)

The bundle is free of native binaries, so what remains is: add an NSIS target to
`build.win`, swap the `DESKTOP_BUILD=1` prefix for `cross-env` so the script runs
on `cmd`, and build on Windows (or a CI matrix) rather than cross-building from
macOS. `electron/after-pack.js` already resolves the non-macOS resources path.

---

## Project structure

```
app/
  page.tsx                      # upload UI: multi-file, batch table, note detail
  portfolio/page.tsx            # holdings, FY P&L, dividends + corporate-action forms
  accounts/page.tsx             # 🖥 people, PANs, broker-code mapping, unassigned queue
  import/page.tsx               # folder import UI (desktop); web notice otherwise
  layout.tsx  globals.css
  api/
    extract/route.ts            # PDF -> Claude -> structured JSON
    notes/route.ts              # persist note + trades
    portfolio/route.ts          # computed portfolio view, FIFO per account then merged
    accounts/route.ts           # 🖥 list / create accounts, list unassigned
    accounts/assign/route.ts    # 🖥 claim unassigned notes for an account
    dividends/route.ts          # list / add dividends
    corporate-actions/route.ts  # list / upsert splits & bonuses
    import/route.ts             # 🖥 batch import, NDJSON progress stream
    import/scan/route.ts        # 🖥 pre-flight count
  lib/
    schema.ts                   # ContractNote types + Claude tool JSON Schema
    extract.ts                  # Claude call, error taxonomy
    analytics.ts                # FIFO P&L, holdings, FY buckets
    folder.ts                   # 🖥 scan / move / file PDFs, desktop gate
    supabase.ts                 # server-only service-role client
    store/
      types.ts                  # the 7-operation persistence interface
      index.ts                  # driver selection (sqlite vs supabase)
      sqlite.ts                 # local file, node:sqlite, schema + writes
      supabase.ts               # hosted Postgres driver
electron/
  main.js                       # spawns Next, windows, menu, IPC
  main-preload.js               # tiny bridge: pickFolder, reveal
  config.js  settings.html  settings.js   # credential storage + Settings window
  after-pack.js                 # copies standalone node_modules into the bundle
supabase/schema.sql             # tables, views, fin_year(), RLS
next.config.mjs                 # web vs DESKTOP_BUILD branches
```

---

## Current status & roadmap

Done:

- [x] PDF → structured contract-note data, single and multi-file upload
- [x] Persistence of notes + trades with content-based de-duplication, on both
      a local SQLite file (desktop) and Supabase (web)
- [x] Portfolio: holdings, FIFO realized P&L, short/long term, FY buckets
- [x] Dividends and corporate actions (manual entry, applied to holdings)
- [x] Electron macOS desktop app with local credential storage and a fully local
      database — no cloud account needed to run it
- [x] Bulk folder import with live progress, stop, and automatic filing
- [x] Opus 5 default model with explicit refusal / truncation handling
- [x] Accounts: notes routed to a person by PAN or broker client code, unassigned
      notes held out of every figure, FIFO computed per account and merged

Open:

- [ ] **Extraction has never run against a real API key** — every test so far was
      a failure path, a no-key run, or a direct unit test. Start with 2–3 notes.
- [ ] Editing an account (rename, change PAN, merge two that turned out to be one)
      and un-assigning a group assigned by mistake
- [ ] Signed + notarized build (needs an Apple Developer ID); custom app icon
- [ ] Windows target
- [ ] Allocate note-level levies per trade for a finer cost basis
- [ ] Match extracted trades against the existing Excel data model
- [ ] More document types: holding statements, auto-fetched corporate actions
- [ ] Export / import of the local database (CSV or JSON), and a way to move an
      existing Supabase portfolio into a local one
- [ ] Automated tests
