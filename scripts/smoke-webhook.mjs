#!/usr/bin/env node
import { createHmac } from "node:crypto";

const url = process.env.CURSOR_WEBHOOK_URL;
const secret = process.env.CURSOR_WEBHOOK_SECRET;

if (!url || !secret) {
  console.error("Usage: CURSOR_WEBHOOK_URL=https://claw.example.com/hooks/cursor CURSOR_WEBHOOK_SECRET=... npm run smoke:webhook");
  process.exit(2);
}

const payload = {
  event: "statusChange",
  timestamp: new Date().toISOString(),
  id: "bc_smoke_easycall",
  status: "FINISHED",
  source: {
    repository: process.env.EASYCALL_REPO_URL || "https://github.com/your-org/EasyCall",
    ref: process.env.EASYCALL_STARTING_REF || "main",
  },
  target: {
    url: "https://cursor.com/agents?id=bc_smoke_easycall",
    branchName: "cursor/smoke-easycall-bridge",
    prUrl: "https://github.com/your-org/EasyCall/pull/0",
  },
  summary: "Smoke test payload from easycall-cursor-bridge.",
};

const raw = Buffer.from(JSON.stringify(payload));
const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Webhook-Signature": signature,
    "X-Webhook-ID": `smoke-${Date.now()}`,
    "X-Webhook-Event": "statusChange",
    "User-Agent": "Cursor-Agent-Webhook/1.0",
  },
  body: raw,
});

const text = await res.text();
console.log(`${res.status} ${res.statusText}`);
if (text) console.log(text);
if (!res.ok) process.exit(1);
