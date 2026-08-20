# Handoff — 19 Aug 2026

Working state of the Asset Manager desktop app, for whoever picks this up next.
Architecture and usage live in [README.md](README.md); this file is what the
README cannot tell you — decisions, their reasons, what broke, and what is next.

**Scope: the desktop app only.** The Vercel/web path is kept working but is not
being developed. The `fix-vercel-build` branch is still unmerged, so production
deploys still fail at config validation. That is deliberate, not forgotten.

---

## Where things stand

The app runs, extracts real contract notes, and holds real data.

| | |
|---|---|
| Build | `dist/mac-arm64/Asset Manager.app` + `.dmg` (198 MB, unsigned, arm64) |
| Data | `~/Library/Application Support/Asset Manager/portfolio.db` (SQLite, `0600`) |
| Backups | `…/Asset Manager/backups/portfolio-2026-08-18.db` (27 notes, 131 trades, 1 account) and `portfolio-preassign-2026-08-18.db` (same, before assignment) |
| Real data loaded | 27 contract notes · 131 trades · 21 securities · ~₹26,24,426 invested · all FY 2024-25 |
| Account | One HUF account (name and PAN withheld — this repo is public) — all 27 notes assigned to it |
| Broker | A single broker, one client code. Its contract-note format is the only one tested against so far. |
| Source PDFs | A local folder under `~/Downloads`, filed into `imported/<broker>/<financial-year>/` |

**Extraction has now been proven against real PDFs** — this was the long-standing
open risk and it is closed. 131 trades with zero missing ISINs, security names,
quantities or values; 27 notes with zero missing contract-note numbers, dates or
net amounts.

**And every one of the 27 now reconciles against its own printed net amount**,
to the rupee. The two failures recorded in the previous handoff were not
extraction errors — see below.

---

## P&L, tax and dividends — built 20 Aug

**Table 2 of the spec is now built except the unrealised rows.** Realised gains
split into profit and loss, losses set off, the ₹1.25 lakh exemption applied,
tax and cess computed, and the cost of trading reported. `app/lib/tax.ts` is
pure arithmetic over what `pnlByFinancialYear` already produced.

It reproduces every figure in the spreadsheet's own worked example (₹5,00,000
LTCG, ₹1,00,000 STCG, ₹50,000 LTCL, ₹25,000 STCL → taxable ₹3,25,000 / ₹75,000,
tax ₹42,250 / ₹15,600) in both set-off modes. On the real data: 2024-25 shows
₹13,577.75 short-term profit and ₹65.33 short-term loss — the split netting had
been throwing away — and ₹2,810.58 of tax. Brokerage ₹2,665.70 and other
charges ₹3,483.70 cross-check exactly against the raw note columns.

**Rates are configuration, not constants.** `RATES_BY_YEAR` carries the
pre-23-July-2024 regime; a year absent from it uses the current one. Rates have
changed twice recently and one compiled into a formula is one nobody finds.

**The spec and the law disagree on loss set-off, so both are offered.** Table 2
computes `=A-C-E` and `=B-D`, netting within each bucket. Under s.74 a
short-term loss may also be set off against long-term gains. The page has a
toggle and states the difference in rupees when there is one — in a year with
short-term losses and long-term gains the spreadsheet overstates the tax due.

**Dividends now come from the exchange (Table 5).** The corporate-action lookup
was already downloading them and throwing them away. The missing half was the
quantity held on the ex-date, which is not a matter of adding up buys and sells —
so it runs the FIFO engine *as at* that date via a new `asOf` argument, and is
corporate-action adjusted by construction. On the real data it found **22
dividends worth ₹80,311.35 gross**, none of them recorded, and the proof it is
working is Motherson Sumi: 500 shares on 2025-06-23 and 750 on 2026-07-14,
because the bonus ex-date falls between them.

TDS is not published by the exchange, so the amounts are gross; Form 26AS
remains the authority for what was withheld.

**One bug worth remembering.** The `asOf` filter was written as
`const kept = asOf ? events.filter(...) : events`, which aliases the same array
when `asOf` is absent — `events.length = 0` then emptied the source and every
figure in the app came out zero. Caught immediately because the statement was
run against real data, where "0 lots closed" was obviously wrong.

