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

MCP tools: _(fill in after the first sign-in)_

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

<!--
### YYYY-MM-DD — question
- Requests: N (quota left after: N)
- Findings: …
- GTM implication: …
- Seeds changed: yes/no (which keywords)
-->
