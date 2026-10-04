// Ingress web UI: status, settings, protected entities.
// Only Home Assistant's ingress proxy may reach it; HA has already authenticated the user.
import http from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { haWs, readOptions, writeOptions } from "./ha.mjs";



import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const INGRESS_IP = "172.30.32.2";
const EDITABLE = {
  main_model: (v) => String(v).trim() || "opus",
  effort: (v) => (["low", "medium", "high", "xhigh", "max"].includes(v) ? v : "default"),
  session_idle_minutes: (v) => Math.min(1440, Math.max(1, Math.round(Number(v) || 15))),
  max_level: (v) => Math.min(3, Math.max(0, Math.round(Number(v)))),
  request_timeout: (v) => Math.min(600, Math.max(10, Math.round(Number(v) || 120))),
  extra_instructions: (v) => String(v ?? ""),
  fast_mode: (v) => v === true || v === "true",
  fast_keep: (v) => Math.min(10, Math.max(1, Math.round(Number(v) || 3))),
  fast_idle_minutes: (v) => Math.min(240, Math.max(1, Math.round(Number(v) || 15))),
};


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

export function startUi({ cfg, settings, sessions, readJson, send, log, admin, remote, pool, syncPool }) {
  const allowAny = env.UI_ALLOW_ANY === "1"; // local development only

  async function status() {
    claudeVersion ??= await promisify(execFile)(cfg.claudeBin, ["--version"])
      .then(({ stdout }) => stdout.trim()).catch((e) => `unknown (${e.message})`);
    const s = settings();
    return {
      claudeVersion,
      models: { main: s.mainModel, effort: s.effort || "default" },
      sessions: sessions.size,
      fast: { on: s.fast, ...pool.status() },
      mcp: await mcpTools(cfg.mcpConfig),
    };
  }

  async function entities() {
    const [states] = await haWs([{ type: "get_states" }]);
    const prot = new Set(admin.protectedList());
    return states
      .map((st) => ({
        entity_id: st.entity_id,
        name: st.attributes.friendly_name || st.entity_id,
        domain: st.entity_id.split(".")[0],
        state: st.state,
        protected: prot.has(st.entity_id),
      }))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  }

  async function saveOptions(changes) {
    const next = { ...readOptions(cfg.optionsFile) };
    for (const [k, clean] of Object.entries(EDITABLE)) if (k in changes) next[k] = clean(changes[k]);
    await writeOptions(cfg.optionsFile, next);
    syncPool();
  }

  const routes = {
    "GET /": (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); },
    "GET /api/status": async () => status(),
    "GET /api/options": async () => {
      const o = readOptions(cfg.optionsFile);
      return {
        ...Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, o[k] ?? ""])),
      };
    },
    "POST /api/options": async (req) => { await saveOptions((await readJson(req)) || {}); return { ok: true }; },
    "GET /api/entities": async () => entities(),
    "GET /api/remote": async () => remote.status(),
    "POST /api/remote/login": async () => remote.startLogin(),
    "POST /api/remote/code": async (req) => remote.submitCode(((await readJson(req)) || {}).code || ""),
    "POST /api/remote/logout": async () => { await remote.logout(); return remote.status(); },
    "POST /api/remote/stop": async (req) => {
      const { id } = (await readJson(req)) || {};
      id === "all" ? remote.stopAll() : remote.stop(id);
      return { ok: true };
    },
    "POST /api/protect": async (req) => {
      const { entity_ids, protected: on } = (await readJson(req)) || {};
      if (!Array.isArray(entity_ids) || !entity_ids.length) throw new Error("entity_ids required");
      await admin.setProtected(entity_ids, !!on);
      toolsCache.at = 0;
      return { ok: true };
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