---

## Reading demerger terms out of company filings — built 20 Aug

The exchange feed says a demerger happened and nothing more. The three numbers
the engine needs — target company, entitlement ratio, share of cost basis — are
only ever in the company's own filing, as prose in a PDF. `Find the terms` on a
discovered demerger now locates that filing among the company's announcements,
reads it with the same Claude extraction used for contract notes, and proposes
one action per resulting company.

Verified end to end on the real Vedanta demerger. It found the "Apportionment of
cost of acquisition" notice of 16 May 2026, read all five percentages exactly
(52.34% retained; 7.15 / 12.23 / 21.49 / 6.79%), the 1-for-1 entitlement and the
record date, and produced holdings matching the scheme to two decimals with the
cost basis preserved to the paisa. About 15 seconds and one Claude call.

**A four-way demerger broke two things that had to be fixed first.**

1. **The cost fractions compounded.** Each transfer took its share of what the
   previous one left, so the last company got 6.79% of 58% rather than of 100%.
   Demergers on the same security and date are now one event
   (`applyDemergerGroup`): the original cost is snapshotted once and every leg is
   paid out of it, with the parent keeping the unclaimed remainder.
2. **The unique key allowed one demerger per security per date.** It now includes
   `target_key` — `target_isin` or `''`, never null, since SQLite treats nulls as
   distinct and a unique index containing one deduplicates nothing.

**Matching a scheme's company names to listed ISINs is the hard part, and it is
a dropdown, not an answer.** Two of Vedanta's four resulting companies listed
under names the scheme never used: "Talwandi Sabo Power" trades as Vedanta Power,
"Malco Energy" as Vedanta Oil and Gas. On name alone the top matches were Adani
Power and GK Energy — confidently, and completely wrong. Two signals fixed it:

- the **parent's brand**, which a resulting company nearly always carries; and
- the **undertaking** the scheme names ("Oil and Gas Undertaking"), which is
  often what the company is actually listed as.

With both, all four resolve correctly as the top match. That is comfortable, not
safe — it is still a ranked guess, so the ISIN stays a dropdown and the accept
step exists.

---

## Exchange lookup for corporate actions — built 19 Aug

`/corporate-actions` can now ask NSE and BSE what they published for every ISIN
you have traded. **It found two real actions missing from the portfolio**, one of
which the colleague's spreadsheet uses as its worked example:

- **Motherson Sumi Wiring, Bonus 1:2, ex 18 Jul 2025.** 500 shares held since
  2024-10-17 → 750. Table 4 row D/E of the spec literally reads
  "Mothersonsumi … (500) 750", so the spreadsheet was written around this
  holding. Accepting it produced exactly 750, cost unchanged at ₹31,961.95,
  average cost diluted 63.92 → 42.62.
- **Vedanta, Demerger, ex 30 Apr 2026.** 600 shares held. Partial — the exchange
  announces that a demerger happened, not the target ISIN, the ratio or the cost
  split, so it drops into the manual form.

**This is the app's only outbound call besides the Claude API**, and it breaks
the local-only property on purpose: asking an exchange about an ISIN tells them
you are interested in it. So it runs on a button press, never on page load, and
the page says so where the button is.

**NSE is primary, BSE the fallback.** NSE carries the ISIN on every row and
answers a whole date range in one request (5,518 rows for 29 months); BSE needs a
scrip-code lookup and one request per holding. Either alone is sufficient — a
bonus is a fact about a company, not an exchange — and the BSE scrip master
covered 21/21 of the real ISINs when checked. Both were reachable cold, with no
session or cookie, on repeated tries.

**Nothing is applied automatically.** A parsed ratio is exactly the value that
corrupts a cost basis silently, so everything arrives as a candidate:
`exact` ones get an Accept button, `partial` ones prefill the manual form, and
the exchange's own words are shown verbatim beside the parse so it can be
second-guessed. Accepted rows carry `source = 'nse'` rather than `'manual'`.

