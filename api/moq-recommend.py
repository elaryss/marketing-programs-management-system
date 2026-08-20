"""
POST /api/moq-recommend
Body: {"toolkit_item_id": "<uuid>"}

Auth: Authorization: Bearer <supabase session token>

Pulls historical records matching the item's (brand, category, item_type, season),
runs statistical analysis in pure-Python stdlib, then asks Claude for an
independent judgment-layer recommendation via forced tool-use.

Returns:
{
  "source_item": {brand, category, item_type, pre_buy_program, season, wave, ...},
  "statistical": {data_points, mean, median, std, cv, cancellation_rate_avg,
                  trend_direction, adjusted_recommendation, confidence_score,
                  no_data?, flags?},
  "ai": {ai_recommended_moq, adjustment_reason, rationale, risk_factors,
         negotiation_note} or null,
  "matched_records": [...top 10 used in the math, for the UI table...]
}
"""

import json
import os
import re
import statistics
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from anthropic import Anthropic, APIError, AuthenticationError, RateLimitError
from supabase import create_client


# ---------------------------------------------------------------------
# Cached at module import (cold start)
# ---------------------------------------------------------------------

WAVE_TO_SEASON = {"HL": "Holiday", "SM": "Summer", "SP": "Spring"}
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")

# Read the system prompt once at cold start.
_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "moq-recommender.md"
try:
    SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")
except Exception:
    SYSTEM_PROMPT = "You are the MOQ Recommendation Analyst. Reply only via the submit_moq_recommendation tool."

# Forced tool-use schema. Claude must call this; we read its `input` as the response.
MOQ_TOOL = {
    "name": "submit_moq_recommendation",
    "description": "Submit the AI-judged MOQ recommendation for the buyer.",
    "input_schema": {
        "type": "object",
        "properties": {
            "ai_recommended_moq": {
                "type": "integer",
                "description": "The recommended order quantity. May match or deviate from the statistical recommendation.",
            },
            "adjustment_reason": {
                "type": "string",
                "description": "If ai_recommended_moq differs from the statistical adjusted_recommendation, one short sentence explaining why. Empty string if they match.",
            },
            "rationale": {
                "type": "string",
                "description": "Two to three sentences in plain English for a non-technical buyer.",
            },
            "risk_factors": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Zero to three short specific risk strings (e.g. 'Thin data — 1 record', 'High variance — CV 0.62').",
            },
            "negotiation_note": {
                "type": "string",
                "description": "One sentence on how to use this number with the vendor.",
            },
        },
        "required": [
            "ai_recommended_moq",
            "adjustment_reason",
            "rationale",
            "risk_factors",
            "negotiation_note",
        ],
    },
}


# ---------------------------------------------------------------------
# Lazy clients (cached across warm invocations)
# ---------------------------------------------------------------------

_supabase = None
_anthropic = None


def get_supabase():
    global _supabase
    if _supabase is None:
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        _supabase = create_client(url, key)
    return _supabase


def get_anthropic():
    global _anthropic
    if _anthropic is None:
        api_key = os.environ.get("CLAUDE_API_KEY")
        if not api_key:
            raise RuntimeError("Missing CLAUDE_API_KEY")
        _anthropic = Anthropic(api_key=api_key)
    return _anthropic


# ---------------------------------------------------------------------
# Season / wave parsing
# ---------------------------------------------------------------------

_WAVE_RE = re.compile(r"\b(HL|SM|SP)\b", re.IGNORECASE)


def extract_wave(pre_buy_program):
    """Pull the HL/SM/SP token out of 'F27 HL Buy' style strings."""
    if not pre_buy_program:
        return None
    m = _WAVE_RE.search(pre_buy_program)
    return m.group(1).upper() if m else None


def wave_to_season(wave):
    return WAVE_TO_SEASON.get(wave) if wave else None


# ---------------------------------------------------------------------
# Database lookups
# ---------------------------------------------------------------------

def fetch_source_item(sb, toolkit_item_id):
    """Get the source item with its program + brand + item_type joined in,
    plus the cached MOQ recommendation if one exists."""
    resp = (
        sb.table("toolkit_items")
        .select(
            "id, category, item_type_id, item_description, pos_number, pre_buy_program, "
            "program_id, moq_recommendation, moq_recommended_at, "
            "programs!inner(id, brand_id, name, focus_period, "
            "brands!inner(id, name, category)), "
            "item_types(id, name)"
        )
        .eq("id", toolkit_item_id)
        .single()
        .execute()
    )
    return resp.data


