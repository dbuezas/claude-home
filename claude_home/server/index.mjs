// Claude Home add-on server.
//   :8099 (API, bearer token)
//     POST /conversation  -> used by the HA custom component (Assist agent)
//     GET  /health
//   :8098 (Ingress web UI, only reachable through Home Assistant) -> see ui.mjs
//   127.0.0.1:8097 (admin tools, per-turn token) -> see admin.mjs (access levels)
//   127.0.0.1:8096 (gateway to Home Assistant, per-level grants) -> see proxy.mjs
// Every request runs `claude -p` (Claude Code, logged in with your subscription) as
// the unprivileged "claude" user. At level 0-1 it only gets MCP tools; from level 2
// ("unlock full access") it also gets Bash, the internet and the gateway.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { startUi } from "./ui.mjs";
import { createAdmin } from "./admin.mjs";
import { createProxy } from "./proxy.mjs";
import { createRemoteControl } from "./rc.mjs";
import { homeState, renderFull, renderDiff, SNAPSHOT_RULES } from "./snapshot.mjs";
import { createPool } from "./warm.mjs";

const env = process.env;
const cfg = {
  port: Number(env.PORT || 8099),
  uiPort: Number(env.UI_PORT || 8098),
  adminPort: Number(env.ADMIN_PORT || 8097),
  gatewayPort: Number(env.GATEWAY_PORT || 8096),
  apiToken: env.API_TOKEN || "",
  claudeBin: env.CLAUDE_BIN || "claude",
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
    fast: o.fast_mode !== false,
    fastKeep: Number(o.fast_keep || 3),
    fastIdleMs: Number(o.fast_idle_minutes || 15) * 60_000,
  };
}

// Claude runs as this user, so it can't read the Supervisor token or the add-on's files.
const user = (() => {
  const line = existsSync("/etc/passwd") && readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith("claude:"));
  if (!line) return {}; // local development: run as the current user
  const [, , uid, gid] = line.split(":");
  return { uid: Number(uid), gid: Number(gid) };
})();

