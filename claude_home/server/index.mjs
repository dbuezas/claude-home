// Claude Home add-on server.
//   :8099 (API, bearer token)
//     POST /conversation  -> used by the HA custom component (Assist agent)
//     GET  /health
//   :8098 (Ingress web UI, only reachable through Home Assistant) -> see ui.mjs
//   127.0.0.1:8097 (passcode-gated admin tools, per-turn token) -> see admin.mjs
// Every request runs `claude -p` (Claude Code, logged in with your subscription)
// with only the HA MCP tools (+ the admin proposal tools, if passcodes are set).
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { supervisor, readOptions, writeOptions } from "./ha.mjs";
import { timingSafeEqual } from "node:crypto";
import { startUi } from "./ui.mjs";
import { createAdmin } from "./admin.mjs";

const env = process.env;
const cfg = {
  port: Number(env.PORT || 8099),
  uiPort: Number(env.UI_PORT || 8098),
  adminPort: Number(env.ADMIN_PORT || 8097),
  apiToken: env.API_TOKEN || "",
  claudeBin: env.CLAUDE_BIN || "claude",
  mcpConfig: env.MCP_CONFIG || "/data/mcp.json",
  workDir: env.WORK_DIR || "/data/work",
  optionsFile: env.OPTIONS_FILE || "/data/options.json",
};

if (!cfg.apiToken) {
  console.error("API_TOKEN is required");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Add-on options are read on every request, so changes from the web UI or the
// Configuration tab apply without a restart (except the Claude token).
function settings() {
  let o = {};
  try { o = JSON.parse(readFileSync(cfg.optionsFile, "utf8")); } catch {}
  return {
    mainModel: o.main_model || "opus",
    idleMs: Number(o.session_idle_minutes || 15) * 60_000,
    timeoutMs: Number(o.request_timeout || 120) * 1000,
    effort: o.effort && o.effort !== "default" ? o.effort : o.effort === "default" ? "" : "low",
    extra: o.extra_instructions || "",
  };
}

const admin = createAdmin({ cfg, log });

const systemPrompt = (s) => `You are the voice/chat assistant of a home, running inside Home Assistant.
Use the Home Assistant tools (mcp__ha__*) to read states and control devices.
Replies are often spoken: answer in one or two short sentences, plain text, no markdown, no lists.
Reply in the language the user used. If you need clarification, ask one short question.${admin.systemPromptPart()}
${s.extra}`.trim();

// HA's MCP server (from mcp.json) plus any per-turn servers, as an inline --mcp-config.
function mcpConfig(extra) {
  const base = JSON.parse(readFileSync(cfg.mcpConfig, "utf8"));
  return JSON.stringify({ mcpServers: { ...base.mcpServers, ...extra } });
}


// ---- sessions: external conversation id -> Claude Code session id ----------
const sessions = new Map(); // key -> { sid, last }
const queues = new Map(); // key -> promise chain (serialize turns per conversation)

setInterval(() => {
  const now = Date.now(), { idleMs } = settings();
  for (const [k, s] of sessions) if (now - s.last > idleMs) sessions.delete(k);
}, 60_000).unref();

function runClaude(text, sid, extraServers = {}) {
  const s = settings();
  const args = [
    "-p",
    "--output-format", "json",
    "--verbose", // full message list, so we can see which tools ran
    "--model", s.mainModel,
    "--tools", "", // no built-in tools at all: no Bash/Edit/Read/Web/subagents
    "--mcp-config", mcpConfig(extraServers),
    "--strict-mcp-config",
    "--allowedTools", "mcp__ha", "mcp__admin",
    "--permission-mode", "dontAsk", // anything not allowed is denied, never prompted
    "--append-system-prompt", systemPrompt(s),
  ];
  if (s.effort) args.push("--effort", s.effort);
  if (sid) args.push("--resume", sid);

  return new Promise((resolve, reject) => {
    const p = spawn(cfg.claudeBin, args, { cwd: cfg.workDir, env });
    let out = "", err = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error(`claude timed out after ${s.timeoutMs / 1000}s`));
    }, s.timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      let r;
      try { r = JSON.parse(out); } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 500)}`));
      }
      // With --verbose, json output is the whole message array; the result is its last entry.
      const msgs = Array.isArray(r) ? r : [r];
      const tools = msgs
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.message?.content || [])
        .filter((c) => c.type === "tool_use")
        .map((c) => c.name.replace(/^mcp__ha__/, "").replace(/^mcp__admin__/, "admin."));
      r = msgs.findLast((m) => m.type === "result") || {};
      if (r.is_error) return reject(new Error(r.result || r.subtype || "claude error"));
      resolve({ text: String(r.result ?? "").trim(), sid: r.session_id, cost: r.total_cost_usd, ms: r.duration_ms, tools });
    });
    p.stdin.end(text);
  });
}

async function ask(key, text) {
  const prev = queues.get(key) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const existing = sessions.get(key);
    const fresh = !existing || Date.now() - existing.last > settings().idleMs;
    // If this message confirms a pending change with its passcode, the server applies it here.
    const prompt = await admin.beforeTurn(key, text);

    const turn = admin.grantFor(key);
    let r;
    try {
      r = await runClaude(prompt, fresh ? undefined : existing.sid, turn.servers);
    } catch (e) {
      if (fresh) throw e;
      log(`resume failed for ${key}, starting fresh: ${e.message}`);
      r = await runClaude(prompt, undefined, turn.servers);
    } finally {
      turn.release();
    }
    r.text = admin.afterTurn(key, turn.grant) || r.text;
    sessions.set(key, { sid: r.sid, last: Date.now() });
    log(`[${key}] ${settings().mainModel} ${r.ms ?? "?"}ms tools=${r.tools.join(",") || "-"} ${JSON.stringify(text).slice(0, 80)} -> ${JSON.stringify(r.text).slice(0, 80)}`);
    return r;
  });
  queues.set(key, job);
  try { return await job; } finally { if (queues.get(key) === job) queues.delete(key); }
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

      send(res, 404, { error: "not found" });
    } catch (e) {
      log("error:", e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  })
  .listen(cfg.port, () => log(`claude-home API listening on :${cfg.port}`));

startUi({ cfg, settings, sessions, readJson, send, log, admin });

// 0.5.0 merged the two passcodes into one. options.json drops keys that are no
// longer in the schema, so read the old ones from the Supervisor.
supervisor("/addons/self/info")
  .then(async ({ options: o = {} }) => {
    if (!o.admin_passcode && !o.instructions_passcode) return;
    const current = readOptions(cfg.optionsFile);
    await writeOptions(cfg.optionsFile, { ...current, passcode: current.passcode || o.passcode || o.admin_passcode || o.instructions_passcode });
    log("migrated passcodes to a single 'passcode' option");
  })
  .catch((e) => log("passcode migration failed:", e.message));
admin.enforceProtected(true);
