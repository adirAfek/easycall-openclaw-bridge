import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);
const CURSOR_API_BASE = "https://api.cursor.com";
const DEFAULT_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PluginApi = {
  id: string;
  pluginConfig?: Record<string, unknown>;
  runtime?: any;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  registerTool: (tool: unknown, opts?: unknown) => void;
  registerHttpRoute: (route: unknown) => void;
};

type BridgeConfig = {
  cursorApiKey: string;
  cursorWebhookSecret: string;
  cursorWebhookUrl?: string;
  cursorWebhookField: string;
  repoUrl: string;
  startingRef: string;
  modelId?: string;
  ownerWaid: string;
  whatsappAccount?: string;
  openclawBin: string;
  statePath: string;
  easycallProductionNumber: string;
  qaCallerNumber?: string;
  qaMaxDurationSeconds: number;
  qaNotifyMode: "log" | "whatsapp";
};

type CursorCreateAgentParams = {
  prompt: string;
  branchName?: string;
  startingRef?: string;
  modelId?: string;
  autoCreatePR?: boolean;
  ownerWaid?: string;
  dedupeKey?: string;
};

type CursorFollowupParams = {
  agentId: string;
  prompt: string;
};

type CursorGetRunParams = {
  agentId: string;
  runId: string;
};

type CursorListAgentsParams = {
  limit?: number;
};

type VoiceQaStartParams = {
  scenario?: string;
  persona?: string;
  instructions?: string;
  language?: string;
  to?: string;
  maxDurationSeconds?: number;
  dedupeKey?: string;
};

type VoiceQaStatusParams = {
  qaRunId?: string;
  callId?: string;
};

type VoiceQaReportParams = {
  qaRunId?: string;
  callId?: string;
  scenario: string;
  experience: string;
  whatWorked?: string[];
  whatFailed?: string[];
  scores?: {
    understanding?: number;
    latency?: number;
    warmth?: number;
    taskCompletion?: number;
  };
  evidence?: string[];
  recommendedNextTest?: string;
  transcript?: string;
};

