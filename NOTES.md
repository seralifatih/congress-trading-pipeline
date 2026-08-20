## What's in this release

First tagged release of the Congress Trading Pipeline — two data pipelines that turn U.S. Congress stock trading disclosures into clean, structured JSON, pulled directly from official government sources. No third-party aggregators, no subscription, public domain data.

### Senate Trading Pipeline
Fetches Periodic Transaction Reports (PTRs) directly from the Senate's Electronic Financial Disclosures system (efdsearch.senate.gov). Every disclosed trade — buys and sells, tickers, dollar ranges, filer names — normalized into one row per transaction.

### House Trading Pipeline
Pulls the year-to-date disclosure archive straight from the Clerk of the House, downloads each filing's PDF, and parses it into the same clean schema. Handles the well-known "Pelosi trade" case: a single PTR filing becomes structured, queryable data instead of a PDF you have to read by hand.

### What you get back

One JSON row per transaction, for both pipelines:

- Politician name
- Transaction date and filing date
- Ticker (when the source provides one)
- Asset name and type (stock, option, bond, mutual fund, etc.)
- Buy or sell
- Disclosed dollar range (min/max)
- Account owner (self, joint, spouse, or child)

Every row carries a stable ID, so re-running a pipeline over an overlapping date window never produces duplicates.

### How current is the data

- **Senate:** the official disclosure system updates continuously; running the pipeline every 6 hours keeps the feed current with new filings.
- **House:** the Clerk of the House publishes a fresh disclosure archive daily, so a daily run keeps this feed within 24 hours of the official record.

### Where it comes from

Both pipelines read only from official U.S. government disclosure systems required under the STOCK Act of 2012 — no scraping of third-party aggregators like Quiver Quantitative or Capitol Trades.

### Also in this repo (not part of this release's core scope)

A third pipeline, **Congress Lobbying × Trades Overlap**, joins the House and Senate trade data with federal lobbying disclosures to surface potential conflicts of interest by member, quarter, and sector.
