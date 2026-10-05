// Ingress web UI: status, settings, protected entities.
// Only Home Assistant's ingress proxy may reach it; HA has already authenticated the user.
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

async function mcpTools(gateway) {
  if (Date.now() - toolsCache.at < 30_000) return toolsCache.value;
  let value;
  try {
    const g = gateway.grant(0);
    const url = `${gateway.url}/core/api/mcp`, headers = { Authorization: `Bearer ${g.token}` };
    const client = new Client({ name: "claude-home-ui", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    try {
      const { tools } = await client.listTools();
      value = { ok: true, tools: tools.map((t) => ({ name: t.name, description: (t.description || "").split("\n")[0] })) };
    } finally { await client.close(); g.release(); }
  } catch (e) {
    value = { ok: false, error: e.message, tools: [] };
  }
  toolsCache = { at: Date.now(), value };
  return value;
}

// The user's own words from a stored message (without the home snapshot and system notes).
function userText(content) {
  let t = typeof content === "string" ? content : (content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (!t) return "";
  if (t.startsWith("[Home snapshot")) t = t.includes("\n\n") ? t.slice(t.indexOf("\n\n") + 2) : "";
  return t.replace(/^\[System note: [\s\S]*?\]\n/, "").trim();
}

// Recent conversations stored by Claude Code (one .jsonl per session).
export function conversations(dir, limit = 50) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return files
    .map((f) => ({ f, mtime: statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ f, mtime }) => {
      const said = [];
      for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) {
        if (!line.includes('"type":"user"')) continue;
        try { const m = JSON.parse(line); if (m.type === "user" && !m.isMeta) { const t = userText(m.message?.content); if (t) said.push(t); } } catch {}
      }
      return { sid: f.replace(/\.jsonl$/, ""), updated: new Date(mtime).toISOString(), messages: said.length, first: said[0] || "", last: said.at(-1) || "" };
    })
    .filter((c) => c.messages > 0);
}

export function startUi({ cfg, settings, sessions, readJson, send, log, admin, remote, pool, syncPool, gateway, startHandover }) {
  const allowAny = env.UI_ALLOW_ANY === "1"; // local development only

  async function status() {
    claudeVersion ??= await promisify(execFile)(cfg.claudeBin, ["--version"])
      .then(({ stdout }) => stdout.trim()).catch((e) => `unknown (${e.message})`);
    const s = settings();
    return {
      claudeVersion,
      models: { main: s.mainModel, effort: s.effort || "default" },
      sessions: sessions.size,
      account: await remote.status().then((r) => ({ loggedIn: r.loggedIn, email: r.email })),
      fast: { on: s.fast, ...pool.status() },
      mcp: await mcpTools(gateway),
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
    "GET /api/conversations": async () => {
      const inApp = new Map((await remote.status()).sessions.map((h) => [h.sid, h]));
      const voice = new Set([...sessions.values()].map((v) => v.sid));
      const dir = `${process.env.CLAUDE_HOME_DIR || process.env.HOME}/.claude/projects/${cfg.workDir.replace(/[^A-Za-z0-9]/g, "-")}`;
      return {
        maxLevel: Number.isInteger(Number(readOptions(cfg.optionsFile).max_level)) ? Number(readOptions(cfg.optionsFile).max_level) : 3,
        list: conversations(dir).map((c) => ({ ...c, app: inApp.get(c.sid) || null, voice: voice.has(c.sid) })),
      };
    },
    "POST /api/conversations/continue": async (req) => {
      const { sid, level, name } = (await readJson(req)) || {};
      if (!/^[0-9a-f-]{36}$/.test(String(sid))) throw new Error("bad session id");
      const o = readOptions(cfg.optionsFile);
      const max = Number.isInteger(Number(o.max_level)) ? Number(o.max_level) : 3;
      const lvl = Math.max(0, Math.min(max, Math.round(Number(level) || 0)));
      return startHandover({ sid, level: lvl, name: String(name || "Home Assistant").slice(0, 60) });
    },
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
