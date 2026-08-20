"""
POST /api/admin/send-report-email
Body: {"request_id": "<uuid>"}

Auth: Authorization: Bearer <supabase session token>

Sends an HTML email to the requester with a link to the saved report.
Uses smtplib.SMTP_SSL — SMTP creds come from Vercel env vars:
  SMTP_HOST       (e.g. smtp.gmail.com)
  SMTP_PORT       (e.g. 465)
  SMTP_USER       (Gmail address used as the From)
  SMTP_APP_PASSWORD  (Gmail App Password — never logged)
  SMTP_FROM_NAME  (display name, default "Marketing Ops")

On success, updates report_requests.email_sent_at and returns
{"ok": true, "sent_to": "<email>"}. On SMTP failure the row is unchanged
and the caller gets a 502 with the error message.
"""

import json
import os
import re
import smtplib
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from supabase import create_client


# Cached across warm invocations
_supabase = None

REPORT_BASE_URL = os.environ.get("REPORT_BASE_URL", "https://your-deployment.example.com")


def get_supabase():
    global _supabase
    if _supabase is None:
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        _supabase = create_client(url, key)
    return _supabase


def first_paragraph(markdown_text):
    """Pull the first non-empty paragraph from the narrative. Cheap and good enough
    for an email preview — we don't need full markdown rendering."""
    if not markdown_text:
        return ""
    paras = [p.strip() for p in markdown_text.split("\n\n") if p.strip()]
    if not paras:
        return ""
    # Strip leading markdown header syntax if present (# / ## etc.)
    p = re.sub(r"^#+\s+", "", paras[0])
    # Cap to ~600 chars so the email preview doesn't drown the link
    if len(p) > 600:
        p = p[:597].rstrip() + "…"
    return p


def html_escape(s):
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def build_email(report, link_url):
    title = report.get("title") or "Your custom report"
    preview = first_paragraph(report.get("report_narrative") or "")
    requester_name = report.get("requester_name") or "there"

    # Plain text fallback
    text_body = (
        f"Hi {requester_name},\n\n"
        f"Your custom report is ready:\n\n"
        f"  {title}\n\n"
        + (f"{preview}\n\n" if preview else "")
        + f"View the full report: {link_url}\n\n"
        f"— Marketing Ops"
    )

    # HTML version (lightweight, inline styles for email clients)
    html_body = f"""<!doctype html>
<html><body style="font-family: 'Helvetica Neue', Arial, sans-serif; background:#f2f7fa; padding:24px; color:#1a232b;">
  <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:6px; overflow:hidden; border:1px solid rgba(58,73,84,0.12);">
    <div style="background:#3A4954; color:#fff; padding:20px 26px;">
      <div style="font-family: monospace; font-size:10px; letter-spacing:0.22em; color:#e8a85c; text-transform:uppercase; margin-bottom:6px;">Marketing Ops · Custom Report</div>
      <div style="font-size:20px; font-weight:600; line-height:1.25;">{html_escape(title)}</div>
    </div>
    <div style="padding:24px 26px; font-size:14.5px; line-height:1.6;">
      <p style="margin:0 0 14px;">Hi {html_escape(requester_name)},</p>
      <p style="margin:0 0 14px;">Your custom report is ready to view.</p>
      {f'<p style="margin:0 0 18px; color:#566A75;">{html_escape(preview)}</p>' if preview else ''}
      <p style="margin:0 0 22px;">
        <a href="{html_escape(link_url)}" style="display:inline-block; background:#ff7a1a; color:#fff; padding:11px 22px; border-radius:4px; text-decoration:none; font-weight:600; letter-spacing:0.04em;">Open report →</a>
      </p>
      <p style="margin:0; font-size:12px; color:#566A75;">If the button doesn't work, paste this link into your browser:<br><span style="color:#3A4954; word-break:break-all;">{html_escape(link_url)}</span></p>
    </div>
    <div style="padding:14px 26px; background:#f2f7fa; font-family: monospace; font-size:10.5px; color:#566A75; letter-spacing:0.06em;">
      Marketing Programs Management System
    </div>
  </div>
</body></html>"""

    return text_body, html_body


def send_smtp(to_email, subject, text_body, html_body):
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "465") or 465)
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_APP_PASSWORD")
    from_name = os.environ.get("SMTP_FROM_NAME", "Marketing Ops")

    if not user or not password:
        raise RuntimeError("Missing SMTP_USER or SMTP_APP_PASSWORD env vars")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((from_name, user))
    msg["To"] = to_email
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    with smtplib.SMTP_SSL(host, port, timeout=20) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._cors(204)
        self.end_headers()

    def do_POST(self):
        try:
            sb = get_supabase()

            # Auth: accept either
            #   - Bearer <supabase session token>     (signed-in admin)
            #   - x-internal-trigger: <SECRET>        (server-to-server from approve endpoint, cron, etc.)
            trigger_secret = os.environ.get("INTERNAL_TRIGGER_SECRET")
            trigger_header = self.headers.get("x-internal-trigger") or self.headers.get("X-Internal-Trigger") or ""
            is_internal = bool(trigger_secret) and trigger_header == trigger_secret

            if not is_internal:
                auth_header = self.headers.get("Authorization", "")
                m = re.match(r"^Bearer\s+(.+)$", auth_header, re.I)
                if not m:
                    return self._json(401, {"error": "Missing bearer token or internal trigger"})
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

            request_id = body.get("request_id")
            if not request_id or not isinstance(request_id, str):
                return self._json(400, {"error": "request_id required"})

            # Load the report row
            resp = (
                sb.table("report_requests")
                .select(
                    "id, title, description, requester_name, requester_email, "
                    "report_narrative, status"
                )
                .eq("id", request_id)
                .single()
                .execute()
            )
            report = resp.data
            if not report:
                return self._json(404, {"error": "Report request not found"})
            if not report.get("requester_email"):
                return self._json(400, {"error": "Report has no requester_email"})

            link_url = f"{REPORT_BASE_URL.rstrip('/')}/report.html?id={request_id}"
            subject = f"Your custom report: {report.get('title') or 'Marketing Ops report'}"
            text_body, html_body = build_email(report, link_url)

            try:
                send_smtp(report["requester_email"], subject, text_body, html_body)
            except smtplib.SMTPAuthenticationError as e:
                return self._json(502, {"error": f"SMTP auth failed: {e.smtp_error.decode() if hasattr(e, 'smtp_error') else str(e)}"})
            except smtplib.SMTPException as e:
                return self._json(502, {"error": f"SMTP error: {e}"})
            except OSError as e:
                return self._json(502, {"error": f"SMTP network error: {e}"})

            # Stamp email_sent_at on success. Use a real ISO timestamp —
            # PostgREST won't evaluate the string "now()" as a SQL function,
            # it would store it as a literal text and reject it as invalid
            # timestamptz. ISO-8601 with timezone is the right shape.
            sent_ts = datetime.now(timezone.utc).isoformat()
            try:
                sb.table("report_requests").update(
                    {"email_sent_at": sent_ts}
                ).eq("id", request_id).execute()
            except Exception as e:
                # Email already sent — don't fail the response just because of
                # the stamp write. But this should now work.
                print(f"[send-report-email] stamp update failed: {e}")

            return self._json(200, {"ok": True, "sent_to": report["requester_email"], "sent_at": sent_ts})

        except Exception as e:
            print(f"[send-report-email] Unexpected error: {e}")
            return self._json(500, {"error": str(e)})

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
        return
