# EasyCall Cursor Bridge for OpenClaw

This OpenClaw plugin lets the EasyCall owner send a WhatsApp message to a dedicated OpenClaw number and turn that message into a Cursor Cloud Agent run that opens a PR on the EasyCall GitHub repo.

## What It Registers

- `cursor_create_agent` — creates a Cursor Cloud Agent and asks it to open a PR.
- `cursor_followup_run` — sends a follow-up prompt to an existing Cursor agent.
- `cursor_get_run` — polls one Cursor run.
- `cursor_list_agents` — lists recent Cursor agents.
- `easycall_voice_qa_start` — starts a manual notify-only voice QA call to EasyCall.
- `easycall_voice_qa_status` — polls an OpenClaw voice-call status/transcript.
- `easycall_voice_qa_report` — stores and optionally notifies the final voice QA report.
- `POST /hooks/cursor` — verifies Cursor webhook signatures and replies to the owner on WhatsApp.

## Required Secrets

Set these only on the Hostinger/OpenClaw VPS. Do not commit real values.

```bash
CURSOR_API_KEY=cur_xxx
CURSOR_WEBHOOK_SECRET=$(openssl rand -hex 32)
CURSOR_WEBHOOK_URL=https://claw.example.com/hooks/cursor
EASYCALL_REPO_URL=https://github.com/your-org/EasyCall
```

Optional:

```bash
EASYCALL_STARTING_REF=main
CURSOR_MODEL_ID=claude-4-sonnet-thinking
OPENCLAW_WHATSAPP_ACCOUNT=default
OPENCLAW_BIN=openclaw
OPENCLAW_BRIDGE_STATE_PATH=/home/openclaw/.openclaw/easycall-cursor-bridge/state.json
# Optional WhatsApp completion notices:
# EASYCALL_OWNER_WAID=+972501234567
EASYCALL_PRODUCTION_NUMBER=+972765993143
# EASYCALL_QA_CALLER_NUMBER=+15551234567
EASYCALL_QA_MAX_DURATION_SECONDS=180
EASYCALL_QA_NOTIFY_MODE=log
EASYCALL_QA_CALL_PROVIDER=voicecall
# Required for EASYCALL_QA_CALL_PROVIDER=twilio_say or twilio_gather:
# TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# TWILIO_AUTH_TOKEN=replace-with-twilio-auth-token
# Required for EASYCALL_QA_CALL_PROVIDER=twilio_gather:
# EASYCALL_QA_PUBLIC_BASE_URL=https://claw.example.com
# GEMINI_API_KEY=replace-with-gemini-api-key
EASYCALL_QA_MAX_TURNS=6
```

## Hostinger / OpenClaw Setup

1. Provision Hostinger KVM 2 with the OpenClaw Docker template.
   If you want to use the API instead of hPanel, first discover catalog/template/data-center IDs:

```bash
HOSTINGER_API_TOKEN=... npm run hostinger -- discover
```

Then dry-run the purchase:

```bash
HOSTINGER_API_TOKEN=... npm run hostinger -- purchase \
  --item-id <catalog-price-item-id> \
  --template-id <openclaw-or-docker-template-id> \
  --data-center-id <frankfurt-or-nearest-id> \
  --hostname claw-easycall
```

Add `--yes` only when the payload is correct and you want Hostinger to charge your default payment method.

2. Install the WhatsApp channel and pair the dedicated WhatsApp number:

```bash
openclaw plugins install @openclaw/whatsapp
openclaw channels login --channel whatsapp
```

3. Configure WhatsApp allowlist in `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+972501234567"]
    }
  }
}
```

4. Install and enable this plugin:

```bash
openclaw plugins install ./openclaw-bridge/easycall-cursor-bridge
openclaw plugins enable easycall-cursor-bridge
openclaw plugins doctor
systemctl restart openclaw
```

5. Put Caddy or another TLS proxy in front of `/hooks/cursor` only. See `config/Caddyfile.example`.

## Manual Voice QA

The bridge can teach OpenClaw to act as a real caller and report how the EasyCall voice agent felt. This is notify-only by default and does not create Cursor PRs.

Install and configure OpenClaw's voice-call plugin separately:

```bash
openclaw plugins install voice-call --dangerously-force-unsafe-install
openclaw plugins enable voice-call
openclaw voicecall setup --json
```

Then ask OpenClaw:

```text
Run EasyCall voice QA as a first-time customer ordering something simple.
```

Expected:

- OpenClaw calls `easycall_voice_qa_start`.
- OpenClaw polls `easycall_voice_qa_status`.
- OpenClaw writes a short subjective report with scores and evidence via `easycall_voice_qa_report`.
- No Cursor PR is created unless Adir explicitly asks after reading the report.

If the OpenClaw `voice-call` plugin cannot keep a working realtime/conversation audio path, set `EASYCALL_QA_CALL_PROVIDER=twilio_gather`. That fallback still runs through this OpenClaw bridge, but it uses Twilio `<Say>` and `<Gather input="speech">` callbacks so OpenClaw can speak as the QA caller, hear EasyCall's reply, generate the next caller turn, and store the transcript. Use `twilio_say` only as a one-line audio sanity check.

## Smoke Test

Validate the Cursor API key first:

```bash
CURSOR_API_KEY=... npm run check:cursor
```

Send this from the allowlisted WhatsApp number:

```text
Cursor, in pipecat-server/handlers.py raise the default HTTP timeout from 10s to 15s. Open a PR.
```

Expected:

- OpenClaw calls `cursor_create_agent`.
- Cursor creates an agent against `EASYCALL_REPO_URL`.
- Cursor opens a PR.
- Cursor posts `FINISHED` to `/hooks/cursor`.
- The plugin verifies `X-Webhook-Signature` and sends the PR URL back on WhatsApp.

## Notes

Cursor Cloud Agents v1 is in public beta. The webhook documentation says agents can be created with a webhook URL, but the visible endpoint schema may lag. This plugin sends the URL under `webhookUrl` by default and keeps the field configurable via `CURSOR_CREATE_AGENT_WEBHOOK_FIELD`. If Cursor changes the request shape, update the env value without changing plugin code.

OpenClaw's runtime state helper is SQLite-backed where available. External plugin availability can vary by OpenClaw release, so the bridge falls back to a local JSON state file at `OPENCLAW_BRIDGE_STATE_PATH`.
