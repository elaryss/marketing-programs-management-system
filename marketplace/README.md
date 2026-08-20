# Marketing Operations Marketplace

Self-contained app implementing the Marketing Ops Marketplace spec.
Everything this app needs lives in this folder — no `../` references to the Overclock site.

## Files

| File | What it is |
|---|---|
| `index.html` | **Requester app.** Program dashboard → Phase 1 demand (per-address allocation, prices hidden) → Phase 2 confirm (prices visible, adjust/split/remove) → orders + chargeback invoices → address book. |
| `admin.html` | **Admin console.** Program setup, catalog item picker (min/max), phase control, reports w/ CSV export, post-close shipping + invoicing, member roles & cost centers. |
| `config.local.js` | Supabase URL + anon key. **Gitignored** — copy from `config.example.js`. |
| `config.example.js` | Template for the above. |
| `tokens.css` | Design tokens only — palette + type scale. Deliberately **not** the Overclock site's full `styles.css`: that file was written for a dark sign-in screen and its component classes (`.gate-logo`, `.gate-title`, `.gate-toggle`) collide with this app's light surfaces. Each page owns its own components. |

## Run it locally

```bash
python -m http.server 8124 --directory marketplace
```

Then open **http://localhost:8124/index.html** (requester) or **http://localhost:8124/admin.html** (admin).

Pure static + Supabase — no serverless functions needed yet, so any static server works.

## Backend

Same Supabase project as the Overclock app, in an isolated `mkt_` namespace:

- **Migrations:** `supabase/migrations/20260813000001_marketplace_schema.sql` (8 tables, 23 RLS policies, `v_mkt_items` catalog view over `toolkit_items`) and `..._2_marketplace_rpcs.sql` (state machine).
- **State machine RPCs** (SECURITY DEFINER, so rules can't be bypassed from the browser):
  - `mkt_advance_phase(program, phase)` — admin/owner-PM only; snapshots catalog prices onto demand lines when entering `confirm_open`.
  - `mkt_confirm_order(program)` — requester Phase 2 confirm; creates the order, locks lines.
  - `mkt_generate_invoice(order)` — admin; voids prior invoice, snapshots cost center, numbers `CB-YYYY-NNNNN`.

## Roles

Set in the admin console's **Members** tab. New users self-register as `requester`; an admin assigns role + cost center.

- `admin` — everything
- `program_manager` — programs they own
- `requester` — open programs + their own demand/orders/invoices

## Not built yet

Email automations/reminders (§7) and server-side PDF generation — the invoice is currently a print view. `mkt_communications` is ready for it.

The full build plan and logged deviations are tracked internally.
