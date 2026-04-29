---
name: easycall-voice-qa
description: Manually call the EasyCall production voice agent, experience it as a real customer, and report subjective and technical QA findings without creating PRs.
metadata:
  openclaw:
    requires:
      env:
        - EASYCALL_PRODUCTION_NUMBER
---

# EasyCall Voice QA

Use this skill when Adir asks you to test the EasyCall voice agent, call the agent, run a voice QA, or say how the agent feels.

## Mission

EasyCall is a restaurant ordering voice agent. The goal is to make the agent feel like the best possible phone worker:

- Fast to answer and low-latency.
- Warm, calm, and confident.
- Accurate about client lookup, menu/order details, and next steps.
- Natural in Hebrew, English, and mixed phrasing.
- Resilient when the caller is confused, changes their mind, interrupts, pauses, or gives incomplete information.

The current production phone target is the EasyCall PSTN number configured by the bridge. Treat it as a real production call.

## Safety

This workflow is notify-only.

- Do not call `cursor_create_agent`.
- Do not create a PR.
- Do not ask Cursor to fix anything.
- Do not change Twilio routing or production configuration.
- Do not reveal secrets, API keys, gateway tokens, or auth headers.

If the call exposes a serious production bug, report it clearly and ask Adir whether to open a Cursor task.

## How To Run A Manual QA Call

1. Pick one realistic scenario unless Adir gave a specific one.
2. Call `easycall_voice_qa_start`.
3. Poll with `easycall_voice_qa_status` until the call is completed, failed, busy, no-answer, canceled, or otherwise terminal.
4. Write a concise experience report.
5. Store and notify with `easycall_voice_qa_report`.

## Suggested Personas

Rotate between these over time:

- First-time customer who wants a simple order.
- Returning customer who expects the system to know them.
- Confused customer who asks what the restaurant has.
- Customer who changes one item after already ordering.
- Caller who mixes Hebrew and English.
- Caller who pauses or gives incomplete details.
- Caller who interrupts while the agent is speaking.

## Report Format

Use this exact structure:

```text
EasyCall Voice QA

Scenario:
<who you pretended to be and what you tried to do>

Experience:
<how the call felt in plain language>

What worked:
- <short point>

What failed/confused me:
- <short point, or "None obvious">

Scores:
- Understanding: <1-5>
- Latency: <1-5>
- Warmth: <1-5>
- Task completion: <1-5>

Evidence:
- <transcript snippet or timestamp>

Recommended next test:
<one useful follow-up scenario>
```

Keep the tone honest and practical. The most valuable output is not just whether the call technically worked, but whether it felt like a great ordering experience.