type BridgeRecord = {
  kind: "agent" | "run" | "prompt" | "voice_qa";
  agentId?: string;
  runId?: string;
  qaRunId?: string;
  callId?: string;
  status?: string;
  promptHash?: string;
  prompt?: string;
  scenario?: string;
  persona?: string;
  report?: string;
  ownerWaid?: string;
  agentUrl?: string;
  prUrl?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

type StateStore = {
  get(key: string): Promise<BridgeRecord | undefined>;
  set(key: string, value: BridgeRecord): Promise<void>;
  delete(key: string): Promise<void>;
};

export default definePluginEntry({
  id: "easycall-cursor-bridge",
  name: "EasyCall Cursor Bridge",
  description: "Launch Cursor Cloud Agents from OpenClaw chat and report PR results to WhatsApp.",
  register(api: PluginApi) {
    const config = readConfig(api);
    const state = createStateStore(api, config);

    api.registerTool({
      name: "cursor_create_agent",
      description:
        "Open a Cursor Cloud Agent run on the EasyCall GitHub repo. Use when the owner asks for a concrete code fix, bug investigation, or small feature PR.",
      parameters: Type.Object({
        prompt: Type.String({
          minLength: 12,
          description: "The complete Cursor task prompt. Include files, constraints, and expected verification.",
        }),
        branchName: Type.Optional(Type.String({ description: "Optional custom branch name." })),
        startingRef: Type.Optional(Type.String({ description: "Optional branch/tag/commit to start from." })),
        modelId: Type.Optional(Type.String({ description: "Optional Cursor model id." })),
        autoCreatePR: Type.Optional(Type.Boolean({ default: true })),
        ownerWaid: Type.Optional(Type.String({ description: "Override WhatsApp E.164 target for completion notice." })),
        dedupeKey: Type.Optional(Type.String({ description: "Stable caller-provided key to prevent duplicate PRs." })),
      }),
      async execute(_id: string, params: CursorCreateAgentParams) {
        assertConfigured(config, ["cursorApiKey", "repoUrl"]);

        const normalizedPrompt = normalizePrompt(params.prompt);
        const promptHash = params.dedupeKey?.trim() || hashText(normalizedPrompt);
        const promptKey = `prompt:${promptHash}`;
        const existing = await state.get(promptKey);
        if (existing?.agentId) {
          return toolText(
            `Duplicate request ignored. Existing Cursor agent: ${existing.agentUrl ?? existing.agentId}${
              existing.prUrl ? `\nPR: ${existing.prUrl}` : ""
            }`,
          );
        }

        const body: Record<string, unknown> = {
          prompt: { text: buildCursorPrompt(normalizedPrompt) },
          repos: [
            {
              url: config.repoUrl,
              startingRef: params.startingRef?.trim() || config.startingRef,
            },
          ],
          autoCreatePR: params.autoCreatePR ?? true,
          skipReviewerRequest: true,
        };

        const branchName = sanitizeBranchName(params.branchName);
        if (branchName) body.branchName = branchName;

        const modelId = params.modelId?.trim() || config.modelId;
        if (modelId) body.model = { id: modelId };

        // Cursor Cloud Agents v1 is still beta. Keep the webhook field configurable
        // so the VPS can adapt without changing plugin code if the schema shifts.
        if (config.cursorWebhookUrl && config.cursorWebhookField !== "none") {
          body[config.cursorWebhookField] = config.cursorWebhookUrl;
        }

        const result = await cursorFetch(config, "/v1/agents", {
          method: "POST",
          body: JSON.stringify(body),
        });

        const agentId = readNestedString(result, ["agent", "id"]) ?? readString(result, "id");
        const runId = readNestedString(result, ["run", "id"]) ?? readNestedString(result, ["agent", "latestRunId"]);
        const agentUrl = readNestedString(result, ["agent", "url"]);
        const now = new Date().toISOString();
        const ownerWaid = params.ownerWaid?.trim() || config.ownerWaid;

        const record: BridgeRecord = {
          kind: "agent",
          agentId,
          runId,
          status: readNestedString(result, ["run", "status"]) ?? "CREATING",
          promptHash,
          prompt: normalizedPrompt,
          ownerWaid,
          agentUrl,
          createdAt: now,
          updatedAt: now,
        };

        await state.set(promptKey, { ...record, kind: "prompt" });
        if (agentId) await state.set(`agent:${agentId}`, record);
        if (runId) await state.set(`run:${runId}`, { ...record, kind: "run" });

        return toolText(
          [
            "Cursor Cloud Agent created.",
            agentId ? `Agent: ${agentId}` : undefined,
            runId ? `Run: ${runId}` : undefined,
            agentUrl ? `URL: ${agentUrl}` : undefined,
            config.cursorWebhookUrl ? "Webhook: enabled" : "Webhook: not configured; use cursor_get_run to poll.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    });

    api.registerTool({
      name: "cursor_followup_run",
      description: "Send a follow-up prompt to an existing Cursor Cloud Agent.",
      parameters: Type.Object({
        agentId: Type.String({ minLength: 3 }),
        prompt: Type.String({ minLength: 4 }),
      }),
      async execute(_id: string, params: CursorFollowupParams) {
        assertConfigured(config, ["cursorApiKey"]);
        const result = await cursorFetch(config, `/v1/agents/${encodeURIComponent(params.agentId)}/runs`, {
          method: "POST",
          body: JSON.stringify({ prompt: { text: params.prompt } }),
        });

        const runId = readString(result, "id") ?? readNestedString(result, ["run", "id"]);
        const existing = await state.get(`agent:${params.agentId}`);
        const now = new Date().toISOString();
        if (runId) {
          await state.set(`run:${runId}`, {
            kind: "run",
            agentId: params.agentId,
            runId,
            status: readString(result, "status") ?? readNestedString(result, ["run", "status"]),
            ownerWaid: existing?.ownerWaid ?? config.ownerWaid,
            agentUrl: existing?.agentUrl,
            createdAt: now,
            updatedAt: now,
          });
        }

        return toolText(`Follow-up run created${runId ? `: ${runId}` : "."}`);
      },
    });

    api.registerTool({
      name: "cursor_get_run",
      description: "Read a Cursor Cloud Agent run status.",
      parameters: Type.Object({
        agentId: Type.String({ minLength: 3 }),
        runId: Type.String({ minLength: 3 }),
      }),
      async execute(_id: string, params: CursorGetRunParams) {
        assertConfigured(config, ["cursorApiKey"]);
        const result = await cursorFetch(
          config,
          `/v1/agents/${encodeURIComponent(params.agentId)}/runs/${encodeURIComponent(params.runId)}`,
          { method: "GET" },
        );
        return toolJson(result);
      },
    });

    api.registerTool({
      name: "cursor_list_agents",
      description: "List recent Cursor Cloud Agents for the configured Cursor account.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25, default: 10 })),
      }),
      async execute(_id: string, params: CursorListAgentsParams) {
        assertConfigured(config, ["cursorApiKey"]);
        const url = params.limit ? `/v1/agents?limit=${encodeURIComponent(String(params.limit))}` : "/v1/agents";
        const result = await cursorFetch(config, url, { method: "GET" });
        return toolJson(result);
      },
    });

    api.registerTool({
      name: "easycall_voice_qa_start",
      description:
        "Start a manual notify-only voice QA call to the EasyCall production phone agent. Use for experience testing, not for creating PRs.",
      parameters: Type.Object({
        scenario: Type.Optional(Type.String({ description: "What the tester is trying to do on the call." })),
        persona: Type.Optional(Type.String({ description: "Customer persona to act as during the call." })),
        instructions: Type.Optional(Type.String({ description: "Extra tester behavior, e.g. interrupt, pause, Hebrew/English mix." })),
        language: Type.Optional(Type.String({ description: "Preferred call language, e.g. Hebrew, English, Hebrew-English mix." })),
        to: Type.Optional(Type.String({ description: "Override EasyCall target number. Defaults to configured production number." })),
        maxDurationSeconds: Type.Optional(Type.Number({ minimum: 30, maximum: 600 })),
        dedupeKey: Type.Optional(Type.String({ description: "Optional stable key for state correlation." })),
      }),
      async execute(_id: string, params: VoiceQaStartParams) {
        assertConfigured(config, ["easycallProductionNumber"]);

        const scenario = params.scenario?.trim() || "First-time customer placing a simple restaurant order.";
        const persona = params.persona?.trim() || "A polite but realistic customer who wants the call to feel easy.";
        const language = params.language?.trim() || "Use the language that feels natural for the EasyCall agent; Hebrew-English mix is allowed.";
        const target = params.to?.trim() || config.easycallProductionNumber;
        const maxDuration = Math.min(
          600,
          Math.max(30, Math.round(params.maxDurationSeconds ?? config.qaMaxDurationSeconds)),
        );
        const qaRunId = `voiceqa_${hashText(`${Date.now()}:${scenario}:${persona}`).slice(0, 12)}`;
        const message = buildVoiceQaCallMessage({ scenario, persona, language, instructions: params.instructions, maxDuration });

        const result = await runOpenClawVoiceCommand(config, [
          "voicecall",
          "call",
          "--to",
          target,
          "--message",
          message,
          "--mode",
          "conversation",
          "--json",
        ]);

        const callId = readString(result, "callId") ??
          readString(result, "id") ??
          readNestedString(result, ["call", "id"]) ??
          readNestedString(result, ["data", "callId"]);
        const status = readString(result, "status") ??
          readNestedString(result, ["call", "status"]) ??
          readNestedString(result, ["data", "status"]) ??
          "started";
        const now = new Date().toISOString();
        const record: BridgeRecord = {
          kind: "voice_qa",
          qaRunId,
          callId,
          status,
          scenario,
          persona,
          createdAt: now,
          updatedAt: now,
        };

        await state.set(`voice_qa:${qaRunId}`, record);
        if (callId) await state.set(`voice_call:${callId}`, record);

        return toolText(
          [
            "EasyCall voice QA call started.",
            `QA run: ${qaRunId}`,
            callId ? `Call: ${callId}` : "Call id: not returned by voicecall CLI; use recent voice-call status/logs.",
            `Target: ${redactPhone(target)}`,
            `Scenario: ${scenario}`,
            `Persona: ${persona}`,
            "Reminder: notify-only. Do not create a Cursor PR from this QA run.",
          ].join("\n"),
        );
      },
    });

    api.registerTool({
      name: "easycall_voice_qa_status",
      description: "Poll a manual EasyCall voice QA call and return status/transcript data when available.",
      parameters: Type.Object({
        qaRunId: Type.Optional(Type.String({ description: "QA run id returned by easycall_voice_qa_start." })),
        callId: Type.Optional(Type.String({ description: "OpenClaw voice-call id." })),
      }),
      async execute(_id: string, params: VoiceQaStatusParams) {
        const existing = params.qaRunId ? await state.get(`voice_qa:${params.qaRunId}`) : undefined;
        const callId = params.callId?.trim() || existing?.callId;
        if (!callId) {
          return toolText("No call id is known yet. Check OpenClaw voice-call logs, or start a new QA call.");
        }

        const result = await runOpenClawVoiceCommand(config, ["voicecall", "status", "--call-id", callId, "--json"]);
        const status = readString(result, "status") ??
          readNestedString(result, ["call", "status"]) ??
          readNestedString(result, ["data", "status"]);
        const transcript = readTranscript(result);
        const now = new Date().toISOString();
        const qaRunId = params.qaRunId || existing?.qaRunId || `voiceqa_${hashText(callId).slice(0, 12)}`;

        await state.set(`voice_qa:${qaRunId}`, {
          ...(existing ?? {
            kind: "voice_qa",
            qaRunId,
            callId,
            createdAt: now,
          }),
          status: status || existing?.status,
          summary: transcript ? transcript.slice(0, 1800) : existing?.summary,
          updatedAt: now,
        });

        return toolJson({
          qaRunId,
          callId,
          status,
          terminal: isTerminalCallStatus(status),
          transcript,
          raw: result,
        });
      },
    });

    api.registerTool({
      name: "easycall_voice_qa_report",
      description:
        "Store and optionally notify the final EasyCall voice QA report. This is notify-only and must not create Cursor PRs.",
      parameters: Type.Object({
        qaRunId: Type.Optional(Type.String()),
        callId: Type.Optional(Type.String()),
        scenario: Type.String({ minLength: 4 }),
        experience: Type.String({ minLength: 8 }),
        whatWorked: Type.Optional(Type.Array(Type.String())),
        whatFailed: Type.Optional(Type.Array(Type.String())),
        scores: Type.Optional(Type.Object({
          understanding: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
          latency: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
          warmth: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
          taskCompletion: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
        })),
        evidence: Type.Optional(Type.Array(Type.String())),
        recommendedNextTest: Type.Optional(Type.String()),
        transcript: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: VoiceQaReportParams) {
        const qaRunId = params.qaRunId?.trim() || (params.callId ? `voiceqa_${hashText(params.callId).slice(0, 12)}` : `voiceqa_${hashText(params.scenario).slice(0, 12)}`);
        const existing = await state.get(`voice_qa:${qaRunId}`);
        const report = formatVoiceQaReport(params);
        const now = new Date().toISOString();

        await state.set(`voice_qa:${qaRunId}`, {
          ...(existing ?? {
            kind: "voice_qa",
            qaRunId,
            callId: params.callId,
            createdAt: now,
          }),
          status: "reported",
          scenario: params.scenario,
          report,
          summary: params.transcript?.slice(0, 1800),
          updatedAt: now,
        });

        if (config.qaNotifyMode === "whatsapp" && config.ownerWaid) {
          await sendWhatsapp(config, config.ownerWaid, report);
        } else {
          api.logger?.info?.("[easycall-cursor-bridge] voice QA report", { qaRunId, report });
        }

        return toolText(report);
      },
    });

    api.registerHttpRoute({
      path: "/hooks/cursor",
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: async (req: any, res: any) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          res.end("Method Not Allowed");
          return true;
        }

        let rawBody: Buffer;
        try {
          rawBody = await readRawBody(req, 1024 * 1024);
        } catch (error) {
          res.statusCode = 413;
          res.end(JSON.stringify({ ok: false, error: errorText(error) }));
          return true;
        }

        const signature = String(req.headers?.["x-webhook-signature"] ?? "");
        if (!verifyCursorSignature(config.cursorWebhookSecret, rawBody, signature)) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: "invalid signature" }));
          return true;
        }

        let payload: any;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "invalid json" }));
          return true;
        }

        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true }));

        void handleCursorWebhook(api, config, state, payload).catch((error) => {
          api.logger?.error?.("[easycall-cursor-bridge] webhook handling failed", errorText(error));
        });
        return true;
      },
    });
  },
});

