# Domain Glossary — Marketing Programs Management System

**Read by:** every AI agent that interprets natural-language questions against the toolkit database — currently the chat agent (`api/chat.js`) and the report builder (`api/admin/report-build.js`). Both load this file alongside their behavior prompt and concatenate it into the system prompt.

**Authority:** This file is canonical for **data interpretation** — what a user's word means, which column to read, which stage to use, when to ask. On any conflict between a behavior prompt and this glossary, **the glossary wins for data meaning**; the behavior prompt wins for persona, tone, output format, and conduct rules. If the schema returned by `get_schema()` ever disagrees with this glossary, the live schema wins (and this file needs an update).

**For humans:** This doubles as the team-facing wiki for "what does that word mean in our data?" Same content the AI reads. If you're adding a new column, status value, or vocabulary term to the live system, also add it here.

---

## 1. Section index

1. Section index
2. The single biggest disambiguation: tiers vs item categories
3. Brand & tier vocabulary
4. Item category, item type, element zone
5. Time vocabulary — fiscal year, buy season (buy_wave), focus period, shipping wave
6. The lifecycle — which "spend" you're being asked about
7. Spend & money vocabulary (every $ term, with the column to read)
8. Quantity vocabulary — UOM, packout, eaches, MOQ
9. Pricing & uplift formulas
10. Status vocabularies (pre-buy, snapshot, final outcome)
11. Vendor & sourcing vocabulary
12. Field reference — business name → schema column (lookup table)
13. Natural-language phrasebook (common phrasings → SQL shape)
14. Terms that ARE genuinely ambiguous (when to ask, not guess)
15. Anti-patterns — known misreads to never make again
16. How to add to this glossary

---

## 2. The single biggest disambiguation: tiers vs item categories

Two of the most common words a ABC user types have **different meanings depending on which axis they're on**, and the words collide. Get this right or every report is wrong.

| Word user types | What they almost always mean | Wrong reading to avoid |
|---|---|---|
| **"premium brands"** / "premium tier" / "Premium" (capitalized in a brand context) / "BOLD" | **Brand tier `PRM`** — i.e. `brand_category = 'PRM'` (also exposed as `brands.category`, `v_item_outcomes.brand_category`, `toolkit_wide.brand_category`). | Do NOT read this as `item_category = 'premium'` (which is the *element-type* axis — promo/swag-style items like bottle carriers, gift boxes, openers). |
| **"luxury brands"** / "luxury tier" / "Luxury" / "LUX" | **Brand tier `LUX`** — `brand_category = 'LUX'`. | Do NOT read this as a missing item category (there is no item category called "luxury"). |
| **"premium items"** / "premium SKUs" / "premium elements" | **Item category `premium`** — `item_category = 'premium'` on `toolkit_items` / `toolkit_wide` / `v_item_outcomes`. The promo/swag tier of physical elements (bottle carriers, openers, glassware, gift boxes). | Don't read this as brand tier. |
| **"paper items"** / "print items" | `item_category = 'paper'`. | — |
| **"display items"** / "displays" | `item_category = 'display'`. | — |
| **"premium brands' premium items"** | `brand_category = 'PRM' AND item_category = 'premium'` — both filters, both axes. | — |

### Decision rule when the word "premium" appears alone

1. **If the surrounding language mentions other brand-tier terms** ("premium vs luxury", "premium tier", "premium brands", "BOLD", "by tier") → it's the **brand tier** (`brand_category = 'PRM'`).
2. **If the surrounding language mentions other item-category terms** ("premium vs paper", "premium vs display", "premium items", "item mix", "category mix") → it's the **item category** (`item_category = 'premium'`).
3. **If neither lens is hinted** → it's the **brand tier**. This is the more common business question (spend-by-tier is a standing dashboard view; item-category mix is more niche). State your reading in one sentence: *"Reading premium as the brand tier (PRM); say the word if you meant premium-category items."*
4. **If the user explicitly says they meant the other one** — don't argue, switch and re-run.

### "BOLD"

"BOLD" is the internal nickname for the **premium brand tier** — used in dashboard labels and decks. When a user types "BOLD" they mean `brand_category = 'PRM'`. (Origin: the BOLD-Coupon-Report dashboard family.)

---

## 3. Brand & tier vocabulary

### Brand tier (the buy split)

- **`brand_category` / `brands.category`** is the **only** field to use for the buy split. Two values: `PRM` (Premium) and `LUX` (Luxury). Some legacy text uses `PRE` interchangeably with `PRM` — treat them as the same value; the live data uses `PRM`.
- Pre-aggregated views (`v_spend_by_brand_season`) already carry `brand_category` per row — don't re-join.
- **`brands.price_tier`** is a *marketing* tier label (`Entry` / `Mid` / `Premium` / `Luxury`). It is NOT the buy split and should NOT be used for tier questions unless the user explicitly says "marketing tier" or "price tier".

### Brand names — demo vs real

- This deployment runs on **demo data**: brands are anonymized as **`Brand P-A`, `Brand P-B`, … `Brand P-N`** (premium tier, 19 brands) and **`Brand L-A`, `Brand L-B`, …** (luxury tier, 7 brands). The "P-" prefix maps to `PRM` and "L-" maps to `LUX` — but **trust `brand_category`, not the name prefix**, because some real brand names also exist in the table (Brand P-I, Brand P-A, Brand P-J, Brand P-C, Brand P-B, Brand P-E).
- When the user names a brand directly, match `brands.name` case-insensitively and surface what you found.

### "Family"

In ABC-internal language, "family" usually means **brand tier** (PRM family vs LUX family). Treat "family" as a synonym for `brand_category` unless context makes clear they mean something else.

---

## 4. Item category, item type, element zone

These three are related but distinct.

