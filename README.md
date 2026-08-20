# Marketing Programs Management System

An end-to-end operations platform for planning, sourcing, and analyzing seasonal marketing
toolkits — the printed and premium items (case sleeves, neckers, shelf talkers, displays)
that a consumer-brand portfolio ships to retail each season.

It replaces a sprawl of Excel workbooks with a real database, a set of purpose-built web
apps for the teams that touch the data, an AI analyst that answers questions in natural
language, and a customer-facing storefront for the buy windows.

**Status:** capstone project. The app runs against a private Supabase instance;
this repository is the source, published as a portfolio reference.

---

## Why it exists

Toolkit planning ran on spreadsheets passed between brand marketers, sourcing teams, and
vendors. Every season the same problems repeated:

- **No single source of truth.** Quantities, quotes, and final order status lived in
  different files at different stages of the buy.
- **Lifecycle data was lost.** An item's journey — original ask → revised → requote →
  final — was overwritten rather than recorded, so nobody could explain variance after
  the fact.
- **Analysis was manual.** Questions like *"how much did we cancel last season, and
  which brands drove it?"* took hours of pivot-table work.

This system models the full item lifecycle in Postgres, so those questions become
queries — and then hands the queries to an AI agent so non-technical users can ask them
in plain English.

## What it does

| Surface | Who uses it | What it does |
|---|---|---|
| **Toolkit Manager** | Brand + sourcing teams | Browse and edit ~1,000 toolkit items with specs, vendor quotes, and order history. Filters, full-text search, per-user saved column views. |
| **Historical Analytics** | Leadership | Six dashboard reports — pre-buy funnel, cancellation deep-dive, spend over time, spend by brand, vendor patterns, item mix — with brand/season/category filters. |
| **Ask AI + Custom Reports** | Anyone | A Claude agent with read-only SQL access to the warehouse. Ask a question, get an answer inline; ask for something bigger and it queues a full HTML report that's built asynchronously and emailed out. |
| **Pre-Buy Dashboard** | Sourcing | Budget vs. committed spend across open buy windows, with MOQ-risk flagging. |
| **Storefront (`/shop`)** | Field/customer accounts | Browse items published to an open buy window, add to cart, pick a shipping address, place an order. Orders land in the same database the ops side reads. |
| **Admin** | Ops owner | CRUD for brands, programs, item types, vendors, countries, seasons; report-request review queue; usage/cost analytics for the AI features. |
| **Marketplace** (`/marketplace`) | Program requesters | Self-contained two-phase demand-collection app: gather per-address allocations with prices hidden, then reopen for confirmation with prices and chargeback invoicing. |

## Architecture

```
Browser (static HTML/CSS/vanilla JS)
   │
   ├──► Supabase (Postgres + Auth + RLS)      ← direct reads/writes via anon key
   │
   └──► Vercel Serverless Functions (Node 20 + Python)
            │
            ├──► Claude API (tool-use loop)
            └──► Supabase (service_role, server-only)
```

Deliberately no frontend framework. Each page is a self-contained HTML file with its own
components, sharing a token-based stylesheet — the build has no bundler, no install step,
and deploys as static assets plus functions.

**Data model** — 14+ core tables. The interesting one is `order_snapshots`: every item
gets a row per lifecycle stage (`original` / `revised` / `requote` / `final`), so variance
analysis is a join rather than an archaeology project. A `v_item_outcomes` view classifies
each item into a final outcome bucket (approved, cancelled, POD, inventory-fulfilled,
removed, in-flight) and is the source of truth every analytics view builds on.

**The AI layer** is a manual Claude tool-use loop, not a framework. The agent gets two
tools: `get_schema` (a hardcoded schema description, no DB hit) and `run_sql`, which calls
a `SECURITY DEFINER` Postgres function that rejects anything but a single SELECT, blocks
comment syntax, caps results at 500 rows, and times out at 5 seconds. The service-role key
never reaches the browser. Prompt caching on system + tools keeps per-turn cost down, and
every turn is persisted so follow-ups have context.

**Access control** — Supabase email+password on every internal page. Customer storefront
accounts are separate identities with strict `customer_id = auth.uid()` row-level security
(verified: customer A cannot read customer B's orders via the REST API).

## Tech stack

- **Frontend:** vanilla JS, no framework, no build step; Chart.js for visualizations,
  DOMPurify for agent-rendered HTML
- **Backend:** Vercel Serverless Functions (Node 20 CommonJS + Python)
- **Database:** Supabase Postgres — RLS, `SECURITY DEFINER` RPCs, versioned SQL migrations
- **AI:** Claude API via `@anthropic-ai/sdk` — tool use, extended thinking, prompt caching
- **Data pipeline:** Python + `openpyxl` importer that auto-detects column positions from
  source Excel headers, so each season's differently-shaped workbook loads without code
  changes; idempotent on re-run

## Repo layout

```
site/           Internal web apps (one HTML file per surface)
marketplace/    Self-contained demand-collection app
api/            Vercel serverless functions (chat, report build, MOQ recommend, cron)
  _lib/         Shared: schema description, tool definitions, Supabase client
prompts/        Agent system prompts — single source of truth, read at cold start
supabase/       Versioned SQL migrations
scripts/        Excel importer, diagnostics, build-time config generation

```

## Running locally

Requires Node 20+ and a Supabase project.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env` with your own Supabase and Claude credentials (see `.env.example` for the
variable names), then:

```bash
vercel dev
```

`vercel dev` serves the static site *and* the serverless functions together. A plain
static server will serve the pages but every `/api/*` call will fail.

Python scripts (the Excel importer, diagnostics) use `requirements.txt`:

```bash
pip install -r requirements.txt
```

## Notes on this repository

This is the public reference copy of a private working repo. The company identity,
brand names, and the Supabase project reference are replaced with placeholders
(`ABC`, `Brand P-A`…, `YOUR-PROJECT-REF`). The detailed internal development log,
source data files, and legacy pre-anonymization dashboards are not included.

One consequence worth flagging: the Excel importer in `scripts/` matches source
column headers by name, and those header strings were anonymized along with
everything else — so it looks for `abc note` rather than the real header text.

## Status

Capstone project, actively developed. All data referenced here is anonymized.

Secrets live in Vercel environment variables and Supabase config; `.env*` and
`*/config.local.js` are gitignored and never committed.

## License

Copyright (c) 2026 Elena Kritskaya. All rights reserved. Published as a
portfolio work sample — readable for evaluation, not licensed for reuse.
See [LICENSE](LICENSE).
