# Keyword research log

Research sessions that use the **Keywordtool MCP** alongside the daily collector, to size
the market for DCP creation, accessibility, and copy & delivery software before a
go-to-market plan. The panel (`/fest-map/keypanel/`) is the shared picture; this file is
the running record of what each session asked, spent and concluded.

## Setup (once per machine)

The server is declared in the repo's `.mcp.json` (`https://mcp.keywordtool.io`). In an
interactive Claude Code session, run `/mcp`, pick `keywordtool` and sign in with the
Keywordtool Pro account in the browser. Then ask for the tool list and record the tool
names below.

MCP tools (recorded 2026-09-17):

| Tool | Costs | Use |
|---|---|---|
| `keywordtool-quota` | free | requests used/left, hourly and daily |
| `keywordtool-search-volume` | 1 request per call, up to 1,000 keywords | volume, 12-month trend, competition, top-of-page bid range |
| `keywordtool-suggestions` | 1 request per page | ideas from a seed: `type` = suggestions, questions, related, prepositions; `limit` up to 1,000 |
| `keywordtool-analyze-competitors` | 1 request per page | keywords a domain or URL ranks for (Google) |

What the MCP returns differs from the API the collector uses:

- **Its numbers include search partners.** `metrics_network: "googlesearch"` is ignored: the
  response still says "Google and search partners". Big terms come out about 25% higher
  than on the panel ("audiodescrição" 3,600 vs 2,900), so compare MCP numbers with each
  other, not with the panel.
- **Suggestions rows** look like `{string, volume, trend, cmp, top_of_page_bid_low, top_of_page_bid_high}`,
  and many rows have only `string`. The rows come with `total_count`, `pagination.next_page`
  and `summaries` (the set's total volume, a monthly trend by month name, and the device split).
  This is the MCP's shape and doesn't check `parseSuggestions` against the API.
- **The quota may be a separate pool:** the MCP showed 0 used at 14:13, 20 minutes after the collector
  spent 14 API requests. Check the API's `/v2/quota` after an MCP session before relying
  on the floor.

## Session protocol

1. **Check the quota first** through the MCP. The 50 requests are one rolling 24-hour
   pool shared by the web app, API, MCP and the daily collector (which never takes it
   below 30).
2. **Spend at most 5 requests a session day.** One volume request takes up to 1,000
   keywords, so batch: never ask about one keyword at a time.
3. **Start from the panel:** markets with festivals but no demand (or the reverse),
   Discovery candidates, services whose CPC looks commercial.
4. **Promote what's worth tracking into `seeds.json`,** not into this file, so the
   collector measures it the same way in every market. Batch promotions: a new
   `en`/`any` keyword re-measures ~35 markets (~2 days of collector budget).
5. **Log the session below**, newest first: the question, requests spent, findings with
   numbers, and what it means for the go-to-market plan.

## Log

### 2026-09-17 — Brazil: why accessibility (6,380/mo) dwarfs DCP (920/mo), and is ANCINE behind it?
- **Requests:** 3 (the MCP showed 47 of 50 left afterwards): suggestions for "audiodescrição" and for
  "closed caption" (Brazil, Portuguese), plus one volume batch of 112 terms (Brazil).
- **Findings:**
  - **The gap is two consumer terms.** Of 6,380, 5,300 is "audiodescrição" (2,900) and
    "closed caption(s)" (2,400). "Closed caption o que é" alone is 1,900 of 2,900; the
    rest is mostly "como tirar o closed caption da TV Samsung/LG" (260 + 140) and
    "closed caption Globo" (170). Around "audiodescrição": "o que é" 590, "como
    fazer" 210, courses 250, and over 800 searches for turning it off on the TV (Globo, Samsung, LG,
    TCL, Netflix). "Audiodescrição cinema" gets 10 a month. Its curve follows the school year: it drops in
    Dec–Feb and peaks in September (5,400 in Sep 2025).
  - **Without those two terms, Brazil's accessibility total is 1,080 vs 920 for DCP:** about level.
  - **Almost nobody searches the law or for a supplier.** "Estatuto da pessoa com deficiência" 14.8K,
    "lei brasileira de inclusão" 6.6K and "lei 13146" 5.4K are general. The ANCINE
    terms return no data ("in 128 ancine", "instrução normativa 165 ancine", "fsa
    acessibilidade"), and so do the Lei Paulo Gustavo and PNAB terms (10 or none).
    Buyer terms: "serviço(s) de audiodescrição" 20, "empresa de audiodescrição" 10 and
    "audiodescrição valor" 10. The few who search are contested, though: competition 0.62–0.84,
    bids up to $2.97.
  - **The compliance chain is active and growing:** "moviereading" (the app cinemas use for
    audio description, captions and Libras) 320, +243%; "janela de libras" went from 90 to 320 over 12 months;
    "janela de libras abnt" 70, +250% (producers looking up the spec); "acessibilidade
    no cinema" 70, +240%; "legendagem descritiva" 210.
  - **The law:** IN 165/2022 (replaced IN 128/2016, in force since Jan 2023) says distributors
    must give cinemas the film with subtitles, descriptive captions, Libras and audio
    description; cinemas mostly offer these through free phone apps. IN 116/2014 says
    ANCINE-funded productions must budget all three. ANCINE and MDHC published a
    good-practice guide and an FAQ on IN 165 in April 2026.
  - **Doesn't add up:** "legendas para surdos" is 210 and rising (30 → 390) on the panel, but
    10 in the MCP batch. Don't read the growth until the collector re-measures it.
- **GTM implication:** the law does make accessibility the strongest vector in Brazil, but
  as an obligation on **distributors and publicly funded producers**, not as search
  demand. People don't Google for this supplier, so SEO and ads will reach few buyers.
  Sell it outbound instead: distributors releasing Brazilian films, and producers with
  FSA/ANCINE money. Package it with DCP as an "accessible copy" that is ready for
  MovieReading/Mobiload, because IN 165 attaches the duty to the copy the distributor delivers.
  Brazil has 86 festivals on the map, 52 with an email. Open lead, not read yet: MPF is suing
  Anatel and ANCINE over streaming accessibility, which could extend the duty to VOD.
- **Seeds changed:** yes.
  - Flagged (shown, not counted): "closed caption", "closed captions", "audiodescrição".
    This moves every market: US accessibility 23,010 → 8,210, worldwide 77,760 → 41,060.
    Germany stays at 6,340, which is worth the same check for "audiodeskription".
  - Added (pt, access): "legendagem descritiva", "janela de libras abnt", "audiodescritor",
    "acessibilidade no cinema".
  - Added (pt, brands): "moviereading", "mobiload". Under pt, only Brazil, Portugal and
    worldwide re-measure: 3 collector requests.

<!--
### YYYY-MM-DD — question
- Requests: N (quota left after: N)
- Findings: …
- GTM implication: …
- Seeds changed: yes/no (which keywords)
-->