| Axis | Values | Where it lives | When user says… |
|---|---|---|---|
| **`item_category`** (3-value enum) | `paper` · `display` · `premium` | `toolkit_items.category`, `toolkit_wide.item_category`, `v_item_outcomes.item_category` | "paper items", "displays", "premium items", "item mix" |
| **`item_type`** (controlled vocabulary, ~30 values) | Necker, Case Sleeve, Shelf Talker, Floor Display, Bottle Carrier, etc. | `item_types.name`, exposed as `toolkit_wide.item_type` and `v_item_outcomes.item_type` | "neckers", "shelf talkers", "case sleeves", "floor displays" |
| **`element_zone`** | "Display - DSP", "Print - PRT", "Premium - PRE" | `item_types.element_zone`, `toolkit_wide.element_zone` | Rarely user-facing; mostly internal grouping. Same axis as item_category just labeled differently. |

**Mapping note:** `element_zone` and `item_category` are essentially the same axis with different labels (`Display - DSP` ↔ `display`, `Print - PRT` ↔ `paper`, `Premium - PRE` ↔ `premium`). Prefer `item_category` for filters; `element_zone` is mostly cosmetic.

---

## 5. Time vocabulary — fiscal year, buy season (buy_wave), focus period, shipping wave

Four time-ish concepts, three of them not interchangeable.

### Fiscal year (`fiscal_year`)

- **ABC fiscal year**, parsed from `toolkit_items.pre_buy_program` and exposed as `v_item_outcomes.fiscal_year`. Values: `F25`, `F26`, `F27`, `Unknown`.
- "This year" / "last year" / "current year" — **do not assume a calendar mapping**. ABC's fiscal year doesn't align with the calendar year. If the user says "this year" without a fiscal label, ask which fiscal year they mean, or default to the year with the most active data and state the assumption.
- **F25 budget data is present but partial.** Earlier deployments had no F25 revised-snapshot data; the current demo dataset backfills it (332 of 336 F25 items carry a revised budget). Variance for F25 is calculable but the original tracking was retrofitted, so include a one-line caveat (*"F25 revised budgets are backfilled in this dataset — treat the variance as directional"*) on any F25 budget-vs-final cut. Do **not** override this caveat just because the rows look populated.

### Buy wave (`buy_wave`) — say "Buy Season" to the user

- **User-facing name: "Buy Season."** The column is called `buy_wave` in the schema, but in every narrative, table heading, callout, and chip facing a user, call it **Buy Season**. Reserve "buy_wave" for SQL and footnotes the user is auditing.
- The seasonal pre-buy window inside a fiscal year. Three values plus `Unknown`:
  - **`HL` — Holiday.** Covers Nov/Dec, Jan/Feb, and the combined Nov/Feb in-market windows.
  - **`SM` — Summer.** Covers Jul/Aug, Sep/Oct, and the combined Jul/Oct in-market windows.
  - **`SP` — Spring.** Covers Mar/Apr, May/Jun, and the combined Mar/Jun in-market windows.
- Parsed from `toolkit_items.pre_buy_program` (e.g. "F26 HL Buy" → `fiscal_year=F26, buy_wave=HL`). Exposed as `v_item_outcomes.buy_wave`.
- **Eight valid seasons on record:** F25 HL/SM/SP, F26 HL/SM/SP, F27 HL/SM. F27 SP not yet in data.
- User shorthand: "Holiday" / "Holidays" / "Christmas" / "Nov-Dec" / "Jan-Feb" → `HL`. "Summer" / "Jul-Aug" / "Sep-Oct" → `SM`. "Spring" / "Mar-Apr" / "May-Jun" → `SP`.

### Focus period (`focus_period`)

