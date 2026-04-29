#!/usr/bin/env node

const apiKey = process.env.CURSOR_API_KEY;

if (!apiKey) {
  console.error("Missing CURSOR_API_KEY. Create it at https://cursor.com/dashboard/integrations");
  process.exit(2);
}

const res = await fetch("https://api.cursor.com/v1/me", {
  headers: {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
  },
});

const text = await res.text();
console.log(`${res.status} ${res.statusText}`);
if (text) console.log(text);
if (!res.ok) process.exit(1);