function readConfig(api: PluginApi): BridgeConfig {
  const pluginConfig = api.pluginConfig ?? {};
  const home = process.env.HOME || "/tmp";
  return {
    cursorApiKey: readConfigString(pluginConfig, "cursorApiKey", "CURSOR_API_KEY"),
    cursorWebhookSecret: readConfigString(pluginConfig, "cursorWebhookSecret", "CURSOR_WEBHOOK_SECRET"),
    cursorWebhookUrl: readConfigString(pluginConfig, "cursorWebhookUrl", "CURSOR_WEBHOOK_URL", false),
    cursorWebhookField:
      readConfigString(pluginConfig, "cursorWebhookField", "CURSOR_CREATE_AGENT_WEBHOOK_FIELD", false) ||
      "webhookUrl",
    repoUrl: readConfigString(pluginConfig, "repoUrl", "EASYCALL_REPO_URL"),
    startingRef: readConfigString(pluginConfig, "startingRef", "EASYCALL_STARTING_REF", false) || "main",
    modelId: readConfigString(pluginConfig, "modelId", "CURSOR_MODEL_ID", false),
    ownerWaid: readConfigString(pluginConfig, "ownerWaid", "EASYCALL_OWNER_WAID"),
    whatsappAccount: readConfigString(pluginConfig, "whatsappAccount", "OPENCLAW_WHATSAPP_ACCOUNT", false),
    openclawBin: readConfigString(pluginConfig, "openclawBin", "OPENCLAW_BIN", false) || "openclaw",
    statePath:
      readConfigString(pluginConfig, "statePath", "OPENCLAW_BRIDGE_STATE_PATH", false) ||
      join(home, ".openclaw", "easycall-cursor-bridge", "state.json"),
    easycallProductionNumber:
      readConfigString(pluginConfig, "easycallProductionNumber", "EASYCALL_PRODUCTION_NUMBER", false) ||
      "+972765993143",
    qaCallerNumber: readConfigString(pluginConfig, "qaCallerNumber", "EASYCALL_QA_CALLER_NUMBER", false),
    qaMaxDurationSeconds: readConfigNumber(pluginConfig, "qaMaxDurationSeconds", "EASYCALL_QA_MAX_DURATION_SECONDS", 180),
    qaNotifyMode:
      readConfigString(pluginConfig, "qaNotifyMode", "EASYCALL_QA_NOTIFY_MODE", false) === "whatsapp"
        ? "whatsapp"
        : "log",
  };
}