def persist_recommendation(sb, toolkit_item_id, payload):
    """Save the analysis payload to toolkit_items so future opens hit cache.
    Best-effort: log + swallow errors so a write failure doesn't tank the
    response the user is waiting on."""
    try:
        # Strip 'cached' + 'computed_at' from what we store — they're only
        # meaningful as response decorators, not part of the canonical analysis.
        clean = {k: v for k, v in payload.items() if k not in ("cached", "computed_at")}
        sb.table("toolkit_items").update({
            "moq_recommendation": clean,
            "moq_recommended_at": "now()",
        }).eq("id", toolkit_item_id).execute()
    except Exception as e:
        print(f"[moq-recommend] persist failed for {toolkit_item_id}: {e}")


def fetch_historical_items(sb, brand_id, category, item_type_id, exclude_id, wave, season):
    """Fetch historical items matching brand+category+item_type, then filter season in Python."""
    # Step 1: programs belonging to this brand
    progs_resp = (
        sb.table("programs")
        .select("id, name, focus_period, created_at")
        .eq("brand_id", brand_id)
        .execute()
    )
    progs = progs_resp.data or []
    if not progs:
        return [], {}
    progs_by_id = {p["id"]: p for p in progs}
    program_ids = list(progs_by_id.keys())

    # Step 2: matching items
    q = (
        sb.table("toolkit_items")
        .select(
            "id, item_description, pos_number, category, item_type_id, "
            "pre_buy_program, site_moq, portal_price, program_id, created_at"
        )
        .in_("program_id", program_ids)
        .eq("category", category)
        .neq("id", exclude_id)
    )
    if item_type_id:
        q = q.eq("item_type_id", item_type_id)

    items_resp = q.execute()
    raw_items = items_resp.data or []

    # Step 3: season fuzzy filter in Python (case-insensitive substring on either field)
    season_lc = (season or "").lower()
    wave_lc = (wave or "").lower()

    def season_match(it):
        if not season_lc and not wave_lc:
            return True
        prog = progs_by_id.get(it.get("program_id"), {})
        focus = (prog.get("focus_period") or "").lower()
        pbp = (it.get("pre_buy_program") or "").lower()
        return (
            (season_lc and (season_lc in focus or season_lc in pbp))
            or (wave_lc and wave_lc in pbp)
        )

    matched = [it for it in raw_items if season_match(it)]
    return matched, progs_by_id


def fetch_snapshots(sb, item_ids):
    """Pull original + final snapshots for the matched item ids. Returns dict by item_id."""
    if not item_ids:
        return {}
    resp = (
        sb.table("order_snapshots")
        .select(
            "toolkit_item_id, snapshot_type, ordered_qty, final_production_qty, status"
        )
        .in_("toolkit_item_id", item_ids)
        .in_("snapshot_type", ["original", "final"])
        .execute()
    )
    by_item = {}
    for s in resp.data or []:
        slot = by_item.setdefault(s["toolkit_item_id"], {})
        slot[s["snapshot_type"]] = s
    return by_item


# ---------------------------------------------------------------------
# Statistical analysis (no Claude involvement)
# ---------------------------------------------------------------------