// The environment Claude gets: no Supervisor token, no add-on API token.
const baseEnv = () => {
  const keep = ["PATH", "LANG", "TZ", "USER", "LOGNAME", "TMPDIR", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
  return { ...Object.fromEntries(keep.filter((k) => env[k]).map((k) => [k, env[k]])), HOME: env.CLAUDE_HOME_DIR || env.HOME };
};

const gateway = createProxy({ port: cfg.gatewayPort, log });
const remote = createRemoteControl({ cfg, user, baseEnv, log });
const admin = createAdmin({ cfg, settings, log, gateway, remote });

const systemPrompt = (s, level) => `You are the voice/chat assistant of a home, running inside Home Assistant.
Use the Home Assistant tools (mcp__ha__*) to read states and control devices.
Each user message starts with a [Home snapshot] (the main devices by area with their current state) or, later in a conversation, only the [Home snapshot changes] since the last one; together they are the current state. Answer from it when it is enough, without tools.
${SNAPSHOT_RULES} To control a device, call the Assist tool directly with its name from the snapshot. For anything not in it, use find_entities.
Replies are often spoken: answer in one or two short sentences, plain text, no markdown, no lists.
Reply in the language the user used. If you need clarification, ask one short question.${admin.systemPromptPart(level)}
${s.extra}`.trim();

// Prompt for a conversation handed over to the Claude app.
const appPrompt = (s, level) => `You are Claude inside the Claude Home add-on of Home Assistant. This conversation started by voice (Assist) and now continues in the Claude app, so replies no longer need to be short or plain text.
Use the Home Assistant tools (mcp__ha__*) to read states and control devices.${admin.systemPromptPart(level)}
${s.extra}`.trim();


// ---- sessions: external conversation id -> Claude Code session id ----------
const sessions = new Map(); // key -> { sid, last }
const queues = new Map(); // key -> promise chain (serialize turns per conversation)
const known = new Map(); // key -> home state this conversation's Claude has seen (for change-only snapshots)

setInterval(() => {
  const now = Date.now(), { idleMs } = settings();
  for (const [k, s] of sessions) if (now - s.last > idleMs) { sessions.delete(k); known.delete(k); }
}, 60_000).unref();

// Arguments and environment for one Claude process at a given level.
function claudeLaunch(s, turn, sid, stream) {
  const full = turn.level >= 2;
  const args = [
    "-p",
    ...(stream ? ["--input-format", "stream-json", "--output-format", "stream-json"] : ["--output-format", "json"]),
    "--verbose", // full message list, so we can see which tools ran
    "--model", s.mainModel,
    "--mcp-config", JSON.stringify({ mcpServers: turn.servers }),
    "--strict-mcp-config",
    ...(full
      ? ["--tools", "default", "--permission-mode", "bypassPermissions"] // full access, unlocked by the user
      : ["--tools", "", "--allowedTools", "mcp__ha", "mcp__admin", "--permission-mode", "dontAsk"]), // only MCP tools; anything else denied
    "--append-system-prompt", systemPrompt(s, turn.level),
  ];
  if (s.effort) args.push("--effort", s.effort);
  if (sid) args.push("--resume", sid);
  const childEnv = { ...baseEnv(), ...(full ? { HA_URL: gateway.url, HA_TOKEN: turn.gateway } : {}) };
  return { args, opts: { cwd: cfg.workDir, env: childEnv, ...user } };
}

// What a running Claude was started with; if it differs, the Claude is replaced.
const fingerprint = (s, level) => JSON.stringify([s.mainModel, s.effort, level, systemPrompt(s, level)]);

// Shape a result message like runClaude's.
function shapeResult(r, tools) {
  if (r.is_error) throw new Error(r.result || r.subtype || "claude error");
  const u = r.usage || {};
  const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return { text: String(r.result ?? "").trim(), sid: r.session_id, cost: r.total_cost_usd, ms: r.duration_ms, turns: r.num_turns, tokens, tools };
}

// Fast mode: Claudes that stay running between messages (see warm.mjs).
const pool = createPool({
  log,
  launch: ({ level, sid, key }) => {
    const access = admin.access(level, key);
    const { args, opts } = claudeLaunch(settings(), access, sid, true);
    return { proc: spawn(cfg.claudeBin, args, opts), access };
  },
});
function syncPool() {
  const s = settings();
  if (!s.fast) return pool.closeAll();
  pool.configure({ max: s.fastKeep, idleMs: s.fastIdleMs });
  pool.refill(() => ({ fp: fingerprint(settings(), 0), level: 0 }));
}
setInterval(syncPool, 30_000).unref();
setTimeout(syncPool, 2000);

async function runPooled(key, text, sid, level) {
  const s = settings();
  const { m, tools, access } = await pool.ask({ key, fp: fingerprint(s, level), level, sid, text, timeoutMs: s.timeoutMs });
  return { ...shapeResult(m, tools), grant: access.grant };
}

function runClaude(text, sid, turn) {
  const s = settings();
  const { args, opts } = claudeLaunch(s, turn, sid, false);
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.claudeBin, args, opts);
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
      try { resolve(shapeResult(r, tools)); } catch (e) { reject(e); }
    });
    // The text may still be on its way (the snapshot is read while Claude starts).
    Promise.resolve(text).then((t) => p.stdin.end(t), () => p.stdin.end(""));
  });
}

