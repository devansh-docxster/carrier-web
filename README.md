# Docxster Demo Mock Services

Local mock endpoints and datasets for the CW1 + spot + team + escalation workflow demo.

## Start the server

```sh
npm start
```

Server runs on `http://localhost:4010` by default.

## Endpoints

- `GET /api/cw1/json`
- `GET /api/cw1/sqlite`
- `GET /api/spot`
- `GET /api/team-rates`
- `GET /api/escalation-rates`
- `GET /api/scenarios`
- `GET /carrier/login` (demo carrier website)

All API endpoints accept query params:

- `origin` (ex: `LAX`)
- `destination` (ex: `SHA`)
- `mode` (ex: `OCEAN`)
- `equipmentType` (ex: `40HC`)
- `serviceLevel` (ex: `STANDARD`)
- `requestId` (team/escalation only)

Example:

```sh
curl "http://localhost:4010/api/cw1/json?origin=LAX&destination=SHA"
```

## CW1 data options

- JSON dataset: `data/cw1-rates.json`
- SQLite dataset: `data/cw1-rates.db`
- CSV for Docxster Tables import: `data/cw1-rates.csv`

If you want to rebuild the SQLite file manually:

```sh
sqlite3 /tmp/cw1-rates.db < data/cw1-rates.sql
cp -f /tmp/cw1-rates.db data/cw1-rates.db
```

## Docxster Tables import

1. Create a table named `cw1_rates` in the Docxster UI.
2. Import `data/cw1-rates.csv`.
3. Use the `Tables` piece (find records) with filters for origin/destination/etc.

## Browser-bot carrier website

Login page: `http://localhost:4010/carrier/login`

Credentials:
- username: `demo`
- password: `demo123`

Browser-bot selectors:
- Username input: `input[name="username"]`
- Password input: `input[name="password"]`
- Sign in button: `button[type="submit"]`
- Search inputs: `input[name="origin"]`, `input[name="destination"]`, `select[name="mode"]`, `input[name="equipmentType"]`
- Results table: `#rate-table`
- No rates message: `#no-rates`

## Demo scenarios (sample inputs)

See `data/scenarios.json`. Use these as form inputs:

- CW1 Success: `REQ-CW1-001` (LAX -> SHA)
- Spot Success: `REQ-SPOT-001` (DFW -> BOM)
- Team TAT Success: `REQ-TEAM-001` (ORD -> SGN)
- Escalation: `REQ-ESC-001` (MIA -> DXB)

TAT tips:
- For the Team TAT path, set `requestedAt` to now minus ~1 hour.
- For the Escalation path, set `requestedAt` to now minus ~6 hours.

## Flow pieces to use

- Trigger: `Forms` (form trigger) or `Webhook`
- CW1 check: `HTTP` (JSON/SQLite endpoint) or `Tables` (internal table)
- Sales review: `Approval` (wait for approval) or manual condition
- Markup: `Math Helper` (multiply)
- Spot rates: `Browser Bot` (carrier website) or `HTTP` (`/api/spot`)
- Team rates: `HTTP` (`/api/team-rates`) or `Forms` to capture
- Escalation rates: `HTTP` (`/api/escalation-rates`)
- Output: `Email`/`Slack`/`Teams`

## Flow build guide (single flow)

Pre-reqs:

1. Start the mock server (`npm start`).
2. Import CW1 data into Docxster Tables (`data/cw1-rates.csv`).
3. Ensure pieces are enabled in `AP_DEV_PIECES` (see repo `.env`).

### 1) Trigger (Forms)

Create a form with these fields:

- requestId (text)
- origin (text)
- destination (text)
- mode (dropdown: OCEAN, AIR)
- equipmentType (text)
- serviceLevel (dropdown: STANDARD, EXPRESS, SPOT)
- currency (text, default USD)
- maxTotalRate (number)
- markupPercent (number, ex 12)
- tatHours (number, ex 4)
- requestedAt (datetime)
- cw1Source (dropdown: tables, json, sqlite)
- spotSource (dropdown: browser, http)
- reviewDecision (dropdown: approve, reject) (optional for demo)

### 2) CW1 rates (choose source)

Add three conditional branches:

- If `cw1Source == "tables"`:
  - Use `Tables` -> Find records.
  - Table: `cw1_rates`
  - Filters: origin, destination, mode, equipmentType, serviceLevel.
