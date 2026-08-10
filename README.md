# Stock Asset Management — Contract Note Extractor

Web app that reads an **unstructured broker contract note PDF** and extracts it
into **structured trade data**. Built with Next.js; extraction is powered by the
Claude API. Supabase persistence is planned as the next milestone.

## What it does (v1)

1. Upload a contract note PDF in the browser.
2. A server-side API route sends the PDF to Claude, which returns structured JSON
   matching a fixed contract-note schema (`app/lib/schema.ts`).
3. The UI renders a summary, the individual trades, and the full charges breakdown
   (brokerage, STT, GST, stamp duty, exchange charges, etc.), plus the raw JSON.

## Setup

```bash
npm install
cp .env.example .env.local     # then edit .env.local and add your key
npm run dev                    # http://localhost:3000
```

### API key

- Get an Anthropic API key from https://console.anthropic.com (API Keys).
- Put it in `.env.local` as `ANTHROPIC_API_KEY=...`.
- `.env.local` is gitignored — **the key is never committed**. It is used only
  on the server (the API route), never exposed to the browser.
- **Do not paste your key into chat or commit it.** If you ever do, rotate it.

## Deploy to Vercel

This is a standard Next.js app, so Vercel auto-detects everything.

1. Go to https://vercel.com/new and **import** the GitHub repo
   `dhruvinmehta27/Assetmanagement_Sidd`.
2. Vercel uses the repo's **default branch** as the production deployment —
   currently `claude/stock-asset-management-setup-tkxo2j` — so nothing needs
   merging. (Framework: Next.js, Build: `next build` — both auto-detected.)
3. Under **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your Anthropic key (set it for Production, and
     Preview if you want preview deploys to work).
   - optional `ANTHROPIC_MODEL` to override the extraction model.
4. Deploy. Every push to the branch redeploys automatically.

> The API key is stored in Vercel's encrypted env vars and is only read
> server-side in the `/api/extract` route — it is never exposed to the browser.

## Desktop app (macOS)

The same Next.js server, hosted inside an Electron app instead of on Vercel. It
binds to `127.0.0.1` on a random free port and the window is a plain browser
view onto that origin — so `/api/extract` and the Supabase routes keep running
server-side, and the keys never reach the renderer.

```bash
npm run desktop:dev      # next dev + Electron window, hot reload
npm run desktop:build    # -> dist/Asset Manager-<version>-arm64.dmg
```

### Folder import (bulk PDFs)

Desktop only — a browser cannot read a folder off your disk. Open **Folder
Import**, pick a root folder once, and the app creates this inside it:

```
ContractNotes/            <- the folder you pick
├── inbox/                <- drop PDFs here, nested however you like
├── imported/
│   └── Zerodha/2025-26/CN-8842.pdf
└── failed/
    ├── CN-bad-scan.pdf
    └── CN-bad-scan.error.txt
```

Every `.pdf` under `inbox/` is extracted, saved, and then **moved**: successes to
`imported/<broker>/<financial-year>/`, failures to `failed/` with a sibling
`.error.txt`. The destination comes from the *extracted* note, not the filename,
so `download (3).pdf` still files correctly. Nothing is ever overwritten — a name
clash becomes `CN-8842 (2).pdf`.

Notes on behaviour:

- **Duplicates are free and safe.** De-duplication is content-based, on
  `(broker_name, contract_note_number, trade_date)` — the unique constraint in
  `supabase/schema.sql`. A note already in the DB is reported as
  `already imported` and filed, never saved twice. This means folder names carry
  no meaning for the app; organise `inbox/` however suits you.
- **Each PDF is one Claude API call**, billed to your key. The pre-flight scan
  shows the count before anything runs, and progress streams live with a Stop
  button — a 200-note batch is several minutes and real money.
- Runs 3 files concurrently, to stay clear of rate limits.
- Non-PDFs and dotfiles in `inbox/` are ignored.
- To retry a failure, fix the file and move it back into `inbox/`.

**Security:** `/api/import` and `/api/import/scan` take a filesystem path from the
client and read and move files under it. That is safe on localhost, where the
server and the user are the same person, but would be an arbitrary-path hole on a
hosted deploy — so both routes require `DESKTOP_APP=1`, which only the Electron
main process sets. On the web they return 403 and the page shows a notice instead.

### Credentials

There are no env vars in a packaged app, so the keys live in a JSON file written
`0600` (readable only by your user account):

```
~/Library/Application Support/Asset Manager/config.json
```

Open **Asset Manager → Settings… (⌘,)** to edit them. First launch opens Settings
automatically. The Next server reads these through `process.env` exactly as it
does on Vercel, so no application code knows the desktop build exists — which
also means **the app must be restarted after changing a key**.

### Two build flavours

`next.config.mjs` branches on `DESKTOP_BUILD`:

| | command | config applied |
|---|---|---|
| web | `next build` | none — identical to before the desktop work |
| desktop | `DESKTOP_BUILD=1 next build` | `output: "standalone"`, images unoptimized, sharp excluded |

The gate is deliberate. `output: "standalone"` is **not** inert on the web side —
it breaks `next start` — so applying it unconditionally would change how the app
is served outside Electron.

### Build notes

- `electron/after-pack.js` copies `.next/standalone/node_modules` into the bundle.
  This is not optional: electron-builder silently drops any `node_modules` from
  `extraResources`, and without the hook the app launches and immediately dies
  with `Cannot find module 'next'`.
- `sharp` is excluded via `outputFileTracingExcludes`. The app renders no images,
  so the optimizer never runs; this saves ~19 MB and leaves the bundle with **no
  platform-specific binaries** — which is what makes a Windows build feasible.
  Setting `images: { unoptimized: true }` alone does *not* stop the tracer.
- The build is **unsigned** (`identity: null`). Fine for running locally; to share
  the `.dmg` with anyone else you need a Developer ID plus notarization, otherwise
  Gatekeeper will block it on their machine.
- The app uses the default Electron icon — drop an `icon.icns` in `build/` to
  replace it.

### Windows (not yet done)

The bundle is now free of native binaries, so the remaining work is: add an NSIS
target to the `build.win` config, swap the `DESKTOP_BUILD=1` prefix for
`cross-env` so the script runs on `cmd`, and build on Windows (or a CI matrix)
rather than cross-building from macOS. `electron/after-pack.js` already resolves
the non-macOS resources path.

## Project structure

```
app/
  page.tsx            # upload UI + results rendering (client component)
  layout.tsx          # root layout
  globals.css         # styling
  api/extract/route.ts# server route: PDF -> Claude -> structured JSON
  lib/schema.ts       # ContractNote types + Claude tool JSON Schema
```

## Roadmap

- [x] v1: PDF → structured contract-note data in the browser
- [ ] Supabase: persist raw notes + normalized trades
- [ ] Match extracted trades against the existing Excel data model
- [ ] Support additional document types (holding statements, corporate actions)
```