**The parser was written against the real corpus**, not against what the formats
ought to be — 5,518 rows over 29 months, of which 479 are corporate actions on
equity and 257 parse completely. The awkward cases in that corpus are
load-bearing and there are tests for each: `Rs10/-` with no space,
`Rights 11: 50`, `Rights 10:121@ Premium`, `Re` versus `Rs`, and
`Scheme Of Arrangement - Bonus Ncrps 4:1` — a bonus of *preference* shares, which
must not read as an equity bonus (hence the anchored `^bonus`).

Two things the parser deliberately gets right and are easy to get wrong:

- **`Bonus a:b` is a new shares for every b held**, so b shares become b + a.
  "Bonus 1:2" on 500 gives 750, not 250. Verified against the spec's own example.
- **A split is published as a change of face value, and share count moves
  inversely.** The multiplier is always `faceBefore / faceAfter`, in both
  directions — branching the numbers as well as the label is what made a
  consolidation come out as a tenfold *increase*. Caught by a test, not by review.

Dividends come down the same feed with per-share amounts and are currently
discarded, since they belong in the dividends table. Wiring them up would close
the "no dividends, and no source for them" gap below at little cost.

---

## Corporate actions — Table 4, built 19 Aug

All ten types from the spec are implemented: split, reverse split, bonus,
demerger, merger, ticker/ISIN change, rights issue, buyback, delisting,
liquidation. Recorded on `/corporate-actions`, applied by the FIFO engine.

**Ten names, four mechanisms.** `app/lib/corporate-actions.ts` is the taxonomy
and the engine dispatches on the mechanism, not the name — otherwise
`analytics.ts` grows a branch per action:

| Mechanism | Types | What happens |
|---|---|---|
| RATIO | split, reverse split, bonus | quantity scales, total cost unchanged |
| TRANSFER | demerger, merger, ticker change | cost basis moves to another ISIN |
| ENTITLEMENT | rights issue | new shares bought at a price |
| EXIT | buyback, liquidation (and delisting, which deliberately does not exit) | position closes, realising gain |

**`computePortfolio` is now one global event loop, not a loop per security.**
It used to group trades by ISIN and run each group independently. Demergers and
mergers move cost basis *between* securities on a date, and the receiving
security's FIFO queue has to end up in acquisition order — which a per-ISIN loop
cannot express. Everything now merges into one date-ordered stream over a book of
positions. Verified against the real data first: holdings, invested and realized
came out byte-identical to the old engine before any action was added.