def build_record_rows(matched_items, snapshots_by_item, progs_by_id):
    """For each matched item, produce a flat row we can do stats on + show in the UI."""
    rows = []
    for it in matched_items:
        snaps = snapshots_by_item.get(it["id"], {})
        orig = snaps.get("original") or {}
        fin = snaps.get("final") or {}

        site_moq = _to_num(it.get("site_moq"))
        portal_price = _to_num(it.get("portal_price"))
        original_qty = _to_num(orig.get("ordered_qty"))
        final_qty = _to_num(fin.get("final_production_qty"))
        final_status = fin.get("status")

        # Quantity to use for the recommendation: prefer original_qty (what was planned),
        # else final_qty, else site_moq.
        qty_for_stats = original_qty if original_qty else (final_qty or site_moq)

        # Cancellation rate per record
        if original_qty and original_qty > 0 and final_qty is not None:
            cancel_rate = max(0.0, min(1.0, (original_qty - final_qty) / original_qty))
        else:
            cancel_rate = None

        prog = progs_by_id.get(it.get("program_id"), {})

        rows.append({
            "toolkit_item_id": it["id"],
            "item_description": it.get("item_description"),
            "pos_number": it.get("pos_number"),
            "pre_buy_program": it.get("pre_buy_program"),
            "program_name": prog.get("name"),
            "focus_period": prog.get("focus_period"),
            "site_moq": site_moq,
            "portal_price": portal_price,
            "original_qty": original_qty,
            "final_production_qty": final_qty,
            "final_status": final_status,
            "qty_for_stats": qty_for_stats,
            "cancel_rate": cancel_rate,
            "created_at": it.get("created_at"),
        })
    # Most recent first (proxy: created_at descending)
    rows.sort(key=lambda r: (r.get("created_at") or ""), reverse=True)
    return rows


def _to_num(v):
    if v is None or v == "":
        return None
    try:
        n = float(v)
        return n if n == n else None  # filter NaN
    except (TypeError, ValueError):
        return None


def analyze(rows):
    """Run the statistical analysis layer. Pure stdlib. No Claude."""
    quantities = [r["qty_for_stats"] for r in rows if r["qty_for_stats"] and r["qty_for_stats"] > 0]
    cancel_rates = [r["cancel_rate"] for r in rows if r["cancel_rate"] is not None]

    data_points = len(quantities)

    if data_points == 0:
        return {
            "data_points": 0,
            "no_data": True,
            "mean": None,
            "median": None,
            "std": None,
            "cv": None,
            "cancellation_rate_avg": None,
            "trend_direction": None,
            "adjusted_recommendation": None,
            "confidence_score": "none",
            "flags": ["No historical records match this combination."],
        }

    mean = round(statistics.mean(quantities), 1)
    median = round(statistics.median(quantities), 1)
    std = round(statistics.stdev(quantities), 1) if data_points >= 2 else 0.0
    cv = round(std / mean, 3) if mean > 0 else 0.0
    cancel_avg = round(statistics.mean(cancel_rates), 3) if cancel_rates else 0.0
    adjusted = int(round(median - (cancel_avg * median)))

    # Trend direction — compare most recent 2 to the rest (need 3+ data points to call)
    trend = "flat"
    if data_points >= 3:
        recent = quantities[:2]  # rows are already sorted recent-first
        older = quantities[2:]
        r_mean = statistics.mean(recent)
        o_mean = statistics.mean(older)
        if r_mean > o_mean * 1.10:
            trend = "up"
        elif r_mean < o_mean * 0.90:
            trend = "down"

    # Confidence
    if data_points >= 3 and cv < 0.3:
        confidence = "high"
    elif data_points >= 2 and cv < 0.5:
        confidence = "medium"
    else:
        confidence = "low"

    flags = []
    if data_points == 1:
        flags.append("Single data point — both recommendations based on limited history.")
    if cv >= 0.5:
        flags.append(f"High variance — CV {cv:.2f}. Median preferred over mean.")
    if cancel_avg >= 0.20:
        flags.append(f"High historical cancellation rate ({int(cancel_avg * 100)}%).")

    return {
        "data_points": data_points,
        "no_data": False,
        "mean": mean,
        "median": median,
        "std": std,
        "cv": cv,
        "cancellation_rate_avg": cancel_avg,
        "trend_direction": trend,
        "adjusted_recommendation": adjusted,
        "confidence_score": confidence,
        "flags": flags,
    }


# ---------------------------------------------------------------------
# Claude judgment layer
# ---------------------------------------------------------------------

def call_claude(stats_dict, source_summary):
    """Send the analysis dict to Claude; force a tool call for structured response."""
    client = get_anthropic()

    user_payload = {
        "source_item": source_summary,
        "analysis": stats_dict,
    }
    user_message = (
        "Here is the source item plus the statistical analysis. "
        "Read the analysis and return your recommendation by calling the "
        "submit_moq_recommendation tool.\n\n"
        + json.dumps(user_payload, indent=2, default=str)
    )

    resp = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        tools=[MOQ_TOOL],
        tool_choice={"type": "tool", "name": "submit_moq_recommendation"},
        messages=[{"role": "user", "content": user_message}],
    )

    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "submit_moq_recommendation":
            return block.input

    raise RuntimeError("Claude did not return a tool_use block as required.")


