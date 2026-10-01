// Claude Home add-on server.
//   POST /conversation  -> used by the HA custom component (Assist agent)
//   POST /mcp           -> MCP endpoint (tool: ask_home) for remote Claude Code
//   GET  /health
// Every request runs `claude -p` (Claude Code, logged in with your subscription)
// with only the HA MCP tools + one Opus planner subagent available.
import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const env = process.env;
const cfg = {
  port: Number(env.PORT || 8099),
  apiToken: env.API_TOKEN || "",
  claudeBin: env.CLAUDE_BIN || "claude",
  mainModel: env.MAIN_MODEL || "haiku",
  plannerModel: env.PLANNER_MODEL || "opus",
  idleMs: Number(env.SESSION_IDLE_MINUTES || 15) * 60_000,
  timeoutMs: Number(env.REQUEST_TIMEOUT_S || 120) * 1000,
  mcpConfig: env.MCP_CONFIG || "/data/mcp.json",
  workDir: env.WORK_DIR || "/data/work",
  extra: env.EXTRA_INSTRUCTIONS || "",
};

if (!cfg.apiToken) {
  console.error("API_TOKEN is required");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const SYSTEM_PROMPT = `You are the voice/chat assistant of a home, running inside Home Assistant.
Use the Home Assistant tools (mcp__ha__*) to read states and control devices.
Handle simple, direct commands yourself. Delegate to the "home-planner" agent anything multi-step,
ambiguous, conditional, involving several rooms/devices, or needing troubleshooting/reasoning.
Replies are often spoken: answer in one or two short sentences, plain text, no markdown, no lists.
Reply in the language the user used. If you need clarification, ask one short question.
${cfg.extra}`.trim();

const AGENTS = JSON.stringify({
  "home-planner": {
    description:
      "Use for multi-step or ambiguous home requests: scenes across rooms, conditional logic, reasoning about current states, troubleshooting, or anything needing more than one or two tool calls. Not for single direct commands.",
    prompt:
      "You plan and execute complex Home Assistant requests with the Home Assistant tools. Check current states before acting when it matters. Be precise. Finish with a one-sentence summary of what you did or found.",
    model: cfg.plannerModel,
  },
});

// ---- sessions: external conversation id -> Claude Code session id ----------
const sessions = new Map(); // key -> { sid, last }
const queues = new Map(); // key -> promise chain (serialize turns per conversation)

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.last > cfg.idleMs) sessions.delete(k);
}, 60_000).unref();

function runClaude(text, sid) {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", cfg.mainModel,
    "--tools", "Agent", // only built-in tool: subagents. No Bash/Edit/Read/Web.
    "--mcp-config", cfg.mcpConfig,
    "--strict-mcp-config",
    "--allowedTools", "mcp__ha", "Agent",
    "--permission-mode", "dontAsk", // anything not allowed is denied, never prompted
    "--agents", AGENTS,
    "--append-system-prompt", SYSTEM_PROMPT,
  ];
  if (sid) args.push("--resume", sid);

  return new Promise((resolve, reject) => {
    const p = spawn(cfg.claudeBin, args, { cwd: cfg.workDir, env });
    let out = "", err = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error(`claude timed out after ${cfg.timeoutMs / 1000}s`));
    }, cfg.timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      let r;
      try { r = JSON.parse(out); } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 500)}`));
      }
      if (r.is_error) return reject(new Error(r.result || r.subtype || "claude error"));
      resolve({ text: String(r.result ?? "").trim(), sid: r.session_id, cost: r.total_cost_usd, ms: r.duration_ms });
    });
    p.stdin.end(text);
  });
}

async function ask(key, text) {
  const prev = queues.get(key) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const existing = sessions.get(key);
    const fresh = !existing || Date.now() - existing.last > cfg.idleMs;
    let r;
    try {
      r = await runClaude(text, fresh ? undefined : existing.sid);
    } catch (e) {
      if (fresh) throw e;
      log(`resume failed for ${key}, starting fresh: ${e.message}`);
      r = await runClaude(text, undefined);
    }
    sessions.set(key, { sid: r.sid, last: Date.now() });
    log(`[${key}] ${r.ms ?? "?"}ms ${JSON.stringify(text).slice(0, 80)} -> ${JSON.stringify(r.text).slice(0, 80)}`);
    return r;
  });
  queues.set(key, job);
  try { return await job; } finally { if (queues.get(key) === job) queues.delete(key); }
}

// ---- MCP endpoint for remote Claude Code ------------------------------------
function buildMcp() {
  const server = new McpServer({ name: "claude-home", version: "0.1.0" });
  server.registerTool(
    "ask_home",
    {
      description:
        "Ask the home's Claude agent (inside Home Assistant) to do or check something in the house: control devices, read states, run multi-step routines. Pass conversation_id from a previous result to continue that conversation.",
      inputSchema: {
        prompt: z.string().describe("What to do or ask, in natural language"),
        conversation_id: z.string().optional().describe("Continue a previous conversation"),
      },
    },
    async ({ prompt, conversation_id }) => {
      const key = `mcp:${conversation_id || crypto.randomUUID()}`;
      try {
        const r = await ask(key, prompt);
        return { content: [{ type: "text", text: `${r.text}\n\n[conversation_id: ${key.slice(4)}]` }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    },
  );
  return server;
}

// ---- HTTP --------------------------------------------------------------------
function authorized(req) {
  const h = req.headers.authorization || "";
  const a = Buffer.from(h.replace(/^Bearer\s+/i, ""));
  const b = Buffer.from(cfg.apiToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let body = "";
  for await (const c of req) {
    body += c;
    if (body.length > 1_000_000) throw new Error("body too large");
  }
  return body ? JSON.parse(body) : undefined;
}

const send = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/health") return send(res, 200, { ok: true, sessions: sessions.size });
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

      if (url.pathname === "/conversation" && req.method === "POST") {
        const { text, conversation_id } = (await readJson(req)) || {};
        if (!text) return send(res, 400, { error: "text required" });
        const r = await ask(`ha:${conversation_id || crypto.randomUUID()}`, text);
        return send(res, 200, { speech: r.text });
      }

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        const body = await readJson(req);
        const server = buildMcp();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        return transport.handleRequest(req, res, body);
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      log("error:", e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  })
  .listen(cfg.port, () => log(`claude-home listening on :${cfg.port} (main=${cfg.mainModel}, planner=${cfg.plannerModel})`));
