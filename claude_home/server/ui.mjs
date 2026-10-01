// Ingress web UI: status, test chat, settings, exposed entities, remote setup.
// Only Home Assistant's ingress proxy may reach it; HA has already authenticated the user.
import http from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const INGRESS_IP = "172.30.32.2";
const EDITABLE = {
  main_model: (v) => String(v).trim() || "haiku",
  planner_model: (v) => String(v).trim() || "opus",
  effort: (v) => (["low", "medium", "high", "xhigh", "max"].includes(v) ? v : "default"),
  session_idle_minutes: (v) => Math.min(1440, Math.max(1, Math.round(Number(v) || 15))),
  request_timeout: (v) => Math.min(600, Math.max(10, Math.round(Number(v) || 120))),
  extra_instructions: (v) => String(v ?? ""),
};

const env = process.env;
const supervisorToken = env.SUPERVISOR_TOKEN || "";
const html = readFileSync(new URL("./ui.html", import.meta.url));

async function supervisor(path, init = {}) {
  const r = await fetch(`http://supervisor${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${supervisorToken}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.result === "error") throw new Error(body.message || `supervisor ${path}: HTTP ${r.status}`);
  return body.data;
}

// One short-lived websocket per call; this page is used rarely.
function haWs(messages) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env.HA_WS_URL || "ws://supervisor/core/websocket");
    const results = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Home Assistant websocket timed out")); }, 15_000);
    const done = (fn, v) => { clearTimeout(timer); ws.close(); fn(v); };
    ws.on("error", (e) => done(reject, e));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "auth_required") return ws.send(JSON.stringify({ type: "auth", access_token: supervisorToken }));
      if (m.type === "auth_invalid") return done(reject, new Error("Home Assistant rejected the Supervisor token"));
      if (m.type === "auth_ok") return messages.forEach((msg, i) => ws.send(JSON.stringify({ id: i + 1, ...msg })));
      if (m.type !== "result") return;
      if (!m.success) return done(reject, new Error(m.error?.message || "Home Assistant command failed"));
      results[m.id - 1] = m.result;
      if (results.filter((x) => x !== undefined).length === messages.length) done(resolve, results);
    });
  });
}

let claudeVersion;
let toolsCache = { at: 0, value: null };

async function mcpTools(mcpConfigPath) {
  if (Date.now() - toolsCache.at < 30_000) return toolsCache.value;
  let value;
  try {
    const { url, headers } = JSON.parse(readFileSync(mcpConfigPath, "utf8")).mcpServers.ha;
    const client = new Client({ name: "claude-home-ui", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    try {
      const { tools } = await client.listTools();
      value = { ok: true, tools: tools.map((t) => ({ name: t.name, description: (t.description || "").split("\n")[0] })) };
    } finally { await client.close(); }
  } catch (e) {
    value = { ok: false, error: e.message, tools: [] };
  }
  toolsCache = { at: Date.now(), value };
  return value;
}

function readOptions(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

export function startUi({ cfg, settings, ask, recent, sessions, readJson, send, log }) {
  const allowAny = env.UI_ALLOW_ANY === "1"; // local development only

  async function status() {
    claudeVersion ??= await promisify(execFile)(cfg.claudeBin, ["--version"])
      .then(({ stdout }) => stdout.trim()).catch((e) => `unknown (${e.message})`);
    const s = settings();
    let mappedPort = null;
    try { mappedPort = (await supervisor("/addons/self/info")).network?.["8099/tcp"] ?? null; } catch {}
    return {
      claudeVersion,
      models: { main: s.mainModel, planner: s.plannerModel, effort: s.effort || "default" },
      sessions: sessions.size,
      recent,
      mcp: await mcpTools(cfg.mcpConfig),
      remote: { token: cfg.apiToken, mappedPort },
    };
  }

  async function entities() {
    const [states, exposed] = await haWs([
      { type: "get_states" },
      { type: "homeassistant/expose_entity/list" },
    ]);
    const exp = exposed.exposed_entities || {};
    return states
      .map((st) => ({
        entity_id: st.entity_id,
        name: st.attributes.friendly_name || st.entity_id,
        domain: st.entity_id.split(".")[0],
        state: st.state,
        exposed: exp[st.entity_id]?.conversation === true,
      }))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  }

  async function saveOptions(changes) {
    const current = readOptions(cfg.optionsFile);
    const next = { ...current };
    for (const [k, clean] of Object.entries(EDITABLE)) if (k in changes) next[k] = clean(changes[k]);
    if (!next.extra_instructions) delete next.extra_instructions;
    await supervisor("/addons/self/options", { method: "POST", body: JSON.stringify({ options: next }) });
  }

  const routes = {
    "GET /": (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); },
    "GET /api/status": async () => status(),
    "GET /api/options": async () => {
      const o = readOptions(cfg.optionsFile);
      return Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, o[k] ?? ""]));
    },
    "POST /api/options": async (req) => { await saveOptions((await readJson(req)) || {}); return { ok: true }; },
    "GET /api/entities": async () => entities(),
    "POST /api/expose": async (req) => {
      const { entity_ids, exposed } = (await readJson(req)) || {};
      if (!Array.isArray(entity_ids) || !entity_ids.length) throw new Error("entity_ids required");
      await haWs([{ type: "homeassistant/expose_entity", assistants: ["conversation"], entity_ids, should_expose: !!exposed }]);
      toolsCache.at = 0; // exposed scripts change the tool list
      return { ok: true };
    },
    "POST /api/chat": async (req) => {
      const { text, conversation_id } = (await readJson(req)) || {};
      if (!text) throw new Error("text required");
      const id = conversation_id || crypto.randomUUID();
      const r = await ask(`ui:${id}`, text);
      return { reply: r.text, conversation_id: id, ms: r.ms, cost: r.cost };
    },
  };

  http
    .createServer(async (req, res) => {
      const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      if (!allowAny && ip !== INGRESS_IP) return send(res, 403, { error: "only reachable through Home Assistant" });
      const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
      if (!route) return send(res, 404, { error: "not found" });
      try {
        const out = await route(req, res);
        if (out !== undefined) send(res, 200, out);
      } catch (e) {
        log("ui error:", e.message);
        if (!res.headersSent) send(res, 500, { error: e.message });
      }
    })
    .listen(cfg.uiPort, () => log(`claude-home web UI listening on :${cfg.uiPort}`));
}