function readConfigString(
  pluginConfig: Record<string, unknown>,
  key: string,
  envName: string,
  required = true,
): string {
  const value = pluginConfig[key] ?? process.env[envName];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) return "";
  return "";
}

function readConfigNumber(
  pluginConfig: Record<string, unknown>,
  key: string,
  envName: string,
  defaultValue: number,
): number {
  const raw = pluginConfig[key] ?? process.env[envName];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  return Number.isFinite(value) ? value : defaultValue;
}

function assertConfigured(config: BridgeConfig, keys: Array<keyof BridgeConfig>): void {
  const missing = keys.filter((key) => !String(config[key] ?? "").trim());
  if (missing.length) {
    throw new Error(`easycall-cursor-bridge missing configuration: ${missing.join(", ")}`);
  }
}

function createStateStore(api: PluginApi, config: BridgeConfig): StateStore {
  const runtimeState = api.runtime?.state;
  const openKeyedStore = runtimeState?.openKeyedStore;
  if (typeof openKeyedStore === "function") {
    const store = openKeyedStore.call(runtimeState, {
      namespace: "easycall-cursor-bridge",
      maxEntries: 1000,
      defaultTtlMs: DEFAULT_STATE_TTL_MS,
    });
    return {
      async get(key) {
        return (await store.lookup(key)) ?? undefined;
      },
      async set(key, value) {
        await store.register(key, value);
      },
      async delete(key) {
        if (typeof store.consume === "function") await store.consume(key);
      },
    };
  }

  return {
    async get(key) {
      const state = await readJsonState(config.statePath);
      return state[key];
    },
    async set(key, value) {
      const state = await readJsonState(config.statePath);
      state[key] = value;
      await writeJsonState(config.statePath, state);
    },
    async delete(key) {
      const state = await readJsonState(config.statePath);
      delete state[key];
      await writeJsonState(config.statePath, state);
    },
  };
}