**One ratio convention, everywhere: `ratio_from` shares held become `ratio_to`.**
The notation in the wild is genuinely ambiguous — the spec writes a bonus as
"4:1 Bonus = 400 + 100 bonus" (four held, one received) while a split is normally
"1:5" (one becomes five). Two conventions, one colon, and getting it backwards
corrupts a cost basis permanently and invisibly. So the stored form is neither:
the form asks in the words that suit each type ("4 held become 5 — enter 4 and 5,
not 4 and 1"), `multiplierOf` is the only place that converts, and the validator
rejects a bonus or split that would shrink the holding.

**The preview is the safety feature.** Before saving, the form states in shares
and rupees what the action will do to the holding actually on file. After saving,
the table states what it did — quantity before and after, shares received, cost
moved. An action that matched no holding is called out loudly, because an action
that changes nothing still *looks* recorded and so nobody checks it again.

**Holding periods survive transfers.** Lots carry their original acquisition date
through a demerger and a merger, per s.2(42A) — resetting it would silently turn
long-term gains into short-term ones. Tested: a sale of a merged entity five days
after the merger reported buy dates from the original company's contract notes,
and the cost basis came across to the paisa.

**Departures from the spec, deliberate:**

- *Table 4 lists Broker and Client Code as filters.* A corporate action is a fact
  about a security, not about a broker — every holder gets it. Actions are stored
  once, globally by ISIN; the account filter narrows the *effects*.
- *Table 4 says "Reverse Stock Splits — Holding Price = 0".* That is not what a
  reverse split does; it consolidates shares and raises cost per share, total cost
  unchanged. Implemented correctly. The "= 0" note looks like it belongs to
  delisting or liquidation, both of which are handled.
- *Table 3 says a delisted holding is worth 0 but to keep the last price and
  notify on relisting.* So delisting flags the holding and realises nothing —
  nothing has been disposed of. Only liquidation closes the position.

**Verified end to end** against the real 27-note database: all ten types posted
through the API, every resulting quantity and cost checked by hand, four invalid
inputs correctly rejected. `total_invested` moved only by the rights subscription,
the buyback and the liquidation; every ratio and transfer preserved total cost
exactly.

**Still open here:** nothing cross-checks a ratio against reality. That is the
holding-statement diff, which remains the highest-value next step — it is the
only thing that can tell you an action is missing or entered wrongly.

---

## What changed on 19 Aug

**Trade value signs are normalised at save.** `app/lib/store/normalize.ts` is
applied by both drivers before a note is written: `side` carries direction and
every amount beside it is a magnitude; `net_amount` is derived from
`net_amount_direction` rather than trusted, so the two can never disagree. A
guarded backfill in `migrate()` brings existing rows onto the same convention —
it ran against the real database and moved 129 buy lines to magnitudes with the
totals byte-identical. Nothing downstream changed behaviour, because cost basis
already took the absolute value; the point is that it no longer has to.

**There is a Reconcile page** (`/reconcile`, `app/api/reconcile/route.ts`, logic
in `app/lib/reconcile.ts`). It checks each note against its own printed total
using only stored data — no Claude calls, no network, free to run. Unassigned
notes are included, unlike every other view: a note nobody has claimed still has
arithmetic worth checking.

**The two "failing" notes were a formula error, not bad extraction.** The old
check subtracted the charge total from the sum of `net_value`, but `net_value` is
quantity x *net* rate and net rate is already brokerage-inclusive — so brokerage
was counted twice, on every note. It only showed up on two because the other 25
absorbed it elsewhere. Reconciliation now uses gross:

```
gross traded value  −  charges  =  net amount
```

with three details that each break it if got wrong:

1. **Gross, not net** — see above. (Cost basis in `analytics.ts` is right to use
   `net_value`: brokerage *is* a deductible cost of acquisition. Only the
   reconciliation needs gross.)
2. **`gross_value` is usually absent** — the model returns it on a minority of
   lines, so quantity x `gross_rate` is the normal path, not a fallback.
3. **Rounding is inside a printed `total_charges` and outside a summed one.**
   Add it in exactly one of the two cases.

With that, 27/27 tie: 23 exactly, 4 within the sub-rupee rounding line.
Note `189193` (previously "sign bug") and `103783` (previously "a charge field is
misread, needs a human") both tie exactly. Neither needs a human.

The page was driven in the real app over CDP against the live data, and against a
deliberately corrupted copy to check the failure paths render: an inflated charge
total, a note with no net amount, and a trade line with no value at all are each
caught, named, and given the number the note implies they should have been.

---

## Decisions made, and why

These are settled. Reopen them only deliberately.

**Storage is local SQLite on desktop, Supabase on web.** The user could not use
Supabase from the desktop app for security reasons. Uses `node:sqlite`, built
into the runtime (Electron 43 ships Node 24). **Do not introduce
`better-sqlite3`** or any native module — it would put platform binaries back in
the bundle and undo the cheap Windows path.

**An account is a person or entity keyed by PAN, not a demat account.** All of
one person's brokers pool into one account. Chosen because it matches how a
return is filed. The accepted cost: holdings will not tie to any single broker's
statement, and **holdings/P&L cannot be filtered by broker** — a sale at one
broker can consume shares bought at another. This diverges from the colleague's
spreadsheet Table 3, which filters holdings by broker and therefore assumes
per-demat-account grouping. Revisit only if reconciling against one broker's
statement turns out to matter more than filing accuracy.

**Unassigned notes are saved but excluded from every figure.** A note nobody has
claimed must not silently join someone's holdings. Imports do not stop for them.

**Corporate actions are global (keyed by ISIN); dividends are per account.** A
split is a fact about a security; a dividend is received by a person.

**FIFO is computed per account and the results merged.** Never hand
`computePortfolio` two accounts' trades in one array.

---

## Bugs found and fixed this session

Each of these was found by running the real app against real data, not by review.

1. **All-accounts view re-blended accounts.** One person's sale consumed
   another's lots — ₹60,000 realized instead of ₹20,000, wrong cost basis left
   behind. Fixed: compute per account, merge outputs.
2. **Dividends saved with no owner.** The route dropped `account_id`, so the row
   saved and then vanished from every view. Fixed, and now refused without one.
3. **WAL sidecars were world-readable.** `-wal` holds recently written rows.
   Fixed by creating the file `0600` *before* opening it.
4. **Tracer regression risk.** Every `fs` call built from a runtime path needs
   `/*turbopackIgnore: true*/`. Without it the bundle sweeps the whole project —
   this took the `.dmg` from 198 MB to 869 MB once already.
5. **A missing API key consumed an entire batch.** Every file failed
   individually and was moved to `failed/`. The importer now checks the key
   before touching a single file.
6. **Saving a key did nothing until restart.** The server captured env at spawn.
   Settings now respawns the server and reloads the window.
7. **Assign table overflowed its card.** The global `white-space: nowrap` meant
   a long broker name pushed the Assign control off-screen behind a scrollbar.
8. **Empty-state dead end.** With no accounts, the queue showed a disabled
   dropdown and disabled button. Now shows an "Add an account ↓" button.
9. **PAN auto-claim was missing.** Creating an account with a PAN now claims
   every unassigned note carrying it, across all brokers.

And on 19 Aug, both caught by looking at the new page in the running app:

10. **The Reconcile table overflowed its card**, putting the Status column — the
    verdict, the only column guaranteed to matter — off the right edge behind a
    scrollbar. Same failure as #7 and the same cause: nine columns at the global
    12px cell padding. Tightened rather than dropping a column, since a page
    whose job is showing its working has to show every number it used.
11. **"unknown" wore the green badge**, reading as a pass. A note that could not
    be checked has passed nothing; it gets the neutral badge now.

---

## Open problems, evidenced

**Extraction is still not deterministic on sign** — that is a fact about the
model, not something the app can fix. What changed is that it no longer reaches
the database: signs are normalised at save and the stored rows are stable
whichever way a given pass read a bracket. If you ever add signed arithmetic,
add it downstream of `normalizeContractNote`, not around it.

**11 of 27 notes have no `total_charges`** though every component is present.
The model correctly returned null rather than inventing one, and reconciliation
sums the components instead — all 11 tie. Left as is: deriving and storing a
total would mean writing a number the note does not print.

**Every note carries a parser warning** about exchange ambiguity — description
says NSE, clearing header says BSE (`ICCLCM`), symbol is a BSE scrip code. These
look like genuinely dual-exchange notes. Harmless today because grouping is by
ISIN, but it blocks any per-exchange reporting.

**Two corporate actions are known to be missing and are waiting to be accepted**
in the live database: the Motherson Sumi bonus (which changes a holding from 500
to 750) and the Vedanta demerger (which needs its scheme document read for the
target ISIN and the cost split). Until they are accepted the portfolio understates
that holding. Everything else came back clean — 21 ISINs checked, nothing else
landed on a security held at the time.

**No dividends recorded, but there is now a source.** Contract notes do not
contain dividends (verified: zero of 27 mention the word), but the NSE feed the
corporate-actions lookup already pulls carries them with a per-share amount and
an ex-date — "Dividend - Re 0.58 Per Share". Combined with the quantity held on
that date, the gross is computable. `parseSubject` currently discards them by
design. AIS / Form 26AS remains the authority for TDS.

**Cannot edit anything.** No rename/delete/merge for accounts, no correction of a
mis-extracted note, no un-assign. A wrong value is currently permanent.

---

## Recommended next steps

Ordered by what makes the rest defensible, with the evidence for each.

1. ~~Normalise trade value signs at save.~~ **Done 19 Aug.**
2. ~~Reconciliation view.~~ **Done 19 Aug** — and it found the brokerage
   double-count rather than a data problem, which is the better outcome.
3. **Manual correction** of a note or trade, so what #2 flags can be fixed.
   Nothing in the current data needs it, which makes this less urgent than it
   looked yesterday — but it is still the only way to fix a wrong value, and #5
   will produce some.
4. **Account editing** — rename, fix PAN, delete.
5. **Holding-statement import** — diff the broker/CDSL statement against computed
   holdings. Now clearly the highest-value item, and more so than before the
   corporate actions went in: reconciliation proves each note was read correctly
   and says nothing about a note that was never imported; the corporate-actions
   page applies whatever ratio it is given and cannot tell you the ratio is
   wrong or the action is missing. A holding diff is the only thing that closes
   both gaps at once — it is the colleague's Table 3 "cross check with broker
   API" without needing an API.

**Deprioritised, with reasons:**

- **Intraday classification** — checked: zero same-day buy-and-sell pairs in the
  data. Not relevant yet. (Still a correctness trap when it appears: intraday is
  speculative business income, not capital gains, and would currently be
  reported as STCG.)
- **Tax computation** — only 2 sells all year (MTNL 500, Jio Financial 9), so it
  would compute almost nothing today. Needed before filing, not before trust.
- **Live prices / unrealised P&L** — the most useful feature (₹26.2 L across 21
  securities with no current value shown) but the only one needing an external
  dependency, which cuts against the local-only decision.

Two questions for the user are still open: whether the folder importer should
find PDFs sitting loose in the chosen folder instead of insisting on `inbox/`
(and if so, move or copy them), and how loss set-off should work — the
spreadsheet nets within buckets only, which is not what the law allows.

---

## Gotchas that will cost you an hour

**Backing up by copying `portfolio.db` alone silently produces an empty file.**
The data sits in the WAL. Quitting the app did *not* checkpoint it. Use
`VACUUM INTO` (as the backups above were made) or copy `.db`, `-wal` and `-shm`
together. The README previously gave the wrong advice.

**Testing `.next/standalone/server.js` straight from the repo serves no CSS or
JS.** `electron-builder` copies `.next/static` in at package time; running it by
hand does not. Symptom is an unstyled page stuck on "Loading…". Fix:
`cp -R .next/static .next/standalone/.next/static`.

**macOS blocks the agent's shell from `~/Downloads` and `~/Desktop`** regardless
of sandbox settings. Anything involving the user's PDFs has to be done by them
in Finder, or through the running app, which has its own permission.

**Code changes do not reach the user until `npm run desktop:build` is re-run** —
the app runs from `dist/`, not from source.

**The app is unsigned.** It opens locally because it was built locally; copied to
another Mac, Gatekeeper blocks it until signed and notarized.

**`net_value` is brokerage-inclusive; `gross_value` is not.** This is the single
easiest way to get a wrong answer out of this data, and it produced two phantom
"extraction failures" that survived into a handoff. Any arithmetic that also
subtracts charges must start from gross. Any arithmetic about cost basis should
start from net. `gross_value` itself is null on most lines — use quantity x
`gross_rate`.

**`next dev` blocks the Electron window's requests for `/_next/static`**, because
it treats `127.0.0.1` as a cross-origin dev host. The symptom is a page that
renders its shell and then sits on "Loading…" with 403s in the console. It is a
dev-server rule only, so a `next build` + `next start` shows the real behaviour;
the permanent fix would be `allowedDevOrigins: ["127.0.0.1"]` in
`next.config.mjs`, which is not there yet.

**Driving the app for screenshots:** launch with
`DESKTOP_DEV_URL=http://127.0.0.1:<port> ./node_modules/.bin/electron . --remote-debugging-port=9223`
and drive it over the DevTools protocol with Node's built-in `WebSocket`. There
is no Playwright or `chromium-cli` here, and the Chrome extension was not
connected.

---

## Reference documents

- **Spec gap analysis** (colleague's `Application & software.xlsx` vs the app):
  https://claude.ai/code/artifact/68d970f7-4ce0-4293-a5ac-a1404c95c5d9
- The spreadsheet itself: the colleague's spreadsheet (kept locally) —
  six tables; Table 1 is largely built, Tables 2–6 describe a much larger product.
