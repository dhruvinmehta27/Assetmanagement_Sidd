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
