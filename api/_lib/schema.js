/**
 * Hardcoded schema description returned by the `get_schema` tool.
 *
 * Single source of truth for what the chat + report-builder agents know about
 * the DB. Keep aligned with the live schema (run the inventory query in
 * the project context doc before editing).
 *
 * Intentionally analyst-focused: lists only the columns an analyst would
 * actually use, not every AI-research / audit-trail field. Prefer the
 * pre-aggregated `v_*` views over base tables when they fit.
 */

const SCHEMA = {
  description:
    'Marketing Programs Management System — toolkit operational tables + 5 pre-aggregated analytical views. Programs hold toolkit_items (the printed/displayed elements). Each item has tiered quotes from one or more vendors; one quote becomes the "selected" one. order_snapshots records qty + spend at each stage of the buy window. The v_* views pre-join + bucket items by outcome so most analytical questions can be answered from a single view.',

  status_enums: {
    program_status: [
      'draft',
      'brief_in_progress',
      'vendor_briefing',
      'quotes_received',
      'buy_window_open',
      'buy_window_closed',
      'in_production',
      'complete',
    ],
    item_category: ['paper', 'display', 'premium'],
    quote_status: ['open', 'selected', 'rejected', 'expired'],
    snapshot_type: ['original', 'revised', 'requote', 'final'],
    // v_item_outcomes.final_outcome — the canonical "what happened to this item"
    final_outcome: [
      'approved',              // final snapshot status starts with "Approved"
      'inventory_fulfilled',   // status "Inventory" — fulfilled from existing stock, no production
      'cancel_cancelled',      // a true cancel (status starts with "Cancel")
      'cancel_pod',            // cancelled and swapped to Print-On-Demand
      'removed_prebuy',        // pre_buy_status='removed' (dropped before buy window)
      'pod_prebuy',            // pre_buy_status='POD' (POD from the start)
      'abc_merch_prebuy',      // pre_buy_status='Post on ABC Merch'
      'part_of_kit',           // final status starts with "Part of a Kit"
      'requoting',             // final status starts with "Requot"
      'in_flight_requoting',   // no final snapshot yet; has a requote row in motion
      'no_outcome',            // no final + nothing else to classify on
      'unknown',               // catch-all
    ],
  },

  tables: {
    brands: {
      description: 'Brands (e.g. Brand P-C, Brand P-B, Brand P-E).',
      columns: {
        id: 'uuid',
        name: 'text — unique',
        code: 'text',
        category: 'text — PRM (premium) or LUX (luxury). Use this for the buy split, NOT price_tier.',
        price_tier: 'text — Entry / Mid / Premium / Luxury (marketing tier label, not the buy classification)',
        target_audience: 'text',
      },
    },
    programs: {
      description: 'One marketing campaign per row, owned by a brand.',
      columns: {
        id: 'uuid',
        brand_id: 'uuid → brands.id',
        name: 'text',
        code: 'text',
        focus_period: 'text — e.g. "Jul/Aug", "Q4"',
        focus_period_code: 'text — short code form',
        shipping_wave: 'text — e.g. "Wave 1", "Nov/Dec"',
        category: 'text — PRM / LUX',
        theme: 'text',
        status: 'program_status (enum, see status_enums)',
        buy_window_open_date: 'date',
        buy_window_close_date: 'date',
        ship_date: 'date',
      },
    },
    item_types: {
      description: 'Catalog of element types (Necker, Case Sleeve, Display, ...).',
      columns: {
        id: 'uuid',
        name: 'text — unique',
        code: 'text',
        sub_category: 'text',
        element_zone: 'text — "Display - DSP" / "Print - PRT" / "Premium - PRE"',
        default_category: 'item_category (enum)',
      },
    },
    vendors: {
      description: 'Suppliers who quote and produce toolkit items.',
      columns: {
        id: 'uuid',
        name: 'text — unique',
        sourcing_responsibility: 'text — ABC / IMS / JMS / Third Party',
      },
    },
    toolkit_items: {
      description:
        'CORE TABLE. One row per element in a program (a necker for BV Fall, a display for Cali Summer, etc.). Joins to vendor_quotes via selected_quote_id.',
      columns: {
        id: 'uuid',
        program_id: 'uuid → programs.id',
        item_type_id: 'uuid → item_types.id',
        pos_number: 'text — point-of-sale identifier (master key per element across lifecycle)',
        pos_code: 'text',
        shipping_wave: 'text — per-item override of program shipping wave (e.g. "Nov/Dec", "Jul/Aug")',
        category: 'item_category (enum)',
        item_description: 'text',
        description_extended: 'text',
        sourcing_description: 'text',
        item_sub_category: 'text',
        standard_or_custom: 'text — Standard / Custom',
        pack_out_qty: 'numeric',
        uom: 'text — CT / PK / RL / PD',
        vendor_id: 'uuid → vendors.id — planned vendor (may differ from selected quote)',
        buyer: 'text',
        country_code: 'text → countries.iso_code',
        lead_time: 'text',
        new_or_rerun: 'text — New / Rerun',
        rerun_sku_no: 'text',
        inventory_available: 'boolean',
        pre_buy_status: 'text — include / removed / POD / Post on ABC Merch (drives "removed_prebuy" / "pod_prebuy" / "abc_merch_prebuy" outcomes in v_item_outcomes)',
        selected_quote_id: 'uuid → vendor_quotes.id — NULL until a quote is chosen',
        ims_job_no: 'text',
        abc_po_no: 'text',
        pre_buy_program: 'text — e.g. "F26 HL Buy", "F27 SM Buy". Source of fiscal_year + buy_wave in v_item_outcomes.',
        spec_template: 'text — e.g. "Necker", "Case Sleeve" (used for template-driven specs)',
        site_moq: 'numeric — display MOQ on the requester-facing site',
        portal_price: 'numeric — Sale Price = Production Price × 1.0675 (overridable). Use for site-displayed pricing, NOT for buy-window spend.',
        estimated_budget_spend: 'numeric — site-displayed budget estimate',
        site_setup_comments: 'text',
        moq_recommendation: 'jsonb — AI-suggested MOQ recommendation payload',
        moq_recommended_at: 'timestamptz',
      },
    },
    paper_specs: {
      description: '1:1 with toolkit_items where category=paper. NULL for non-paper items.',
      columns: {
        toolkit_item_id: 'uuid → toolkit_items.id (primary key)',
        flat_size: 'text',
        finished_size: 'text',
        material: 'text',
        coated_uncoated: 'text',
        same_different_art: 'text',
        num_colors: 'text',
        coating: 'text',
        finishing: 'text',
        collating: 'text',
        flat_dimensions: 'text',
        assembled_dimensions: 'text',
        additional_specs: 'text',
      },
    },
    quote_batches: {
      description:
        'One row per (vendor, toolkit_item, quote-event). Holds shared metadata; tiered pricing lives in vendor_quotes.',
      columns: {
        id: 'uuid',
        toolkit_item_id: 'uuid → toolkit_items.id',
        vendor_id: 'uuid → vendors.id',
        lead_time_days: 'int',
        payment_terms: 'text',
        validity_period: 'text',
        source: 'text — manual / email_ingest / etc.',
        parse_confidence: 'numeric — only set on AI-parsed quotes',
        status: 'quote_status (enum)',
        received_at: 'timestamptz',
      },
    },
    vendor_quotes: {
      description:
        'One row per MOQ tier within a quote batch. total_unit_price is a stored generated column = production_price + shipping_cost + tariff.',
      columns: {
        id: 'uuid',
        quote_batch_id: 'uuid → quote_batches.id',
        tier_label: 'text — e.g. "MOQ 1"',
        tier_number: 'int — 1, 2, 3 for sorting',
        moq: 'numeric — minimum order qty for this tier',
        qty_uom: 'numeric',
        qty_eaches: 'numeric',
        production_price: 'numeric — per UOM',
        shipping_cost: 'numeric — per UOM',
        tariff: 'numeric — per UOM',
        total_unit_price: 'numeric — GENERATED, use this for any "cheapest" question',
      },
    },
    order_snapshots: {
      description:
        'Audit trail of order qty + spend at each buy-window stage. snapshot_type distinguishes original / revised / requote / final. One of each per item, except requote which can repeat. NOTE: budget_spend is populated on the REVISED snapshot, not the original (the original carries only the initial ordered_qty estimate).',
      columns: {
        id: 'uuid',
        toolkit_item_id: 'uuid → toolkit_items.id',
        snapshot_type: 'snapshot_type (enum)',
        ordered_qty: 'numeric',
        ordered_uom: 'text',
        requote_qty: 'numeric',
        final_production_qty: 'numeric — only on final snapshots',
        sales_demand_qty: 'numeric',
        inventory_qty: 'numeric — qty fulfilled from existing inventory',
        budget_spend: 'numeric — populated on REVISED, not original',
        investment_in_moq: 'numeric',
        production_price: 'numeric — per UOM at this snapshot',
        final_sales_price: 'numeric',
        final_production_spend: 'numeric — final $',
        sales_budget_spend: 'numeric',
        inventory_spend: 'numeric',
        plus_minus_moq: 'numeric — +/- vs MOQ at this snapshot',
        status: 'text — free-text status string. v_item_outcomes maps this to the final_outcome enum.',
      },
    },
    countries: {
      description: 'Country reference. Used as the parent of toolkit_items.country_code.',
      columns: {
        iso_code: 'text — primary key',
        name: 'text',
      },
    },
  },

  views: {
    toolkit_wide: {
      description:
        'DENORMALIZED VIEW over toolkit_items. One row per item with brand + program + item_type + paper_specs + selected vendor & quote pre-joined. Use this when you need item-level rows with their context. Does NOT include lifecycle outcomes — use v_item_outcomes for that.',
      columns: {
        toolkit_item_id: 'uuid',
        program_name: 'text',
        focus_period: 'text',
        program_shipping_wave: 'text — from programs.shipping_wave (NOTE: column name differs from base table)',
        brand_name: 'text',
        brand_category: 'text — PRM / LUX',
        pos_number: 'text',
        item_category: 'item_category — values: paper / display / premium',
        item_type: 'text — joined from item_types.name',
        element_zone: 'text',
        item_description: 'text',
        description_extended: 'text',
        sourcing_description: 'text',
        standard_or_custom: 'text',
        flat_size: 'text',
        finished_size: 'text',
        material: 'text',
        coated_uncoated: 'text',
        num_colors: 'text',
        coating: 'text',
        finishing: 'text',
        collating: 'text',
        pack_out_qty: 'numeric',
        uom: 'text',
        selected_vendor: 'text — vendor name on the selected quote (NULL if no quote selected)',
        selected_moq: 'numeric',
        selected_production_price: 'numeric',
        selected_shipping_cost: 'numeric',
        selected_tariff: 'numeric',
        selected_total_unit_price: 'numeric',
        country_code: 'text',
        lead_time: 'text',
        new_or_rerun: 'text',
        pre_buy_status: 'text',
        ims_job_no: 'text',
        abc_po_no: 'text',
        pre_buy_program: 'text — e.g. "F26 HL Buy"',
        spec_template: 'text',
        site_moq: 'numeric',
        portal_price: 'numeric',
        estimated_budget_spend: 'numeric',
        moq_recommendation: 'jsonb',
        moq_recommended_at: 'timestamptz',
      },
    },

    v_item_outcomes: {
      description:
        'SOURCE OF TRUTH for lifecycle analysis. One row per toolkit_item with brand/program/vendor/category joined, fiscal_year + buy_wave parsed from pre_buy_program, and an 11-value final_outcome bucket derived from pre_buy_status + the final snapshot status. All other v_* views aggregate from this view, so totals never diverge. Use this for any "what happened to the item" question.',
      columns: {
        toolkit_item_id: 'uuid',
        pos_number: 'text',
        program_id: 'uuid',
        program_name: 'text',
        brand_id: 'uuid',
        brand_name: 'text',
        brand_category: 'text — PRM / LUX',
        item_type: 'text',
        item_category: 'text — paper / display / premium',
        vendor_name: 'text',
        lead_time: 'text',
        standard_or_custom: 'text',
        new_or_rerun: 'text',
        country_code: 'text',
        pre_buy_program: 'text — e.g. "F26 HL Buy"',
        fiscal_year: 'text — derived: "F25" / "F26" / "F27" or "Unknown"',
        buy_wave: 'text — derived: "HL" / "SM" / "SP" or "Unknown"',
        pre_buy_status: 'text — include / removed / POD / Post on ABC Merch',
        final_status_raw: 'text — verbatim status string off the final snapshot',
        final_outcome: 'text — canonical enum (see status_enums.final_outcome)',
        inventory_partial: 'boolean — final.inventory_qty > 0 (orthogonal to outcome; Approved items can also be partial-inventory)',
        inventory_spend_partial: 'boolean — final.inventory_spend > 0',
        ordered_qty_original: 'numeric — from the original snapshot',
        budget_spend: 'numeric — from the REVISED snapshot (NULL when no revised row exists, e.g. F25 closed before revised tracking)',
        unit_price_requote: 'numeric — from the requote snapshot',
        final_production_qty: 'numeric — from the final snapshot',
        final_production_spend: 'numeric — from the final snapshot',
        final_inventory_qty: 'numeric',
        final_inventory_spend: 'numeric',
        final_sales_budget_spend: 'numeric',
        final_plus_minus_moq: 'numeric',
      },
    },

    v_prebuy_funnel: {
      description:
        'Pre-aggregated workflow funnel: counts + spend totals per (fiscal_year, buy_wave, pre_buy_status, final_outcome). Use for "how many items in the F26 HL buy ended up cancelled" style questions without re-summing v_item_outcomes.',
      columns: {
        fiscal_year: 'text — "F25" / "F26" / "F27" / "Unknown"',
        buy_wave: 'text — "HL" / "SM" / "SP" / "Unknown"',
        pre_buy_status: 'text',
        final_outcome: 'text — see status_enums.final_outcome',
        item_count: 'bigint',
        final_spend: 'numeric — SUM(final_production_spend)',
        budget_spend: 'numeric — SUM(budget_spend) from the revised snapshot',
        inventory_spend: 'numeric — SUM(final_inventory_spend)',
      },
    },

    v_spend_by_brand_season: {
      description:
        'Brand × fiscal_year totals — item counts, outcome breakdown, budget vs actual spend, variance. Use for "top brands by spend in F26" or "which brands have the biggest variance" questions.',
      columns: {
        brand_id: 'uuid',
        brand_name: 'text',
        brand_category: 'text — PRM / LUX',
        fiscal_year: 'text — "F25" / "F26" / "F27" / "Unknown"',
        item_count: 'bigint — every item touching this brand+year',
        items_included: 'bigint — pre_buy_status = "include"',
        items_approved: 'bigint — final_outcome = "approved"',
        items_inventory_fulfilled: 'bigint',
        items_cancelled: 'bigint — cancel_cancelled OR cancel_pod',
        items_inventory_partial: 'bigint — inventory_spend > 0',
        budget_spend: 'numeric — SUM(budget_spend)',
        actual_spend: 'numeric — SUM(final_production_spend)',
        inventory_spend: 'numeric — SUM(final_inventory_spend)',
        variance_abs: 'numeric — actual_spend − budget_spend (positive = over budget)',
      },
    },

    v_spend_by_vendor_season: {
      description:
        'Vendor × fiscal_year totals — item counts, outcome breakdown, budget vs actual spend. Use for "which vendor produced the most for us in F26" or "which vendor has the highest cancel rate" questions.',
      columns: {
        vendor_name: 'text',
        fiscal_year: 'text',
        item_count: 'bigint',
        items_approved: 'bigint',
        items_pod_swapped: 'bigint — final_outcome = "cancel_pod"',
        items_cancelled: 'bigint — cancel_cancelled OR cancel_pod',
        actual_spend: 'numeric — SUM(final_production_spend)',
        budget_spend: 'numeric — SUM(budget_spend)',
      },
    },

    v_cancellation_by_dimension: {
      description:
        'Cancellation rates sliced 5 ways: brand / item_type / vendor / lead_time / item_category. Single shape, dimension_type tells the consumer which slice they\'re looking at. Use for "which lead_time bucket cancels most" or comparing cancel rates across multiple dimensions in one query.',
      columns: {
        dimension_type: 'text — "brand" / "item_type" / "vendor" / "lead_time" / "item_category"',
        dimension_value: 'text — the specific brand/vendor/lead_time/etc. name',
        fiscal_year: 'text',
        total_items: 'bigint',
        cancelled_items: 'bigint — true cancels + POD swaps',
        true_cancels: 'bigint — final_outcome = "cancel_cancelled" only',
        pod_swaps: 'bigint — final_outcome = "cancel_pod" only',
        cancelled_spend: 'numeric — SUM(final_production_spend) for cancelled items',
      },
    },
  },

  hints: [
    'For lifecycle / outcome / spend / variance questions, START with v_item_outcomes — it has fiscal_year + buy_wave parsed, brand + vendor + category joined, and the final_outcome bucket.',
    'For pre-aggregated totals by brand/vendor/funnel/cancel-dimension, prefer the matching v_* view over re-aggregating v_item_outcomes from scratch.',
    'Use toolkit_wide for item-level rows with specs + selected vendor pricing (paper_specs columns, selected_total_unit_price, etc.). It does NOT carry lifecycle outcomes.',
    'For tiered vendor comparisons ("cheapest tier-1 quote for matte neckers"), you need quote_batches + vendor_quotes. toolkit_wide only shows the *selected* quote.',
    'Stage matters when quoting $ figures. v_item_outcomes.budget_spend is the REVISED-snapshot budget; v_item_outcomes.final_production_spend is the final $. portal_price + estimated_budget_spend on toolkit_items are *site-displayed* values, not lifecycle spend.',
    'F25 has no budget data — it closed before revised-snapshot tracking landed. Variance analysis only works for F26 and F27.',
    'fiscal_year and buy_wave on v_item_outcomes are derived from pre_buy_program — items missing pre_buy_program land in "Unknown". State row counts when "Unknown" is non-trivial.',
    'v_item_outcomes.final_outcome covers 11 cases plus "unknown". Anything except "approved" is a deviation from the buy plan; "cancel_cancelled" and "cancel_pod" together are the cancellation universe.',
    'Use brands.category (PRM/LUX) for the buy split, NOT brands.price_tier (which is a marketing tier label).',
    'Do not qualify columns with `ti.` etc. unless your SQL has an actual table alias — the chat_run_sql RPC will not auto-alias for you.',
    'vendor_quotes.total_unit_price is a stored generated column (production + shipping + tariff) — use it directly for any "cheapest" question.',
  ],
};

module.exports = { SCHEMA };
