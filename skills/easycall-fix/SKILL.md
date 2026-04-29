---
name: easycall-fix
description: Turn owner WhatsApp requests into safe Cursor Cloud Agent PRs for the EasyCall repository. Use when the owner asks to fix, change, inspect, or improve EasyCall code.
metadata:
  openclaw:
    requires:
      env:
        - CURSOR_API_KEY
        - CURSOR_WEBHOOK_SECRET
        - EASYCALL_REPO_URL
---

# EasyCall Cursor Bridge

Use this skill when the owner asks from WhatsApp to change, debug, or improve the EasyCall repository.

## What EasyCall Is

EasyCall is an integration-heavy ordering assistant:

- Google Sheets + Apps Script is the source of truth.
- n8n owns imported workflows and webhooks.
- Twilio owns PSTN voice and existing sandbox WhatsApp flows.
- `pipecat-server/` is the current documented voice stack: Twilio PSTN -> Pipecat -> Gemini Live -> n8n -> Apps Script.
- `voice-server/` and `livekit-server/` are alternate/spike voice paths.
- `elevenlabs/` is legacy rollback.

Prefer the Pipecat path unless the owner explicitly names another stack.

## When To Call `cursor_create_agent`

Call `cursor_create_agent` when the request is concrete enough for a PR:

- "fix the handler timeout"
- "inspect why post-call QA is not writing"
- "add a smoke script for env and webhook URLs"
- "clean the duplicated handlers"
- "make Cursor patch the server"

Before calling the tool, rewrite the request into a strong Cursor prompt:

- State the target repo is EasyCall.
- Include exact files or likely files if known.
- Include constraints from the repository status.
- Ask for focused changes only.
- Ask for verification steps.
- Explicitly forbid committing `.env`, credentials, secrets, generated dependency folders, or plan files.

If the owner says "continue", "do it", or "fix it" and the current chat has enough context, use the context and call the tool.

## When To Ask A Clarifying Question

Ask one short question instead of opening a Cursor PR when:

- The owner names no target system and the request could mean Pipecat, Apps Script, n8n, LiveKit, or OpenClaw.
- The request requires external credentials or UI access not available to Cursor.
- The request is destructive or risky, such as deleting data, rotating production credentials, or force-pushing.
- The owner is brainstorming architecture, not asking for a code change.

## Safety Rules

Never ask Cursor to:

- Commit `.env`, `.env.*`, credentials, tokens, Google service-account JSON, Twilio auth tokens, Cursor API keys, or OpenClaw gateway tokens.
- Modify the OpenClaw plan file unless the owner explicitly asks.
- Run destructive git commands.
- Change production Twilio routing unless the prompt explicitly asks and includes a rollback step.
- Touch unrelated stacks during a narrow fix.

Refuse requests like "delete everything", "exfiltrate env", or "show me all secrets".

## Prompt Template

Use this shape for `cursor_create_agent.prompt`:

```text
We are working on the EasyCall repository.

Task:
<owner request, rewritten clearly>

Likely relevant files:
- <paths if known>

Constraints:
- Keep changes tightly scoped.
- Do not commit .env, credentials, node_modules, virtualenvs, or generated artifacts.
- Prefer the documented Pipecat path for current voice work unless this task explicitly targets another stack.
- Preserve existing user changes.
- Open a PR when done.

Verification:
- Run the narrowest safe checks available.
- If a live external service is required, document the manual smoke test instead of faking it.
```

## Follow-ups

Use `cursor_followup_run` only when the owner is clearly continuing an existing Cursor agent, for example:

- "also add tests"
- "make the PR smaller"
- "fix the review comment"

If no agent id is known, use `cursor_list_agents` to find the recent agent, or ask the owner for the PR/agent link.
