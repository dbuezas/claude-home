// Ingress web UI: status, test chat, settings, exposed entities, remote setup.
// Only Home Assistant's ingress proxy may reach it; HA has already authenticated the user.
import http from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { supervisor, haWs, readOptions, writeOptions } from "./ha.mjs";
import { normalize, SCOPES } from "./admin.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const INGRESS_IP = "172.30.32.2";
const EDITABLE = {
  main_model: (v) => String(v).trim() || "opus",
  effort: (v) => (["low", "medium", "high", "xhigh", "max"].includes(v) ? v : "default"),
  session_idle_minutes: (v) => Math.min(1440, Math.max(1, Math.round(Number(v) || 15))),
  request_timeout: (v) => Math.min(600, Math.max(10, Math.round(Number(v) || 120))),
  extra_instructions: (v) => String(v ?? ""),
  admin_hint: (v) => String(v ?? "").trim(),
  instructions_hint: (v) => String(v ?? "").trim(),
};
const PASSCODES = Object.values(SCOPES).map((s) => s.passcode);

const env = process.env;
const html = readFileSync(new URL("./ui.html", import.meta.url));

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
      models: { main: s.mainModel, effort: s.effort || "default" },
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
    const next = { ...readOptions(cfg.optionsFile) };
    for (const [k, clean] of Object.entries(EDITABLE)) if (k in changes) next[k] = clean(changes[k]);
    // Empty passcode = feature off.
    for (const k of PASSCODES) if (k in changes) next[k] = String(changes[k] ?? "").trim();
    for (const k of PASSCODES) {
      if (next[k] && normalize(next[k]).trim().replace(/ /g, "").length < 4) throw new Error("A passcode needs at least 4 letters or digits.");
    }
    const [a, b] = PASSCODES.map((k) => next[k] && normalize(next[k]));
    if (a && b && (a.includes(b) || b.includes(a))) throw new Error("The two passcodes must be different, and one must not contain the other.");
    await writeOptions(cfg.optionsFile, next);
  }

  const routes = {
    "GET /": (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); },
    "GET /api/status": async () => status(),
    "GET /api/options": async () => {
      const o = readOptions(cfg.optionsFile);
      return {
        ...Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, o[k] ?? ""])),
        ...Object.fromEntries(PASSCODES.map((k) => [k, o[k] ?? ""])),
      };
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