async function readJsonState(path: string): Promise<Record<string, BridgeRecord>> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJsonState(path: string, state: Record<string, BridgeRecord>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

async function cursorFetch(config: BridgeConfig, path: string, init: RequestInit): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Basic ${Buffer.from(`${config.cursorApiKey}:`).toString("base64")}`);
  headers.set("Content-Type", "application/json");

  const res = await fetch(`${CURSOR_API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const payload = text ? safeJson(text) : {};
  if (!res.ok) {
    throw new Error(`Cursor API ${res.status}: ${typeof payload === "object" ? JSON.stringify(payload) : text}`);
  }
  return payload;
}

function buildCursorPrompt(userPrompt: string): string {
  return [
    "You are working on the EasyCall repository.",
    "",
    "Rules:",
    "- Keep changes tightly scoped to the user's request.",
    "- Do not commit secrets, .env files, credentials, or generated dependency folders.",
    "- Prefer the documented Pipecat path for current voice work unless the task explicitly targets another stack.",
    "- Open a PR when the task is complete and include a concise test plan.",
    "",
    "User request:",
    userPrompt,
  ].join("\n");
}

async function handleCursorWebhook(
  api: PluginApi,
  config: BridgeConfig,
  state: StateStore,
  payload: any,
): Promise<void> {
  const agentId = readString(payload, "id");
  const status = readString(payload, "status") ?? "UNKNOWN";
  const summary = readString(payload, "summary");
  const prUrl = readNestedString(payload, ["target", "prUrl"]);
  const agentUrl = readNestedString(payload, ["target", "url"]);
  const branchName = readNestedString(payload, ["target", "branchName"]);
  const existing = agentId ? await state.get(`agent:${agentId}`) : undefined;
  const ownerWaid = existing?.ownerWaid || config.ownerWaid;

  if (agentId) {
    const now = new Date().toISOString();
    await state.set(`agent:${agentId}`, {
      kind: "agent",
      agentId,
      runId: existing?.runId,
      status,
      promptHash: existing?.promptHash,
      prompt: existing?.prompt,
      ownerWaid,
      agentUrl: agentUrl || existing?.agentUrl,
      prUrl: prUrl || existing?.prUrl,
      summary,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
  }

  if (status !== "FINISHED" && status !== "ERROR") return;

  const lines = status === "FINISHED"
    ? [
        "Cursor finished the EasyCall task.",
        summary ? `Summary: ${summary}` : undefined,
        prUrl ? `PR: ${prUrl}` : undefined,
        branchName ? `Branch: ${branchName}` : undefined,
        !prUrl && agentUrl ? `Agent: ${agentUrl}` : undefined,
      ]
    : [
        "Cursor hit an error on the EasyCall task.",
        summary ? `Summary: ${summary}` : undefined,
        agentUrl ? `Agent: ${agentUrl}` : undefined,
      ];

  if (ownerWaid) {
    await sendWhatsapp(config, ownerWaid, lines.filter(Boolean).join("\n"));
    api.logger?.info?.("[easycall-cursor-bridge] sent webhook notification", { status, agentId, prUrl });
  } else {
    api.logger?.info?.("[easycall-cursor-bridge] webhook processed without ownerWaid", {
      status,
      agentId,
      prUrl,
      summary,
    });
  }
}

async function sendWhatsapp(config: BridgeConfig, target: string, message: string): Promise<void> {
  const args = ["message", "send", "--channel", "whatsapp", "--target", target, "--message", message];
  if (config.whatsappAccount) args.splice(4, 0, "--account", config.whatsappAccount);
  await execFileAsync(config.openclawBin, args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

async function runOpenClawVoiceCommand(config: BridgeConfig, args: string[]): Promise<any> {
  const { stdout, stderr } = await execFileAsync(config.openclawBin, args, {
    timeout: Math.max(60_000, (config.qaMaxDurationSeconds + 30) * 1000),
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = stdout.trim() || stderr.trim();
  return text ? safeJson(text) : {};
}

function buildVoiceQaCallMessage(params: {
  scenario: string;
  persona: string;
  language: string;
  instructions?: string;
  maxDuration: number;
}): string {
  return [
    "You are OpenClaw running a manual notify-only QA call against EasyCall, a restaurant voice ordering agent.",
    "",
    `Persona: ${params.persona}`,
    `Scenario: ${params.scenario}`,
    `Language: ${params.language}`,
    params.instructions?.trim() ? `Extra behavior: ${params.instructions.trim()}` : undefined,
    "",
    "During the call, act like a real customer. Try to complete the scenario naturally.",
    "Notice latency, warmth, understanding, interruptions, and whether the task is completed.",
    `Keep the call under ${params.maxDuration} seconds.`,
    "After the call, do not create a PR. Use easycall_voice_qa_report with your experience and evidence.",
  ]
    .filter(Boolean)
    .join("\n");
}

function readTranscript(result: any): string | undefined {
  const direct = readString(result, "transcript") ?? readNestedString(result, ["call", "transcript"]);
  if (direct) return direct;
  const transcript = result?.transcript ?? result?.call?.transcript ?? result?.data?.transcript;
  if (!Array.isArray(transcript)) return undefined;
  return transcript
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const speaker = readString(entry, "speaker") ?? readString(entry, "role") ?? "unknown";
      const text = readString(entry, "text") ?? readString(entry, "content");
      return text ? `${speaker}: ${text}` : undefined;
    })
    .filter(Boolean)
    .join("\n");
}

function isTerminalCallStatus(status?: string): boolean {
  if (!status) return false;
  return ["completed", "failed", "busy", "no-answer", "no_answer", "canceled", "cancelled", "ended"].includes(
    status.toLowerCase(),
  );
}

function formatVoiceQaReport(params: VoiceQaReportParams): string {
  const scores = params.scores ?? {};
  return [
    "EasyCall Voice QA",
    "",
    "Scenario:",
    params.scenario,
    "",
    "Experience:",
    params.experience,
    "",
    "What worked:",
    formatList(params.whatWorked, "No clear positives captured."),
    "",
    "What failed/confused me:",
    formatList(params.whatFailed, "None obvious."),
    "",
    "Scores:",
    `- Understanding: ${formatScore(scores.understanding)}`,
    `- Latency: ${formatScore(scores.latency)}`,
    `- Warmth: ${formatScore(scores.warmth)}`,
    `- Task completion: ${formatScore(scores.taskCompletion)}`,
    "",
    "Evidence:",
    formatList(params.evidence, "No transcript evidence captured."),
    "",
    "Recommended next test:",
    params.recommendedNextTest?.trim() || "Repeat this scenario with one extra customer interruption.",
  ].join("\n");
}

function formatList(values: string[] | undefined, fallback: string): string {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return cleaned.length ? cleaned.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function formatScore(value?: number): string {
  return Number.isFinite(value) ? `${value}/5` : "not scored";
}

function redactPhone(value: string): string {
  return value.length > 4 ? `${value.slice(0, 4)}***${value.slice(-3)}` : "***";
}

async function readRawBody(req: AsyncIterable<Buffer>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function verifyCursorSignature(secret: string, rawBody: Buffer, signature: string): boolean {
  if (!secret || !signature.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function normalizePrompt(value: string): string {
  return value.trim().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function sanitizeBranchName(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readString(obj: any, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNestedString(obj: any, path: string[]): string | undefined {
  let current = obj;
  for (const key of path) current = current?.[key];
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function toolText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function toolJson(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return toolText(JSON.stringify(value, null, 2));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
