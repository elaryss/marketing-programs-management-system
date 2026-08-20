# Claude API Prompts

System prompts used by Claude API integrations in this project. One file per prompt.

Model pinned to `claude-sonnet-4-6` (via `CLAUDE_MODEL` env var).

## How prompts are used

Prompts are loaded at cold start by their consumer (Vercel Serverless Function, or in legacy/parked work an n8n HTTP Request node) and sent as the `system` parameter to the Claude Messages API. The user turn (chat message, workflow payload, etc.) is sent as the `user` message. Some prompts use a `tools` array — either free-form tool use (chat agent) or a single forced tool for schema-enforced JSON output (workflow analyzer).

## Current prompts

| File | Used by | Module | Purpose | Status |
|---|---|---|---|---|
| `chat-agent.md` | `api/chat.js` (Vercel Serverless Function) | M4 / chat surface | Pre-Buy Analyst persona + domain primer + tool-use rules. Drives `/chat` and the parked floating widget. Reads schema via `get_schema`, queries Supabase via `run_sql` (SELECT-only RPC). | **Active — live in production** |
| `workflow-analyzer.md` | `workflows/01_workflow-designer.json` (n8n) | M1 (archived) | Analyzes a submitted workflow and returns structured JSON: extracted steps, bottlenecks, tool comparison, ROI estimate, recommended tool, implementation guide | **Parked** — M1 was disconnected |

## File format

Each prompt file:

1. Front matter (purpose, consumer, input/output shape, model, thinking, effort)
2. System prompt body (the actual instructions sent to Claude)
3. Tool definitions (if `tool_use` is involved — either free tool use or a forced tool for output enforcement)
4. Few-shot examples where useful (drawn from `/data/sample_workflows/` or equivalent fixtures)

## Editing the live chat prompt

The chat agent's behavior is governed by `prompts/chat-agent.md`. `api/chat.js` reads it once at module cold start and caches it in module scope; subsequent invocations on the same Vercel function instance use the cached version. To push a prompt change:

1. Edit `prompts/chat-agent.md`.
2. Commit and push — Vercel auto-deploys.
3. Next cold start (or first request to a fresh instance) picks up the new prompt.

The on-the-wire prompt is also Anthropic-prompt-cached, so the deploy + first request pays the full token cost; subsequent requests within the cache TTL are cheap.

A standalone, more readable copy of the persona + domain sections is kept internally.
