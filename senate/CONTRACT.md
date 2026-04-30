# API Contract — Insider Signal Engine

Source of truth for the `api/` layer. Frontend must work without changes.
Derived from frontend audit (previous step) + concept doc + CLAUDE.md.

---

## 1. Base URL

Frontend uses **relative paths** — no `NEXT_PUBLIC_API_URL` env var.
Both `fetch()` calls in `layout.tsx` hit `/api/refresh` on the same origin.

The `api/` folder being built is **not** a separate service the frontend calls.
It is the **ingestion + pipeline backend** that:
- Runs as Next.js route handlers inside the same Next.js app
- Gets triggered by cron or the "Refresh Data" button in the sidebar

For local dev the Next.js dev server already resolves `/api/*` correctly.
No base URL config needed in the frontend.

**Env vars required in the Next.js app (`.env.local`):**

| Var | Purpose |
|---|---|
| `QUIVER_API_KEY` | Quiver Quant API — congress + insider trades |
| `FMP_API_KEY` | Financial Modeling Prep — earnings calendar |
| `CRON_SECRET` | Shared secret to protect `/api/cron` and `/api/sync-committees` |

---

## 2. Endpoints

### `GET /api/refresh`

Called on every page mount (dashboard layout `useEffect`).
Returns the timestamp of the most recently created signal.

**Query params:** none

