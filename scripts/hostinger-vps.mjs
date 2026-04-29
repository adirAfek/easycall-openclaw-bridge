#!/usr/bin/env node

const API_BASE = "https://developers.hostinger.com";
const token = process.env.HOSTINGER_API_TOKEN;
const command = process.argv[2] || "help";

if (!token) {
  console.error("Missing HOSTINGER_API_TOKEN. Generate it in hPanel -> Account information -> API -> New token.");
  process.exit(2);
}

const args = parseArgs(process.argv.slice(3));

if (command === "help") {
  printHelp();
} else if (command === "discover") {
  await discover();
} else if (command === "purchase") {
  await purchase(args);
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

async function discover() {
  const [catalog, dataCenters, templates, virtualMachines] = await Promise.all([
    hostinger("/api/billing/v1/catalog?category=VPS&name=KVM%202*"),
    hostinger("/api/vps/v1/data-centers"),
    hostinger("/api/vps/v1/templates"),
    hostinger("/api/vps/v1/virtual-machines"),
  ]);

  console.log(JSON.stringify({ catalog, dataCenters, templates, virtualMachines }, null, 2));
}

async function purchase(args) {
  const required = ["item-id", "template-id", "data-center-id", "hostname"];
  const missing = required.filter((key) => !args[key]);
  if (missing.length) {
    console.error(`Missing required flags: ${missing.map((key) => `--${key}`).join(", ")}`);
    printHelp();
    process.exit(2);
  }

  const body = {
    item_id: args["item-id"],
    setup: {
      template_id: Number(args["template-id"]),
      data_center_id: Number(args["data-center-id"]),
      hostname: args.hostname,
      enable_backups: args["enable-backups"] !== "false",
      install_monarx: args["install-monarx"] === "true",
    },
  };

  if (args["payment-method-id"]) body.payment_method_id = Number(args["payment-method-id"]);
  if (args.password) body.setup.password = args.password;
  if (args["public-key-name"] && args["public-key"]) {
    body.setup.public_key = {
      name: args["public-key-name"],
      key: args["public-key"],
    };
  }

  if (args.yes !== "true") {
    console.log("Dry run. Add --yes to purchase using your Hostinger default payment method.");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const result = await hostinger("/api/vps/v1/virtual-machines", {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function hostinger(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  const payload = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new Error(`Hostinger API ${res.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
  return payload;
}

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function printHelp() {
  console.log(`Usage:
  HOSTINGER_API_TOKEN=... node scripts/hostinger-vps.mjs discover

  HOSTINGER_API_TOKEN=... node scripts/hostinger-vps.mjs purchase \\
    --item-id <catalog-price-item-id> \\
    --template-id <openclaw-or-docker-template-id> \\
    --data-center-id <frankfurt-or-nearest-id> \\
    --hostname claw-easycall \\
    [--payment-method-id <id>] \\
    [--password <strong-root-password>] \\
    [--enable-backups true] \\
    [--yes]

Without --yes, purchase is a dry run.`);
}