- If `cw1Source == "json"`:
  - Use `HTTP` GET `http://localhost:4010/api/cw1/json`
  - Query params: origin, destination, mode, equipmentType, serviceLevel.
- If `cw1Source == "sqlite"`:
  - Use `HTTP` GET `http://localhost:4010/api/cw1/sqlite`
  - Query params: origin, destination, mode, equipmentType, serviceLevel.

### 3) CW1 rates available?

Condition (examples):

- Tables: `steps.cw1_tables.records.length > 0`
- JSON: `steps.cw1_json.body.rates.length > 0`
- SQLite: `steps.cw1_sqlite.body.rates.length > 0`

If YES -> go to CW1 review/markup/share.
If NO -> go to Spot Rates.

### 4) CW1 review (demo-friendly)

Option A: use Manual Task in the UI.

Option B (fast demo): use `reviewDecision` from the form to branch:

- If `reviewDecision == "approve"` -> apply markup
- Else -> continue to Spot Rates

### 5) Apply markup

Use Math Helper:

1. Division: `markupPercent / 100`
2. Addition: `1 + (result from step 1)`
3. Multiplication: `totalRate * (result from step 2)`

Pick a totalRate:

- From CW1: use the first rate in list for demo.

### 6) Share quote

Send via `Gmail`, `Outlook`, or `Slack`.

### 7) Spot Rates (browser-bot or HTTP)

If `spotSource == "browser"`:

Use Browser Bot -> Execute Action Sequence with steps:

```json
[
  { "actionType": "navigate", "value": "http://localhost:4010/carrier/login" },
  { "actionType": "type", "selector": "input[name=\"username\"]", "value": "demo" },
  { "actionType": "type", "selector": "input[name=\"password\"]", "value": "demo123" },
  { "actionType": "click", "selector": "button[type=\"submit\"]" },
  { "actionType": "wait", "selector": "input[name=\"origin\"]", "waitCondition": "visible" },
  { "actionType": "type", "selector": "input[name=\"origin\"]", "value": "{{trigger.origin}}" },
  { "actionType": "type", "selector": "input[name=\"destination\"]", "value": "{{trigger.destination}}" },
  { "actionType": "select", "selector": "select[name=\"mode\"]", "value": "{{trigger.mode}}" },
  { "actionType": "type", "selector": "input[name=\"equipmentType\"]", "value": "{{trigger.equipmentType}}" },
  { "actionType": "click", "selector": "button[type=\"submit\"]" },
  { "actionType": "wait", "selector": "#rate-table", "waitCondition": "visible" },
  { "actionType": "extract", "selector": "#rate-table tbody tr:first-child td:nth-child(5)", "extractType": "text" }
]
```

If `spotSource == "http"`:

- Use `HTTP` GET `http://localhost:4010/api/spot`
- Query params: origin, destination, mode, equipmentType.

### 8) Spot rates available?

Condition (examples):

- Browser: check extract step has a value.
- HTTP: `steps.spot_http.body.rates.length > 0`

If YES -> review/markup/share.
If NO -> go to Team workflow.

### 9) Team workflow + TAT

- Use `HTTP` GET `http://localhost:4010/api/team-rates?requestId={{trigger.requestId}}`
- Use `Date Helper` -> Date Difference:
  - Start date: `requestedAt`
  - End date: current time
  - Unit: hours
- Condition:
  - If difference <= `tatHours`, use team rates
  - Else -> Escalation

For demo, pick the first team option and apply markup.

### 10) Escalation

- Use `HTTP` GET `http://localhost:4010/api/escalation-rates?requestId={{trigger.requestId}}`
- Apply markup and share.

## Sample inputs

Use the scenarios in `data/scenarios.json`:

- CW1 Success: LAX -> SHA (cw1Source: tables/json/sqlite)
- Spot Success: DFW -> BOM (spotSource: browser or http)
- Team TAT Success: ORD -> SGN
- Escalation: MIA -> DXB

## Flow template JSON

Template file:

- `/Users/bigodev/Desktop/docxster-demo/flow-template-cw1-demo.json`

This file matches the `CreateFlowTemplateRequest` schema (type `PLATFORM`). You can import it via the platform Templates UI or by posting it to `/v1/flow-templates` with a platform API key.

## Flow import JSON (builder import)

Import file:

- `/Users/bigodev/Desktop/docxster-demo/flow-import-cw1-demo.json`

Use this in the **Import Flow** dialog in the builder (it includes the `name` + `template` fields the UI expects).