**Response (200):**
```json
{
  "lastUpdated": "2026-04-29T14:23:00.000Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `lastUpdated` | `string \| null` | ISO timestamp. `null` if no signals exist yet. |

**Frontend reads:** `json.lastUpdated`

---

### `POST /api/refresh`

Called when user clicks "Refresh Data" button.
Triggers full ingestion pipeline, returns result summary.

**Request body:** none

**Response (200 — success):**
```json
{
  "ok": true,
  "signals": 12,
  "lastUpdated": "2026-04-29T14:23:00.000Z"
}
```

**Response (any non-2xx — failure):**
```json
{
  "ok": false,
  "error": "Pipeline failed: ..."
}
```

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success |
| `signals` | `number` | Count of new signals generated. Frontend displays as `+12 new signals`. |
| `lastUpdated` | `string` | ISO timestamp of most recent signal after pipeline run. |
| `error` | `string` | Present only on failure. Displayed verbatim to user. |

**Frontend reads:** `json.signals`, `json.lastUpdated`, `json.error`, `res.ok`, `res.statusText`

---

### `GET /api/cron`

Called by Cloudflare Worker scheduled trigger (or manually).
Identical pipeline run to `POST /api/refresh` — different auth mechanism.

**Auth:** `x-cron-secret` header **or** `?secret=<value>` query param, matched against `CRON_SECRET` env var.
Returns `401` if missing or wrong.

**Query params:**

| Name | Type | Required | Notes |
|---|---|---|---|
| `secret` | `string` | optional | Alternative to header auth |

**Response (200):**
```json
{
  "ok": true,
  "summary": {
    "ingested": 340,
    "newTrades": 45,
    "signalsGenerated": 12,
    "topScore": 85,
    "topScoreTicker": "NVDA",
    "runAt": "2026-04-29T14:23:00.000Z"
  }
}
```

**Response (401):**
```json
{ "error": "Unauthorized" }
```

**Response (500):**
```json
{ "ok": false, "error": "Pipeline failed: ..." }
```

`summary` shape = `PipelineSummary` from `src/types/index.ts`:

| Field | Type |
|---|---|
| `ingested` | `number` |
| `newTrades` | `number` |
| `signalsGenerated` | `number` |
| `topScore` | `number \| null` |
| `topScoreTicker` | `string \| null` |
| `runAt` | `string` (ISO timestamp) |

**Frontend reads:** not read by any client component — cron-only endpoint.

---

### `GET /api/sync-committees`

Syncs congressional committee membership from Congress.gov API into `committee_members` table.
Run once on setup, then weekly via cron.

**Auth:** same as `/api/cron` — `x-cron-secret` header or `?secret=` query param.

**Response (200):**
```json
{ "ok": true, "synced": 1842 }
```

**Response (401):**
```json
{ "error": "Unauthorized" }
```

**Response (500):**
```json
{ "ok": false, "error": "..." }
```

**Frontend reads:** not read by any client component — cron-only endpoint.

---

### `GET /api/debug`

Dev-only diagnostics endpoint. No auth. Returns pipeline health info.

**Response (200):**
```json
{
  "quiverKeySet": true,
  "rawCount": 340,
  "sourceCounts": { "congress": 200, "insiders": 140 },
  "fetchErrors": {},
  "filterResult": { "passed": 12, "rejected": 328, "clusters": 3 },
  "sampleTrades": {
    "congress": [ { "ticker": "...", "filer": "...", "trade_type": "...", "amount_low": 0, "amount_high": 0, "trade_date": "...", "filing_date": "..." } ],
    "insiders": []
  }
}
```

**Frontend reads:** not read by any client component — dev-only.

---

## 3. Field Name Mapping

The frontend's `Signal` interface (from `src/types/index.ts`) maps exactly to the `signals` DB table.
No serialization adapter needed between DB and frontend — field names are identical.

### `Signal` → DB column mapping

| Frontend field (`Signal`) | DB column (`signals`) | Notes |
|---|---|---|
| `id` | `id` | UUID |
| `raw_trade_id` | `raw_trade_id` | FK to `raw_trades` |
| `ticker` | `ticker` | |
| `company_name` | `company_name` | nullable |
| `filer_name` | `filer_name` | = `raw_trades.politician_or_insider` — **name differs** |
| `filer_type` | `filer_type` | `'congress' \| 'corporate_insider'` |
| `party` | `party` | `'D' \| 'R' \| 'I' \| null` |
| `trade_type` | `trade_type` | `'purchase' \| 'sale' \| 'exchange'` |
| `amount_low` | `amount_low` | nullable |
| `amount_high` | `amount_high` | nullable |
| `amount_midpoint` | `amount_midpoint` | `(low + high) / 2` — not in concept doc schema; added in implementation |
| `trade_date` | `trade_date` | ISO date string `YYYY-MM-DD` |
| `filing_date` | `filing_date` | ISO date string `YYYY-MM-DD` |
| `filing_delay_days` | `filing_delay_days` | integer |
| `score` | `score` | 0–100 |
| `score_breakdown` | `score_breakdown` | JSONB — see below |
| `filters_passed` | `filters_passed` | `TEXT[]` stored as JSON string in D1 |
| `cluster_id` | `cluster_id` | UUID or null |
| `committees` | `committees` | `TEXT[]` stored as JSON string in D1 |
| `is_active` | `is_active` | boolean (stored as `0/1` integer in D1) |
| `created_at` | `created_at` | ISO timestamp |

### `ScoreBreakdown` field mapping

Concept doc uses shorthand names in comments; frontend uses full names. DB stores as JSONB.
**Use the frontend field names as the canonical keys in the JSON:**

| Frontend key | Concept doc label | Max points |
|---|---|---|
| `size_score` | Size | 20 |
| `delay_score` | Filing delay | 15 |
| `cluster_score` | Cluster | 25 |
| `filer_track_record` | Filer track record | 20 |
| `relevance_score` | Relevance | 10 |
| `recency_score` | Recency | 10 |

### `FilerSummary` — computed, not a DB table

`FilerSummary` is built by `getFilerLeaderboard()` — aggregated from `signals` at query time.
Not a DB table. The API does not expose this directly; it's computed server-side and passed as a prop.

---

## 4. Error Format

Frontend only handles errors on `POST /api/refresh`. Pattern from `layout.tsx`:

```typescript
if (!res.ok) {
  setLastResult(`Error: ${json.error ?? res.statusText}`);
}
```

**Rule:** When response status is non-2xx, body **must** include `{ "error": "<message string>" }`.
If `error` field is absent, frontend falls back to `res.statusText`.

No structured error codes. Plain string message is sufficient.

For `GET /api/refresh` errors are silently swallowed (`.catch(() => {})`).
No error format requirements on GET.

---

## 5. Open Questions

### 5a. `amount_midpoint` not in concept doc schema

`signals` table in concept doc does **not** include `amount_midpoint`.
Frontend reads it in two places:
- `ticker/[symbol]/page.tsx`: `signal.amount_midpoint` used in total amount calculation
- `politicians-client.tsx`: `signal.amount_midpoint` used as fallback display value

**Resolution needed:** Add `amount_midpoint NUMERIC` column to `signals` table in migration.
Value = `(amount_low + amount_high) / 2`. Null if both inputs are null.

### 5b. `party` and `committees` not in concept doc `signals` schema

Concept doc `signals` table omits `party` and `committees` columns.
Frontend reads both fields on every `Signal` object.
They exist in `raw_trades` and must be **copied forward** into `signals` at insert time.

**Resolution needed:** Add `party TEXT` and `committees JSONB` to `signals` table migration.

### 5c. `filing_delay_days` not in concept doc `signals` schema

Concept doc omits this column (it can be derived from dates).
Frontend displays it directly on every signal card.

**Resolution needed:** Add `filing_delay_days INT` to `signals` table migration. Compute at insert: `filing_date - trade_date` in days.

### 5d. D1 vs Supabase

CLAUDE.md says **Supabase (Postgres)**. The actual frontend implementation uses **Cloudflare D1** (SQLite) via `@opennextjs/cloudflare`. `score_breakdown`, `filters_passed`, and `committees` are stored as JSON strings and parsed client-side, not as native JSONB/arrays.

The `api/` folder must decide which DB to target. If D1: JSON columns serialize as strings. If Supabase: native JSONB. The `rowToSignal()` mapper in `queries.ts` already handles D1's string serialization — replicate this pattern.

### 5e. `FilerSummary.chamber` always `null`

`getFilerLeaderboard()` always sets `chamber: null` — it queries `signals`, which (currently) has no `chamber` column. If chamber is needed in the leaderboard, it must either be added to `signals` or joined from `politicians`.

### 5f. Volume sparkline data shape

`getSignalVolumeLast30Days()` returns `Array<{ date: string; count: number }>`.
This is passed as a prop, not fetched via HTTP. No API endpoint needed — it's server-side data.
Confirmed: no HTTP call for this data.