- The in-market window of the *element* (when it's physically present in stores). Free-text: "Jan", "Nov-Dec", "Flow", "Mar-Apr", etc. Lives on `programs.focus_period` and `toolkit_wide.focus_period`.
- Different from `buy_wave` (which is *when the buy happens*). An element can be bought in the SM buy and have a Sep focus period.
- "When was X in-market?" → `focus_period`. "When was X bought?" → `buy_wave`.

### Shipping wave (`shipping_wave`)

- Sub-window inside a Buy Season for when the physical element ships to accounts. Free-text: `"Wave 1"`, `"Wave 2"`. Lives on `programs.shipping_wave` and per-item override on `toolkit_items.shipping_wave`.
- **In `toolkit_wide`** the program-level shipping wave is exposed as `program_shipping_wave` (different name from the base column — easy to miss).
- Distinct from `buy_wave` (Buy Season) even when the strings look similar.

### "Over time"

When a user says "over time" or "trend" or "by year", they almost always mean **by `fiscal_year`** as the time axis. Confirm if a sub-window matters; otherwise group by fiscal_year.

---

## 6. The lifecycle — which "spend" you're being asked about

Same element, same dollars, **four different stage views**. A "spend" number is meaningless without a stage. The data flows left → right:

1. **Sourcing / specs.** Element is defined, specs drafted, quotes collected. No committed spend yet. Lives on `toolkit_items` + `paper_specs` + `quote_batches` + `vendor_quotes`.
2. **Pre-Buy Window Setup → "Estimated Budget".** Planned spend at the site's display MOQ, computed as `portal_price × site_moq`. Lives on `toolkit_items.estimated_budget_spend`. Site-displayed; **NOT a lifecycle column.**
3. **Original order → `order_snapshots` where `snapshot_type='original'`.** What sales *actually ordered* when the window first opened. NOTE: the `budget_spend` column is **NOT populated on the original snapshot** — `original.budget_spend` is null; only `ordered_qty` is set. The dollar number for "original order" is `ordered_qty × production_price` (or `portal_price`, depending on which lens you want).
4. **Revised → `order_snapshots` where `snapshot_type='revised'`.** Adjusted quantities after the review pass. **This is the canonical "budget" number** for lifecycle questions. `revised.budget_spend` is populated. Also exposed pre-joined as `v_item_outcomes.budget_spend`.
5. **Requote → `order_snapshots` where `snapshot_type='requote'`.** Re-priced quantities for items flagged for re-quoting. `requote.production_price` is the canonical new unit price. Exposed as `v_item_outcomes.unit_price_requote`.
6. **Final → `order_snapshots` where `snapshot_type='final'`.** The committed, produced number. **This is the canonical "actual spend"**. `final.final_production_spend` is the dollar number. Also exposed as `v_item_outcomes.final_production_spend`.

### Stage → column cheat sheet

| When user says… | Read this column | Stage |
|---|---|---|
| "planned spend" / "estimated spend" / "budget at MOQ" / "site budget" | `toolkit_items.estimated_budget_spend` (or `toolkit_wide.estimated_budget_spend`) | site-displayed, not lifecycle |
| "budget" / "budgeted spend" / "revised budget" / "what we expected to spend" | `v_item_outcomes.budget_spend` | revised |
| "actual spend" / "final spend" / "ABC Final Spend" / "production spend" / "what we ended up spending" / "what got committed" | `v_item_outcomes.final_production_spend` | final |
| **"spend" (unqualified)** | **`v_item_outcomes.final_production_spend` — i.e. ABC Final Spend.** Don't ask. Briefly name the lens in the narrative. See rule below. | final |
| "variance" | `v_spend_by_brand_season.variance_abs` (= actual − budget) | final vs revised |
| "what we spent on inventory" | `v_item_outcomes.final_inventory_spend` | final, inventory portion only |
| "sales spend" / "sales budget" | `v_item_outcomes.final_sales_budget_spend` | final, sales-priced |

### Default for unqualified "spend"

**Default = ABC Final Spend (`final_production_spend`).** Across all fiscal years, all brands, all categories, and all Buy Seasons, when a user says "spend" without a qualifier, read `v_item_outcomes.final_production_spend` — the committed production number. Don't ask which stage they mean; just name the lens in one short sentence so they can correct you if needed.

Sample lens-naming sentences:

- *"Reading ABC Final Spend (committed production $) — say the word if you meant revised budget instead."*
- *"Numbers below are ABC Final Spend — the committed amount on each item's final snapshot."*

Variants:

- **F25 trend lines:** F25 has no revised-budget data, only ABC Final Spend. That's already the default — no caveat needed unless the user explicitly asks for budget or variance in F25, in which case state "F25 closed before budget tracking, so only ABC Final Spend is available for that year."
- **Multi-year / "over time":** keep ABC Final Spend as the default axis across all years; it's the only one populated in every year.
- **Variance / budget questions explicitly:** when the user asks about "budget", "variance", "what we planned to spend", or "over/under budget", switch to `budget_spend` (revised) for the budget side and keep `final_production_spend` for the actual side. State both lenses.

### "Don't sum across stages"

The four snapshots are **different views of the same money**, not additive layers. Never `SUM` across `snapshot_type` values. Always filter to one stage.

---

## 7. Spend & money vocabulary

Every dollar term and its column. Use the business name in the narrative; cite the column name when the user might want to audit.

| Business name | Column (canonical) | Stage | Notes |
|---|---|---|---|
| Estimated Budget / Site Budget | `toolkit_items.estimated_budget_spend` | pre-buy site setup | `portal_price × site_moq` — *what the requester-facing site shows*. Not a lifecycle column. |
| Portal Price per UOM | `toolkit_items.portal_price` | pre-buy site setup | `production_price × 1.0675` (overridable). Sale price the ordering portal shows. |
| Production Price per UOM | `vendor_quotes.production_price` (per quote tier) and `order_snapshots.production_price` (per snapshot) | vendor quote / per stage | The vendor's per-UOM production cost, before shipping/tariff. |
| Total Unit Price | `vendor_quotes.total_unit_price` | vendor quote | Generated column = `production_price + shipping_cost + tariff`. **Use this for any "cheapest" question** — it's the apples-to-apples landed unit price. |
| Original Order Budget | `order_snapshots.ordered_qty × portal_price` (compute) | original | Original snapshot's `budget_spend` is null; compute from quantity × price. |
| Revised Budget Spend / Budget | `order_snapshots.budget_spend` where `snapshot_type='revised'`, or `v_item_outcomes.budget_spend` | revised | Canonical planning number for F26/F27. |
| **ABC Final Spend** / Final Production Spend / Actual | `order_snapshots.final_production_spend` where `snapshot_type='final'`, or `v_item_outcomes.final_production_spend` | final | **Canonical actual number AND the default for unqualified "spend".** Lead with "ABC Final Spend" in narratives. |
| Final Sales Budget Spend / Sales Spend | `order_snapshots.sales_budget_spend` or `v_item_outcomes.final_sales_budget_spend` | final | Final qty × final sales price (incl. uplift). |
| Inventory Spend | `order_snapshots.inventory_spend` / `v_item_outcomes.final_inventory_spend` | final | Spend on inventory-fulfilled portion (lead time = INV). |
| Investment in MOQ | `order_snapshots.investment_in_moq` | per snapshot | Cost of buying enough to meet the minimum, when actual demand was below MOQ. |
| Variance (absolute) | `v_spend_by_brand_season.variance_abs` | derived | `actual_spend − budget_spend`. Positive = over budget. |

### Currency formatting

- Whole dollars: `$1,234,567` (no decimals).
- Per-unit prices: `$0.42` to 2 decimals, `$0.4275` to 4 decimals when sub-cent precision matters (vendor quote comparisons).
- Right-align numeric columns in HTML tables.
- In KPI tiles, abbreviate large numbers: `$1.87M`, `$148K`. Keep full precision in supporting tables.

### Tariffs

Tariffs are tracked **separately** from base production cost.

- **`vendor_quotes.tariff`** — per-UOM tariff on a quote tier.
- **`vendor_quotes.total_unit_price`** — includes tariff (it's `production + shipping + tariff`).
- When a user asks about "landed cost" or "true cost", include tariff. When they ask about "base production cost" or "vendor price before tariff", exclude tariff (use `production_price` only).

---

## 8. Quantity vocabulary — UOM, packout, eaches, MOQ

### UOM (`uom`)

- **Unit of Measure**. Free-text but constrained: `EA` (each), `PK` (pack), `CT` (case/carton), `BG` (bag), `BL` (bundle), `CS` (case), `PD` (pad), `RL` (roll), `ST` (set), `SH` (sheet), `SK` (stack), `SL` (sleeve).
- Quantities are reported **in UOM**, not always in eaches. Always check `uom` before interpreting a quantity number.

### Packout (`pack_out_qty`)

- How many **eaches per UOM** a unit contains. E.g. `uom='CT', pack_out_qty=24` means each case holds 24 eaches.
- Lives on `toolkit_items.pack_out_qty` and exposed as `toolkit_wide.pack_out_qty`.

### Eaches

- `Eaches = qty_in_UOM × pack_out_qty`. Compute when the user asks for total individual units.
- Quote-level eaches are pre-computed: `vendor_quotes.qty_eaches`.

### MOQ — minimum order quantity

- **`vendor_quotes.moq`** — minimum order quantity *for that quote tier*, in UOM.
- **`toolkit_items.site_moq`** — minimum displayed on the requester-facing site (often = the selected quote's MOQ, but can be overridden).
- **MOQ in eaches** = `moq × pack_out_qty`.
- **MOQ ranges** like "100/200/500" in older free-text mean the item was quoted at multiple tiers and not locked yet. Don't `CAST` the string to a number — read the structured tier data on `vendor_quotes` instead (one row per tier).

### "+/- MOQ" (`plus_minus_moq`)

- `ordered_qty − moq` at a given snapshot. Negative = ordered below minimum, which is the trigger for `at risk` / `requote` / `cancel` outcomes.
- Lives on `order_snapshots.plus_minus_moq` and `v_item_outcomes.final_plus_minus_moq`.

---

## 9. Pricing & uplift formulas

These are the formulas ABC uses; bake them into the analysis when the data has the inputs.

- **Eaches** = `qty (UOM) × pack_out_qty`
- **Portal Price per UOM** = `selected_production_price × 1.0675` *(6.75% uplift). Stored in `toolkit_items.portal_price` and overridable — if the stored value differs from the formula, trust the stored value and note the discrepancy in the narrative.*
- **Estimated Budget Spend** = `portal_price × site_moq`
- **Original Order Budget** = `portal_price × ordered_qty_original` (where `snapshot_type='original'`)
- **Final Sale Price** = `final_production_price × 1.0675`
- **Variance** = `final_production_spend − budget_spend` (positive = over budget)
- **Total Unit Price (apples-to-apples)** = `production_price + shipping_cost + tariff`. Already stored as `vendor_quotes.total_unit_price` — don't recompute.

---

## 10. Status vocabularies (pre-buy, snapshot, final outcome)

Statuses are messy free-text in places. Normalize when summarizing; surface the raw value when precision matters.

### `pre_buy_status` — "is this on the buy?"

| Value | Meaning |
|---|---|
| `include` | On the buy. The default and most common. |
| `removed` | Dropped before the buy window opened. Maps to outcome `removed_prebuy`. |
| `POD` | Print-on-demand from the start (ordered as needed, no pre-buy). Maps to outcome `pod_prebuy`. |
| `Post on ABC Merch` | Posted on the ABC merchandise channel rather than pre-bought. Maps to outcome `abc_merch_prebuy`. |

### `order_snapshots.status` — per-stage free-text status

Common strings — case and punctuation vary; normalize with `LOWER(...)` and `LIKE` patterns.

- `ok` — quantity supports the buy.
- `at risk` — under MOQ or otherwise in question.
- `requote` — needs re-pricing at actual quantity.
- `cancel` / `propose to cancel` — being dropped.
- `pre-approved`, `not on Pre-Buy`, `POD only`, `use inventory`, `Inventory` — special handling cases.
- `#N/A` — formula couldn't resolve. **Treat as "no order data yet" — do NOT count as a real status.**

### `final_outcome` — the canonical "what happened to this item" enum (on `v_item_outcomes`)

12 values plus `unknown`. **This is the source of truth — prefer it over re-parsing `status` strings.**

The `Value` column is the SQL enum string; the **User-facing label** is what you say in narratives, callouts, table headers, and KPI tiles. Same rule as `buy_wave` → "Buy Season": **never** expose the raw enum string to a regular user.

| Value | User-facing label | Meaning |
|---|---|---|
| `approved` | Approved | Final snapshot status starts with "Approved". |
| `inventory_fulfilled` | Fulfilled from inventory | Final status "Inventory" — fulfilled from existing stock, no production. |
| `cancel_cancelled` | Cancelled | Final status starts with "Cancel" — true cancel. |
| `cancel_pod` | Cancelled — swapped to POD | Cancelled and swapped to print-on-demand. |
| `removed_prebuy` | Removed before buy window | `pre_buy_status='removed'` — dropped before buy window. |
| `pod_prebuy` | POD from the start | `pre_buy_status='POD'` — POD from the start. |
| `abc_merch_prebuy` | Posted to ABC Merch | `pre_buy_status='Post on ABC Merch'`. |
| `part_of_kit` | Part of a kit | Final status starts with "Part of a Kit". |
| `requoting` | Requoting | Final status starts with "Requot". |
| `in_flight_requoting` | Requote in flight | No final snapshot yet; has a requote row in motion. |
| `no_outcome` | No outcome recorded | No final + nothing else to classify on. Investigate. |
| `unknown` | Unknown | Catch-all. |

### Don't leak enum strings into user-facing text

Raw values like `cancel_cancelled`, `cancel_pod`, `inventory_fulfilled`, `pod_prebuy`, `abc_merch_prebuy`, `final_production_spend`, `budget_spend`, `pre_buy_status`, etc. belong in **SQL only**. They must **not** appear *anywhere* a regular user can see them:

- not in narrative prose or the report intro
- not in KPI tile labels or table headers
- not in callouts, data notes, or methodology footnotes
- not in "Cancellation definition" / "How this is calculated" sections at the bottom of a report
- not in chat replies

The only places schema strings are allowed: inside the `report_queries` audit array (which the report builder submits for admin review, not user display) and inside the SQL of `run_sql` calls. Everywhere else, use the business name.

This rule is absolute — **do not** produce a "for clarity, here is the underlying column" parenthetical even if it feels helpful. The reader is a brand / sales / ops user, not a developer; the enum string adds noise, not precision. If a definition genuinely needs to distinguish two outcomes, use the user-facing labels from the §10 table.

Wrong: *"Cancellation counts include both true cancels (`cancel_cancelled`) and POD swaps (`cancel_pod`), consistent with the standard definition."*
Wrong: *"Cancellation rate = (true cancels + POD swaps) ÷ total items. 'True cancel' = `final_outcome = 'cancel_cancelled'`; 'POD swap' = `final_outcome = 'cancel_pod'`."*
Right: *"Cancellation counts include both true cancels and POD swaps — items that came off the pre-buy regardless of route."*
Right (methodology footnote): *"Cancellation rate = (true cancels + POD swaps) ÷ total items. A true cancel was dropped outright; a POD swap was pulled from the pre-buy and re-routed to print-on-demand."*

### Status framings

- **"Cancellation rate"** = `(items where final_outcome IN ('cancel_cancelled','cancel_pod')) / total_items`. Both true cancels and POD swaps count as cancellations because the item came off the pre-buy. If the user wants to exclude POD swaps, they'll say so. *(In user-facing text, say "true cancels and POD swaps" — never the enum values.)*
- **"At-risk items"** = items whose latest snapshot status indicates `at risk` or `requote`. Not the same as cancelled.
- **"How's the buy looking?"** → break down by `final_outcome`. `approved` = locked, `requoting` / `in_flight_requoting` = pending, `cancel_*` / `removed_*` = dropped.

---

## 11. Vendor & sourcing vocabulary

### Vendors (`vendors` table)

- 11 real vendors in data: IMS, ABC, MSG, POD, etc. Names live in `vendors.name`.
- **`vendors.sourcing_responsibility`**: `ABC` / `IMS` / `JMS` / `Third Party` — who handles the sourcing relationship.

### IMS

- **IMS** is a third-party sourcing & buying partner. Appears in the data as both a vendor name and a column prefix ("IMS Job#"). 
- **IMS is NOT a reader of these reports.** The source Excel is shared with IMS, so some vendor comparison data is deliberately kept elsewhere. Don't claim full vendor visibility you don't have.

### Quote tiers (`vendor_quotes`)

- One row per **MOQ tier within a quote**. `tier_number` (1, 2, 3) sorts them low → high.
- `tier_label` is the human label ("MOQ 1", "MOQ 2", "MOQ 3").
- **For "cheapest vendor" questions**: use `total_unit_price` (the generated column on `vendor_quotes`). Compare apples-to-apples across vendors at the same tier.

### Selected vs candidate quotes

- **`toolkit_items.selected_quote_id`** → the chosen vendor quote for this item.
- **`toolkit_wide.selected_vendor` / `selected_total_unit_price` / etc.** → pre-joined fields for the selected quote.
- For "cheapest" / "best price" questions across **all candidate quotes**, query `quote_batches` + `vendor_quotes` directly. `toolkit_wide` only shows the *selected* one.

### Lead time codes

- `LLT` — long lead time
- `SLT` — short lead time
- `INV` — inventory (fulfilled in full or part from existing stock; no new production)
- `TBD` — not yet decided

---

## 12. Field reference — business name → schema column

Compact lookup table. Always confirm via `get_schema()` before writing SQL; this is a quick mental map, not a contract.

| Business name | Schema location | Notes |
|---|---|---|
| POS# / POS number | `toolkit_items.pos_number` | Master key per element. De-dupe on this for counts. |
| Brand | `brands.name`, exposed as `*.brand_name` | |
| Brand tier / family | `brands.category`, exposed as `*.brand_category` | `PRM` / `LUX` only. |
| Marketing price tier | `brands.price_tier` | `Entry` / `Mid` / `Premium` / `Luxury`. Different from brand tier. |
| Program | `programs.name`, exposed as `*.program_name` | |
| Program status | `programs.status` | 8-value enum. |
| Pre-buy program | `toolkit_items.pre_buy_program` | "F26 HL Buy" style. Source of `fiscal_year` + `buy_wave`. |
| Fiscal year | `v_item_outcomes.fiscal_year` | `F25` / `F26` / `F27` / `Unknown`. |
| Buy Season (column `buy_wave`) | `v_item_outcomes.buy_wave` | `HL` / `SM` / `SP` / `Unknown`. Say "Buy Season" to the user; reserve "buy_wave" for SQL/footnotes. |
| Focus period | `programs.focus_period`, `toolkit_wide.focus_period` | In-market window of the element. |
| Shipping wave | `programs.shipping_wave` (exposed as `toolkit_wide.program_shipping_wave`) or `toolkit_items.shipping_wave` (per-item override) | Watch the name change in `toolkit_wide`. |
| Item category | `toolkit_items.category`, exposed as `*.item_category` | `paper` / `display` / `premium`. |
| Item type | `item_types.name`, exposed as `*.item_type` | ~30 values. |
| Element zone | `item_types.element_zone`, `toolkit_wide.element_zone` | "Display - DSP" / "Print - PRT" / "Premium - PRE". |
| Standard or Custom | `toolkit_items.standard_or_custom` | `Standard` / `Custom`. |
| UOM | `toolkit_items.uom` | EA / PK / CT / BG / etc. |
| Packout | `toolkit_items.pack_out_qty` | Eaches per UOM. |
| MOQ (tier) | `vendor_quotes.moq` | In UOM. |
| Site MOQ | `toolkit_items.site_moq` | What the requester-facing site displays. |
| Lead time | `toolkit_items.lead_time` | `LLT` / `SLT` / `INV` / `TBD`. |
| Sourcing responsibility | `vendors.sourcing_responsibility` | `ABC` / `IMS` / `JMS` / `Third Party`. |
| Production price (per UOM) | `vendor_quotes.production_price` or `order_snapshots.production_price` | Vendor base cost. |
| Shipping cost (per UOM) | `vendor_quotes.shipping_cost` | |
| Tariff (per UOM) | `vendor_quotes.tariff` | |
| Total unit price | `vendor_quotes.total_unit_price` | GENERATED = production + shipping + tariff. Use for cheapest. |
| Portal price (per UOM) | `toolkit_items.portal_price` | production × 1.0675, overridable. |
| Estimated budget spend | `toolkit_items.estimated_budget_spend` | portal × site_moq. Site-displayed, not lifecycle. |
| Original order quantity | `order_snapshots.ordered_qty` where `snapshot_type='original'`, exposed as `v_item_outcomes.ordered_qty_original` | |
| Revised budget spend | `order_snapshots.budget_spend` where `snapshot_type='revised'`, exposed as `v_item_outcomes.budget_spend` | Canonical "budget" for F26/F27. |
| Requote unit price | `v_item_outcomes.unit_price_requote` | |
| Final production qty | `v_item_outcomes.final_production_qty` | |
| Final production spend | `v_item_outcomes.final_production_spend` | Canonical "actual spend". |
| Final inventory qty | `v_item_outcomes.final_inventory_qty` | |
| Final inventory spend | `v_item_outcomes.final_inventory_spend` | |
| Final sales budget spend | `v_item_outcomes.final_sales_budget_spend` | |
| +/- MOQ (final) | `v_item_outcomes.final_plus_minus_moq` | Ordered minus MOQ. Negative = under min. |
| Pre-buy status | `toolkit_items.pre_buy_status` | `include` / `removed` / `POD` / `Post on ABC Merch`. |
| Final outcome (canonical) | `v_item_outcomes.final_outcome` | 12 + unknown. Source of truth. |
| Final status (raw) | `v_item_outcomes.final_status_raw` | Verbatim string from the final snapshot. |
| Variance ($) | `v_spend_by_brand_season.variance_abs` | actual − budget. |

---

## 13. Natural-language phrasebook (common phrasings → SQL shape)

When a user types one of these phrasings, this is the SQL shape that usually answers it. Adapt to filters in scope, but start here.

### "How did spend on premium vs luxury brands change over time?"

```sql
SELECT
  fiscal_year,
  brand_category,
  SUM(final_production_spend) AS actual_spend,
  SUM(budget_spend)            AS budget_spend,
  COUNT(*)                     AS item_count
FROM v_item_outcomes
WHERE brand_category IN ('PRM','LUX')
  AND fiscal_year IN ('F25','F26','F27')
GROUP BY fiscal_year, brand_category
ORDER BY fiscal_year, brand_category;
```

Notes: lead with actual; flag F25 has null budget. Show a 2-line KPI strip per year (PRM vs LUX) or a YoY % delta per tier.

### "Top brands by spend in F26"

```sql
SELECT brand_name, brand_category, actual_spend, budget_spend, variance_abs
FROM v_spend_by_brand_season
WHERE fiscal_year = 'F26'
ORDER BY actual_spend DESC
LIMIT 20;
```

### "Cancellation rate by brand"

```sql
SELECT dimension_value AS brand,
       fiscal_year,
       total_items,
       cancelled_items,
       ROUND(100.0 * cancelled_items / NULLIF(total_items,0), 1) AS cancel_rate_pct
FROM v_cancellation_by_dimension
WHERE dimension_type = 'brand'
ORDER BY cancel_rate_pct DESC;
```

### "Which vendor is cheapest for matte neckers at tier 1?"

```sql
SELECT v.name AS vendor,
       AVG(vq.total_unit_price) AS avg_tier1_price,
       COUNT(*) AS quote_count
FROM vendor_quotes vq
JOIN quote_batches qb ON qb.id = vq.quote_batch_id
JOIN vendors v ON v.id = qb.vendor_id
JOIN toolkit_items ti ON ti.id = qb.toolkit_item_id
JOIN item_types it ON it.id = ti.item_type_id
JOIN paper_specs ps ON ps.toolkit_item_id = ti.id
WHERE it.name = 'Necker'
  AND ps.coating ILIKE '%matte%'
  AND vq.tier_number = 1
GROUP BY v.name
ORDER BY avg_tier1_price ASC;
```

Note: `toolkit_wide` only shows the *selected* quote — you need base tables for cross-vendor comparison.

### "How's the F27 HL buy looking?"

```sql
SELECT pre_buy_status, final_outcome, item_count, final_spend, budget_spend
FROM v_prebuy_funnel
WHERE fiscal_year = 'F27' AND buy_wave = 'HL'
ORDER BY item_count DESC;
```

### "Item mix by category" / "category mix"

```sql
SELECT item_category, COUNT(*) AS items, SUM(final_production_spend) AS spend
FROM v_item_outcomes
WHERE fiscal_year = 'F26'
GROUP BY item_category
ORDER BY spend DESC;
```

Note: this is the case where "premium" means **item_category**, not brand tier. Surrounding language ("by category", "item mix") triggers the item-axis reading.

### "Variance for [brand] in [year]"

```sql
SELECT brand_name, fiscal_year, budget_spend, actual_spend, variance_abs,
       ROUND(100.0 * variance_abs / NULLIF(budget_spend,0), 1) AS variance_pct
FROM v_spend_by_brand_season
WHERE brand_name ILIKE '<brand>' AND fiscal_year = '<year>';
```

F25 will return null variance (no budget data).

---

## 14. Terms that ARE genuinely ambiguous (when to ask, not guess)

The behavior prompts say "ask at most 2–3 clarifying questions, and only if needed." These are the cases where asking is warranted.

| Term | Why ambiguous | What to ask (or default to) |
|---|---|---|
| ~~"spend" (unqualified)~~ | Was ambiguous; **no longer.** Firm default = **ABC Final Spend** (`final_production_spend`). Don't ask. Just name the lens. | See §6 "Default for unqualified 'spend'". |
| "this year" / "last year" / "current year" | ABC fiscal years don't align with calendar. F25/F26/F27 are all "current-ish". | Ask which fiscal year, unless the data clearly points to one. |
| "premium" with no other lens-words | Brand tier vs item category collision. | Default to **brand tier (PRM)**. State the reading. |
| "the buy" (when scope spans multiple windows) | Could mean F27 HL specifically or all active windows. | Ask which buy, or default to the most recent and state it. |
| "at risk" | Multiple snapshot statuses contain similar wording. | Use the literal `status ILIKE '%at risk%'` filter on the latest snapshot; explain the rule in narrative. |
| "cost" | Production vs landed (with tariff) vs portal/sales price. | Default to total_unit_price (landed); ask if comparing vendor base prices. |
| Brand name where multiple match | "Brand P-A" exists in demo, but real brands also exist. | Match case-insensitively; if multiple match, list them and ask. |
| Empty result | The filter combo returned zero rows. | State explicitly; suggest a likely cause ("Brand P-I wasn't on the F25 HL buy") rather than silently saying "no data". |

---

## 15. Anti-patterns — known misreads to never make again

Each entry is a real interpretation bug. Don't repeat them.

### A1. "Premium brands" → item_category = 'premium'

- **Symptom:** User asked "how did spend on premium vs luxury brands change over time?" Agent responded "our item categories are paper, display, and premium — we don't have luxury."
- **Why wrong:** The user meant brand tier (`brand_category = 'PRM' / 'LUX'`). The agent matched the word "premium" to the wrong axis (item category) and then declared "luxury" missing.
- **Right reading:** When "premium" appears next to "luxury", "tier", "BOLD", "brands", or "family" → it's **brand tier**. See §2 decision rule.
- **Right query shape:** See §13 "premium vs luxury over time" template.

### A2. Summing across snapshot stages

- **Symptom:** SQL adds `original.budget_spend + revised.budget_spend + final.final_production_spend` to "total spend".
- **Why wrong:** The four snapshots are different views of the same money, not additive layers.
- **Right reading:** Always filter to one `snapshot_type`. Use `v_item_outcomes` to get the canonical per-item budget vs actual without writing the filter yourself.

### A3. Using `brands.price_tier` for the buy split

- **Symptom:** Filter is `WHERE brands.price_tier = 'Premium'`.
- **Why wrong:** `price_tier` is a *marketing* label; the buy split uses `brands.category` (PRM/LUX).
- **Right reading:** `WHERE brand_category = 'PRM'`. The schema hint says this explicitly.

### A4. Variance computed without reading Final Status

- **Symptom:** "F26 PRM ran $518K over budget" or "F27 came in $617K under budget" — headline numbers built by summing `final_production_spend − budget_spend` across every item in scope, treating items with `final_production_spend = 0` (or no `final` snapshot) as 100% underspend and items with `budget_spend = 0` as 100% overspend. The Final Status column is never consulted; items the team explicitly cancelled or fulfilled from inventory get folded into the variance signal.
- **Why wrong:** Whether a dollar gap is real variance, a killed plan, an inventory swap, or a not-yet-shipped item depends on **Final Status**, which the Excel source records for every item that's reached a terminal lifecycle position. Lumping all `final_production_spend = 0` items into "underspend" silently merges five very different things: Approved-and-cheap, Cancel, Removed from Buy, POD, Inventory, and (for open years only) genuine in-flight items.
- **Where Final Status lives in this database:** `order_snapshots.status` where `snapshot_type='final'`. After the 2026-06-03 importer fix, **every closed-buy item has a final snapshot row with the Final Status text** (F25 = 100%, F26 = 100%; F27 has ~25% legitimately status-less because the buy is still open). Values seen in the data: `Approved` (727), `Requoting` (109), `Cancel` (94 + 5 lowercase), `Removed from Buy` (53), `POD` (27), `Inventory` (20), `Cancel - POD` (4), `Part of a Kit` (3), `Merch Site` (2). Always read this column for variance — not the revised-stage status, not a snapshot walk-back, not `v_item_outcomes.final_outcome`.
- **Right reading:** For any budget-vs-final variance cut, join each item to its Final Status, then bucket before summing:

  | Final Status | Treatment in variance |
  |---|---|
  | `Approved` | **Comparable basis.** Variance = final − budget. **Headline this number.** Only apples-to-apples figure. |
  | `Cancel` / `cancel` / `Cancel - POD` / `Removed from Buy` | **Killed plan.** Exclude from variance (variance = $0). Optionally report killed budget as a sidebar ("$X of plan was cancelled before production"); never as negative variance. |
  | `Inventory` | **Real underspend.** Use `final_production_spend` ($0) — no new production cost because existing inventory covered demand. Surface as a labeled line ("$X saved by drawing from inventory instead of new production"). See A8. |
  | `POD` (print-on-demand outcome) | **Excluded from pre-buy variance.** These items will be printed on-demand later; they were never part of the pre-buy commitment. |
  | `Requoting` | **In-flight (open year only).** Item is mid-quote. Report as "requoting, not yet committed". For closed-year items with `Requoting` status, treat as a data-quality flag (the buy is closed; an unresolved requote is a tracking gap). |
  | `Part of a Kit` / `Merch Site` | **Excluded from variance.** These are special handling cases; surface their counts but don't compute variance. |
  | `NULL` (no final snapshot row) | Should only happen for open-buy items (F27/F28 today) that haven't reached any terminal disposition yet. Report as "no decision yet, still in active buy". If it appears for F25/F26 → genuine data gap; flag it. |

  In the prose, **lead with the Approved (comparable basis) variance** — the only apples-to-apples number — then list the other buckets as separate lines. Worked example for **F26 PRM** (verified against the 2026-06-03 fixed import):

  > *"On a comparable basis (166 Approved items with both a revised budget and a final production spend), F26 PRM is **+$285K over (+31%)** — $912K planned, $1,197K actual. Separately: 36 items were cancelled ($61K of plan killed, excluded from variance); 18 items were removed from the buy (no budget impact); 15 items were routed to POD (excluded from pre-buy); 8 items were fulfilled from inventory ($15K of planned production saved); 2 items went to Merch Site (special handling)."*

  **F27 nuance — open year, status-less items are legitimate.** F27 has ~25% of items without a Final Status because the buy is still open (Requoting items aside, those have a status). Don't call F27 items without Final Status a "data gap" — they're "no decision yet". Check `pre_buy_program` against the open-buy list before labelling.

### A4b. F25 budget variance — backfilled, treat as directional

- **Symptom:** Report confidently states an F25 variance figure with no caveat — or, the inverse, refuses to compute F25 variance citing a stale "no F25 budget data" rule the agent has internalized from older glossary text.
- **Why wrong:** Earlier deployments had no F25 revised-snapshot data. The current demo dataset backfills it (332 of 336 F25 items now carry a revised budget), so variance is computable. But the budgets were retrofitted, not collected in real time, so they're directional, not audit-grade.
- **Right reading:** Compute F25 variance normally, but include the caveat: *"F25 revised budgets are backfilled in this dataset — treat the variance as directional."* Never override this caveat by asserting "the schema hint doesn't apply to this deployment" in narrative text. The hint *is* the deployment's caveat.

### A5. Counting elements without de-duping POS#

- **Symptom:** "We have 3,000 elements." Real number is ~1,044.
- **Why wrong:** The same POS# appears in multiple `order_snapshots`. Counting snapshot rows ≠ counting elements.
- **Right reading:** De-dupe on `pos_number` (or query `toolkit_items` / `toolkit_wide` directly, which is one row per element).

### A6. "#N/A" treated as a status

- **Symptom:** Status breakdown chart includes "#N/A — 12 items" as if it were a meaningful category.
- **Why wrong:** `#N/A` is a formula null in the source — it means "no order data yet", not a real status.
- **Right reading:** Filter `status NOT ILIKE '%#N/A%'`, or bucket separately with a "no order data" label and explain.

### A7. MOQ ranges parsed as numbers

- **Symptom:** SQL `CAST(moq AS numeric)` errors on a value like "100/200/500".
- **Why wrong:** Range strings exist in older `toolkit_items.site_moq` free-text; they mean the item was quoted at multiple tiers and not locked.
- **Right reading:** Use the structured `vendor_quotes.moq` per tier instead of parsing the free-text site_moq. If the user asks for "the MOQ", surface all three tier values.

### A8. Inventory-fulfilled treated as "$0 spent" without context

- **Symptom:** Report says "$0 spent on item X" because `final.final_production_spend = 0`, with no explanation. The reader can't tell whether the item was cancelled, never produced, or fulfilled from inventory.
- **Why wrong:** Item X was fulfilled from inventory (`lead_time = 'INV'`, `final_outcome = 'inventory_fulfilled'`). No new production cost was incurred (because demand was covered by stock paid for in a prior cycle), but that's not the same as "nothing happened" — units shipped. Reporting a bare `$0` reads as a data hole.
- **Right reading:** For **variance against the production budget**, `final_production_spend = $0` is the correct actual figure — inventory items are a legitimate underspend (planned production didn't happen because inventory covered it). For **total-spend summaries**, separate the two concepts: report `final_production_spend` as "new production cost" and `inventory_spend` as "drawn from inventory" on its own line. **In this dataset specifically**, historical `inventory_spend` was not backfilled (it's $0/null for the 18 inventory-fulfilled items), so the dollar value of inventory drawdown can't be reported. State that plainly: *"X items were fulfilled from inventory at no new production cost; the historical inventory cost isn't stored in this dataset, so the dollar value of the drawdown isn't available."* Never claim a spend figure you can't see.

### A9. Treating ordered quantities as just a spend signal

- **Symptom:** Narrative says "$X ordered" without noting what that volume means for demand forecasting.
- **Why wrong:** Sales places orders; ordered quantities are a **demand signal** for the next cycle, not just a spend figure.
- **Right reading:** When relevant, frame ordering data as demand-side feedback — under-ordering tells brand/ops about real market need; order volume is the basis for predicting next-cycle MOQs.

### A10. Recommending actions / speculating on causes

- **Symptom:** Report ends with "the brand team should consider…" or "this likely reflects a vendor delay".
- **Why wrong:** Both prompts explicitly forbid recommendations and external speculation while in beta.
- **Right reading:** State the number, state the data-quality caveats, stop.

### A11. Leaking schema / enum strings into user-facing text

- **Symptom (inline):** *"Cancellation counts include both true cancels (`cancel_cancelled`) and POD swaps (`cancel_pod`)…"*
- **Symptom (methodology footnote):** *"Cancellation rate = (true cancels + POD swaps) ÷ total items. 'True cancel' = `final_outcome = 'cancel_cancelled'`; 'POD swap' = `final_outcome = 'cancel_pod'`."* — the bottom-of-report "definition" section is the most common place this still slips through, because it feels like an audit note. It isn't; it's part of the report.
- **Symptom (labels):** KPI tile labeled `final_production_spend`, table header `buy_wave`, callout referencing `pre_buy_status`.
- **Why wrong:** Regular users (brand, sales, management) don't read the schema. Raw enum values and snake_case column names look like a leaked dev artifact — they break the polish of the report and force the reader to mentally translate.
- **Right reading:** Use the business name everywhere a user can see it. "Cancelled", "POD swap", "ABC Final Spend", "Buy Season", "Budget Spend". If a methodology footnote needs to distinguish two outcomes, use the §10 user-facing labels — *do not* add a parenthetical schema reveal "for clarity." Schema strings live only in SQL and the admin-only `report_queries` array.

---

## 16. How to add to this glossary

When you discover a new misread, a new vocabulary term, or a new schema column:

1. **Find the right section.** Disambiguations → §2. Tier/brand terms → §3. Item axes → §4. Time → §5. Lifecycle/stages → §6. Money terms → §7. Quantities → §8. Formulas → §9. Status → §10. Vendor/sourcing → §11. Field reference → §12. Phrasebook → §13. When-to-ask → §14. Misread → §15.
2. **Use the canonical schema column name.** Always confirm via `get_schema()` and match the actual live column. If the schema doesn't have the column you're naming, fix the schema or skip the entry.
3. **For an anti-pattern (§15), write four lines:** Symptom, Why wrong, Right reading, Right query shape (if applicable). One real example beats a general rule.
4. **Cross-reference, don't duplicate.** If a term already has an entry, add a `[See §X](#X)` link rather than copy-paste.
5. **Re-deploy.** Both `api/chat.js` and `api/admin/report-build.js` read this file at cold start — bump the deploy after edits and the next session picks it up.