async function ask(key, text) {
  const prev = queues.get(key) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const existing = sessions.get(key);
    const fresh = !existing || Date.now() - existing.last > settings().idleMs;
    // If this message answers an unlock request with its phrase, the level goes up here.
    const prompt = await admin.beforeTurn(key, text);

    // Full snapshot for a new session, otherwise only the changes since the last one.
    const current = homeState(admin.protectedList()).catch((e) => { log("snapshot failed:", e.message); return null; });
    const inputFor = (full) => current.then((cur) => {
      if (!cur) return prompt;
      const prev = !full && known.get(key);
      if (!prev) {
        known.set(key, cur);
        const full = renderFull(cur);
        log(`[${key}] snapshot: full, ${full.length} bytes`);
        return `${full}\n\n${prompt}`;
      }
      const d = renderDiff(prev, cur);
      known.set(key, d.known);
      log(`[${key}] snapshot: changes only, ${d.text.length} bytes`);
      return `${d.text}\n\n${prompt}`;
    });
    const level = admin.levelOf(key);
    const sid = fresh ? undefined : existing.sid;
    const fast = settings().fast;
    if (fresh) await pool.close(key); // an expired conversation starts over
    const run = async (resumeSid) => {
      const input = inputFor(!resumeSid); // a fresh session needs the full snapshot
      if (fast) return runPooled(key, input, resumeSid, level);
      const turn = admin.turnFor(key);
      try { return { ...(await runClaude(input, resumeSid, turn)), grant: turn.grant }; } finally { turn.release(); }
    };
    let r;
    try {
      r = await run(sid);
    } catch (e) {
      if (!sid) throw e;
      log(`resume failed for ${key}, starting fresh: ${e.message}`);
      await pool.close(key);
      r = await run(undefined);
    }
    const turn = { level, grant: r.grant };
    r.text = admin.afterTurn(key, turn.grant) || r.text;

    // continue_in_app: now that this turn's process has exited, reopen the same session
    // in the Claude app. Voice then starts fresh, so only one process owns the session.
    const ho = admin.takeHandover(key, turn.grant);
    if (ho) {
      await pool.close(key); // only one process may own the session
      const gw = gateway.grant(turn.level);
      const tools = admin.appAccess(turn.level);
      try {
        const h = await remote.handover({
          sid: r.sid, name: ho.title, level: turn.level,
          grant: { url: gateway.url, token: gw.token, release: () => { gw.release(); tools.release(); } },
          mcpServers: { ha: { type: "http", url: `${gateway.url}/core/api/mcp`, headers: { Authorization: `Bearer ${gw.token}` } }, admin: tools.server },
          appendSystemPrompt: appPrompt(settings(), turn.level),
        });
        sessions.delete(key);
        known.delete(key);
        admin.resetLevel(key);
        r.text = `This conversation now continues in the Claude app as "${h.name}". Next time you talk to me here, we start fresh.`;
      } catch (e) {
        r.text = `The handover didn't work: ${e.message}`;
      }
      log(`[${key}] handover: ${r.text}`);
      return r;
    }
    sessions.set(key, { sid: r.sid, last: Date.now() });
    syncPool();
    log(`[${key}] ${settings().mainModel} L${turn.level}${fast ? " fast" : ""} ${r.ms ?? "?"}ms turns=${r.turns ?? "?"} tokens=${r.tokens ?? "?"} tools=${r.tools.join(",") || "-"} ${JSON.stringify(text).slice(0, 80)} -> ${JSON.stringify(r.text).slice(0, 80)}`);
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
        try {
          const r = await ask(`ha:${conversation_id || crypto.randomUUID()}`, text);
          return send(res, 200, { speech: r.text });
        } catch (e) {
          if (/not logged in|\/login|invalid api key|authentication/i.test(e.message)) {
            return send(res, 200, { speech: "Claude Home isn't logged in yet. Open Claude in the Home Assistant sidebar, go to Settings, and log in." });
          }
          throw e;
        }
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      log("error:", e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  })
  .listen(cfg.port, () => log(`claude-home API listening on :${cfg.port}`));

startUi({ cfg, settings, sessions, readJson, send, log, admin, remote, pool, syncPool, gateway });

admin.enforceProtected(true);

// Conversation histories are kept so they can be resumed; delete old ones so they
// don't pile up. Never touches sessions that are running in the Claude app.
const KEEP_DAYS = 30;
function cleanup() {
  const root = `${baseEnv().HOME}/.claude/projects`;
  const active = remote.activeSessions();
  let removed = 0;
  try {
    for (const dir of readdirSync(root)) {
      for (const f of readdirSync(`${root}/${dir}`)) {
        const p = `${root}/${dir}/${f}`;
        if (active.has(f.replace(/\.jsonl$/, ""))) continue;
        if (Date.now() - statSync(p).mtimeMs > KEEP_DAYS * 86_400_000) { rmSync(p, { recursive: true, force: true }); removed++; }
      }
    }
  } catch {}
  if (removed) log(`cleanup: removed ${removed} conversation file(s) older than ${KEEP_DAYS} days`);
}
cleanup();
setInterval(cleanup, 86_400_000).unref();