# ---------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._cors(204)
        self.end_headers()

    def do_POST(self):
        try:
            sb = get_supabase()

            # Auth: Bearer token verified against Supabase Auth
            auth_header = self.headers.get("Authorization", "")
            m = re.match(r"^Bearer\s+(.+)$", auth_header, re.I)
            if not m:
                return self._json(401, {"error": "Missing bearer token"})
            token = m.group(1)
            user_resp = sb.auth.get_user(token)
            if not getattr(user_resp, "user", None):
                return self._json(401, {"error": "Invalid session"})

            # Body
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            try:
                body = json.loads(raw or "{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "Invalid JSON body"})

            item_id = body.get("toolkit_item_id")
            if not item_id:
                return self._json(400, {"error": "toolkit_item_id required"})
            force = bool(body.get("force", False))

            # Source item
            try:
                src = fetch_source_item(sb, item_id)
            except Exception as e:
                return self._json(404, {"error": f"toolkit_item not found: {e}"})
            if not src:
                return self._json(404, {"error": "toolkit_item not found"})

            # CACHE HIT: if this item already has a stored recommendation and
            # the caller didn't force-refresh, return it verbatim. Zero Claude
            # spend on revisits — the user reopens a drawer and sees the same
            # analysis they generated last time.
            if not force and src.get("moq_recommendation"):
                cached = src["moq_recommendation"]
                if isinstance(cached, dict):
                    cached = {**cached, "cached": True, "computed_at": src.get("moq_recommended_at")}
                    return self._json(200, cached)

            prog = src.get("programs") or {}
            brand = (prog.get("brands") or {}) if isinstance(prog, dict) else {}
            item_type = src.get("item_types") or {}

            brand_id = brand.get("id") or prog.get("brand_id")
            brand_name = brand.get("name")
            category = src.get("category")
            item_type_id = src.get("item_type_id")
            item_type_name = item_type.get("name") if isinstance(item_type, dict) else None
            pbp = src.get("pre_buy_program")
            wave = extract_wave(pbp)
            season = wave_to_season(wave)

            source_summary = {
                "brand_name": brand_name,
                "brand_category": brand.get("category"),
                "category": category,
                "item_type": item_type_name,
                "item_description": src.get("item_description"),
                "pos_number": src.get("pos_number"),
                "pre_buy_program": pbp,
                "wave": wave,
                "season_hint": season,
                "program_name": prog.get("name"),
                "focus_period": prog.get("focus_period"),
            }

            if not brand_id:
                return self._json(400, {"error": "Source item has no resolvable brand"})

            # Historical query + analysis
            matched_items, progs_by_id = fetch_historical_items(
                sb, brand_id, category, item_type_id, item_id, wave, season
            )
            snapshots = fetch_snapshots(sb, [it["id"] for it in matched_items])
            rows = build_record_rows(matched_items, snapshots, progs_by_id)
            stats = analyze(rows)

            # Claude judgment (skipped on zero data)
            ai = None
            if not stats["no_data"]:
                try:
                    ai = call_claude(stats, source_summary)
                except (APIError, AuthenticationError, RateLimitError) as e:
                    ai = {"_error": f"Claude error: {type(e).__name__}: {e}"}
                except Exception as e:
                    ai = {"_error": f"AI layer failed: {e}"}

            payload = {
                "source_item": source_summary,
                "statistical": stats,
                "ai": ai,
                "matched_records": rows[:10],  # cap UI table at 10
                "total_matched": len(rows),
            }
            # Persist so the next open / bulk run is a free cache hit.
            # Even no-data and AI-error responses are worth caching — they
            # don't change unless the user adds historical data or re-runs.
            persist_recommendation(sb, item_id, payload)
            return self._json(200, {**payload, "cached": False})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    # --- helpers ---
    def _cors(self, status):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, status, payload):
        body = json.dumps(payload, default=str).encode("utf-8")
        self._cors(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Quiet the default per-request log line on Vercel
        return
