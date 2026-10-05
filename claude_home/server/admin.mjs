// Access levels, unlocked per conversation with a fixed-phrase handshake.
//
//   level 0  always   : read every entity, control what is exposed to Assist.
//   level 1  "unlock protected entities" : control protected entities, rename things, areas, edit own
//                       instructions, change the protected list.
//   level 2  "unlock full access" : Bash, internet, all of Home Assistant core
//                       (through the gateway in proxy.mjs), handing the conversation
//                       over to the Claude app (rc.mjs).
//   level 3  "unlock supervisor"  : also the Supervisor API (add-ons, backups, updates, host).
//
// Handshake: Claude calls request_unlock(level, reason). The server replaces Claude's
// reply with the request and the phrase to say ("unlock protected entities", "unlock full access",
// "unlock supervisor"). The user's very next message must contain that phrase; the server checks it in the user's own words (never
// in Claude's text). Then the conversation stays at that level until it ends (idle
// timeout). The phrase said without a request does nothing. The phrases are fixed and
// not secret; they only prove the answer came from the user. The highest level Claude
// may ask for is a setting (max_level).
//
// Protected entities are kept un-exposed from Assist, so Home Assistant's own MCP
// tools can't control them (not even through area-wide commands).
import http from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { haWs, readOptions, writeOptions } from "./ha.mjs";

export const normalize = (s) =>
  ` ${String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

// True if the phrase appears in the text as whole words (case, accents and punctuation ignored).
export const containsPasscode = (text, code) => normalize(code).trim() !== "" && normalize(text).includes(normalize(code));

export const LEVELS = {
  1: { phrase: "unlock protected entities", name: "protected entities", what: "control protected devices, rename things, change areas, edit my instructions and the protected list" },
  2: { phrase: "unlock full access", name: "full access", what: "run commands, use the internet, change anything in Home Assistant and continue the conversation in the Claude app" },
  3: { phrase: "unlock supervisor", name: "supervisor", what: "also manage add-ons, backups, updates and the host" },
};

const ENFORCE_EVERY_MS = 30_000;

export function createAdmin({ cfg, settings, log, gateway, remote }) {
  const grants = new Map(); // per-turn bearer token -> conversation key
  const levels = new Map(); // conversation key -> { level, last }
  const requests = new Map(); // conversation key -> { level, reason, grant } (valid for the next message only)
  const handovers = new Map(); // conversation key -> { grant, title } (continue_in_app called this turn)
  let protectedNames = new Map(); // entity_id -> friendly name (for the system prompt)
  let lastEnforced = 0;

  const options = () => readOptions(cfg.optionsFile);
  const passcodeFor = (level) => LEVELS[level].phrase;
  const maxLevel = () => { const m = Number(options().max_level); return Number.isInteger(m) ? m : 3; };
  const available = (level) => level <= maxLevel();
  const protectedList = () => [...new Set(options().protected_entities || [])];

  function levelOf(key) {
    const l = levels.get(key);
    if (!l) return 0;
    if (Date.now() - l.last > settings().idleMs) { levels.delete(key); return 0; }
    return l.level;
  }

  // ---- protected entities -------------------------------------------------
  // Un-expose protected entities from Assist (fixes drift if someone re-exposed one).
  async function enforceProtected(force = false) {
    if (!force && Date.now() - lastEnforced < ENFORCE_EVERY_MS) return;
    lastEnforced = Date.now();
    const list = protectedList();
    try {
      const [exposed, states] = await haWs([{ type: "homeassistant/expose_entity/list" }, { type: "get_states" }]);
      const leaking = list.filter((id) => exposed.exposed_entities?.[id]?.conversation === true);
      if (leaking.length) {
        await haWs([{ type: "homeassistant/expose_entity", assistants: ["conversation"], entity_ids: leaking, should_expose: false }]);
        log(`un-exposed protected entities: ${leaking.join(", ")}`);
      }
      const names = new Map(states.map((s) => [s.entity_id, s.attributes.friendly_name]));
      protectedNames = new Map(list.map((id) => [id, names.get(id) || id]));
    } catch (e) {
      log("could not enforce protected entities:", e.message);
    }
  }

  async function setProtected(ids, on) {
    const next = on ? [...new Set([...protectedList(), ...ids])] : protectedList().filter((id) => !ids.includes(id));
    await writeOptions(cfg.optionsFile, { ...options(), protected_entities: next });
    // Protecting hides from Assist; unprotecting gives Claude normal access again.
    await haWs([{ type: "homeassistant/expose_entity", assistants: ["conversation"], entity_ids: ids, should_expose: !on }]);
    await enforceProtected(true);
  }

  // ---- before Claude runs -------------------------------------------------
  // Completes an unlock handshake if this message answers one. Returns the text for Claude.
  async function beforeTurn(key, text) {
    enforceProtected(); // drift fix in the background; it never blocks a turn
    const req = requests.get(key);
    requests.delete(key); // the answer must be the very next message
    const current = levelOf(key);
    if (levels.has(key)) levels.get(key).last = Date.now();

    let note = "";
    if (req && containsPasscode(text, passcodeFor(req.level))) {
      levels.set(key, { level: Math.max(current, req.level), last: Date.now() });
      log(`[${key}] unlocked level ${req.level} (${LEVELS[req.level].name})`);
      note = `The user said the unlock phrase: level ${req.level} (${LEVELS[req.level].name}) is unlocked for the rest of this conversation. Continue with what you were doing: ${req.reason}`;
    } else if (req) {
      note = `The user's answer did not contain the level ${req.level} unlock phrase, so nothing was unlocked (still level ${current}). If they meant to give it, ask again with request_unlock.`;
    }
    return note ? `[System note: ${note}]\n${text}` : text;
  }

  // ---- per turn: MCP access and level -------------------------------------
  // MCP access for one Claude process at a fixed level. A process started ahead of time
  // (fast mode's spare) gets its conversation key later with bind().
  function access(level, key = null) {
    const grant = randomBytes(24).toString("hex");
    grants.set(grant, key);
    const gw = gateway.grant(level);
    return {
      level,
      grant,
      gateway: gw.token,
      servers: {
        ha: { type: "http", url: `${gateway.url}/core/api/mcp`, headers: { Authorization: `Bearer ${gw.token}` } },
        admin: { type: "http", url: `http://127.0.0.1:${cfg.adminPort}/mcp`, headers: { Authorization: `Bearer ${grant}` } },
      },
      bind: (k) => grants.set(grant, k),
      release: () => { grants.delete(grant); gw.release(); },
    };
  }
  const turnFor = (key) => access(levelOf(key), key);

  // After Claude's turn: was a handover to the app requested?
  function takeHandover(key, grant) {
    const h = handovers.get(key);
    handovers.delete(key);
    return h && h.grant === grant ? h : null;
  }

  // Tools for a handed-over app session: same level, never expires (ends when the session is stopped).
  function appAccess(level) {
    const key = `app:${randomBytes(6).toString("hex")}`;
    levels.set(key, { level, last: Number.MAX_SAFE_INTEGER });
    const grant = randomBytes(24).toString("hex");
    grants.set(grant, key);
    return {
      server: { type: "http", url: `http://127.0.0.1:${cfg.adminPort}/mcp`, headers: { Authorization: `Bearer ${grant}` } },
      release: () => { grants.delete(grant); levels.delete(key); },
    };
  }

  function resetLevel(key) { levels.delete(key); requests.delete(key); }

  // After Claude's turn: if it asked to unlock, the reply is replaced by the exact request.
  function afterTurn(key, grant) {
    const req = requests.get(key);
    if (!req || req.grant !== grant) return "";
    return `To ${req.reason.replace(/[.!]+$/, "")}, I need level ${req.level} (${LEVELS[req.level].name}) for this conversation. Say "${passcodeFor(req.level)}" to unlock it.`;
  }

  // ---- registry helpers -----------------------------------------------------
  async function registry() {
    const [entities, devices, areas, states] = await haWs([
      { type: "config/entity_registry/list" },
      { type: "config/device_registry/list" },
      { type: "config/area_registry/list" },
      { type: "get_states" },
    ]);
    const stateName = new Map(states.map((s) => [s.entity_id, s.attributes.friendly_name]));
    return { entities, devices, areas, states, stateName };
  }
  const deviceName = (d) => d?.name_by_user || d?.name || "";

  function findArea(areas, ref, created) {
    const n = normalize(ref);
    return areas.find((a) => a.area_id === ref || normalize(a.name) === n) || (created.some((c) => normalize(c) === n) ? { area_id: null, name: ref } : null);
  }

  async function planChanges(changes) {
    const { entities, devices, areas, states, stateName } = await registry();
    const lines = [], creates = [], ops = [], protect = [], unprotect = [];
    const created = changes.filter((c) => c.action === "create_area").map((c) => c.value);
    const known = new Set(states.map((s) => s.entity_id));
    for (const c of changes) {
      const ent = entities.find((e) => e.entity_id === c.target);
      const dev = devices.find((d) => d.id === c.target) || (ent?.device_id && devices.find((d) => d.id === ent.device_id));
      const label = (id) => `${stateName.get(id) || id} (${id})`;
      switch (c.action) {
        case "rename_entity": {
          if (!ent) throw new Error(`Unknown entity ${c.target}`);
          lines.push(c.value ? `Rename ${c.target} from "${stateName.get(c.target) || ent.name || ent.original_name}" to "${c.value}"` : `Reset the name of ${c.target} to its default`);
          ops.push(() => ({ type: "config/entity_registry/update", entity_id: c.target, name: c.value || null }));
          break;
        }
        case "rename_device": {
          if (!dev) throw new Error(`Unknown device ${c.target} (give a device id or one of its entity ids)`);
          lines.push(c.value ? `Rename device "${deviceName(dev)}" to "${c.value}"` : `Reset the name of device "${deviceName(dev)}"`);
          ops.push(() => ({ type: "config/device_registry/update", device_id: dev.id, name_by_user: c.value || null }));
          break;
        }
        case "set_area": {
          const area = findArea(areas, c.value, created);
          if (!area) throw new Error(`Unknown area "${c.value}" (create it in the same proposal with create_area)`);
          if (!ent && !dev) throw new Error(`Unknown entity or device ${c.target}`);
          const toDevice = !ent || c.target === dev?.id;
          lines.push(toDevice ? `Move device "${deviceName(dev)}" to area "${area.name}"` : `Move ${c.target} to area "${area.name}"`);
          ops.push((ids) => {
            const area_id = area.area_id || ids.get(normalize(area.name));
            return toDevice ? { type: "config/device_registry/update", device_id: dev.id, area_id } : { type: "config/entity_registry/update", entity_id: c.target, area_id };
          });
          break;
        }
        case "create_area": {
          if (!c.value) throw new Error("create_area needs a name in value");
          if (areas.some((a) => normalize(a.name) === normalize(c.value))) throw new Error(`Area "${c.value}" already exists`);
          lines.push(`Create area "${c.value}"`);
          creates.push(c.value);
          break;
        }
        case "rename_area": {
          const area = findArea(areas, c.target, []);
          if (!area) throw new Error(`Unknown area "${c.target}"`);
          lines.push(`Rename area "${area.name}" to "${c.value}"`);
          ops.push(() => ({ type: "config/area_registry/update", area_id: area.area_id, name: c.value }));
          break;
        }
        case "protect":
        case "unprotect": {
          if (!known.has(c.target)) throw new Error(`Unknown entity ${c.target}`);
          const isProtected = protectedList().includes(c.target);
          if (c.action === "protect" && isProtected) throw new Error(`${c.target} is already protected`);
          if (c.action === "unprotect" && !isProtected) throw new Error(`${c.target} is not protected`);
          lines.push(c.action === "protect" ? `Protect ${label(c.target)}: from then on, controlling it needs level 1` : `Unprotect ${label(c.target)}: you get normal access to it again`);
          (c.action === "protect" ? protect : unprotect).push(c.target);
          break;
        }
        default:
          throw new Error(`Unknown action ${c.action}`);
      }
    }
    const run = async () => {
      const ids = new Map();
      if (creates.length) {
        const made = await haWs(creates.map((name) => ({ type: "config/area_registry/create", name })));
        made.forEach((a) => ids.set(normalize(a.name), a.area_id));
      }
      if (ops.length) await haWs(ops.map((op) => op(ids)));
      if (protect.length) await setProtected(protect, true);
      if (unprotect.length) await setProtected(unprotect, false);
      return [];
    };
    return { lines, run };
  }

  // Read or control protected entities.
  async function planUse(actions) {
    const [states, services] = await haWs([{ type: "get_states" }, { type: "get_services" }]);
    const byId = new Map(states.map((s) => [s.entity_id, s]));
    const lines = [], steps = [];
    for (const a of actions) {
      const st = byId.get(a.entity_id);
      if (!st) throw new Error(`Unknown entity ${a.entity_id}`);
      if (!protectedList().includes(a.entity_id)) throw new Error(`${a.entity_id} is not protected; use the normal Home Assistant tools for it`);
      const name = `${st.attributes.friendly_name || a.entity_id} (${a.entity_id})`;
      const [domain, service] = a.service.includes(".") ? a.service.split(".", 2) : [a.entity_id.split(".")[0], a.service];
      if (!services[domain]?.[service]) throw new Error(`Unknown action ${domain}.${service}`);
      // A script's own service (script.<name>) takes fields directly and no target.
      const scriptCall = domain === "script" && !["turn_on", "turn_off", "toggle", "reload"].includes(service);
      const data = a.data && Object.keys(a.data).length ? a.data : undefined;
      lines.push(`Run ${domain}.${service} on ${name}${data ? ` with ${JSON.stringify(data)}` : ""}`);
      steps.push(async () => {
        await haWs([{ type: "call_service", domain, service, service_data: data, ...(scriptCall ? {} : { target: { entity_id: a.entity_id } }) }]);
        return `${domain}.${service} on ${a.entity_id}: ok`;
      });
    }
    const run = async () => { const out = []; for (const s of steps) out.push(await s()); return out; };
    return { lines, run };
  }

  // ---- the local MCP server Claude talks to ---------------------------------
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const fail = (t) => ({ isError: true, ...text(t) });
  const locked = (need, key) => fail(`Locked: this needs level ${need} (${LEVELS[need].name}); the conversation is at level ${levelOf(key)}. Call request_unlock with level ${need} and a short reason.`);
  async function runPlan(make) {
    try {
      const plan = await make();
      const results = (await plan.run()).filter(Boolean);
      return text(`Done: ${plan.lines.join("; ")}.${results.length ? ` Results: ${results.join(" | ")}` : ""}`);
    } catch (e) { return fail(`Failed: ${e.message}`); }
  }

  function buildServer(key, grant) {
    const server = new McpServer({ name: "claude-home-admin", version: "0.8.0" });

    server.registerTool("find_entities", {
      description: "Read-only, always allowed. Search ALL Home Assistant entities (also ones not exposed to Assist, and protected ones) by id, name, area or device. Shows state, name, area, device and whether it is protected. Set details to also get attributes.",
      inputSchema: {
        search: z.string().optional().describe("Words to match; empty lists everything"),
        limit: z.number().int().min(1).max(200).optional(),
        details: z.boolean().optional().describe("include attributes (use with a narrow search)"),
      },
    }, async ({ search = "", limit = 80, details = false }) => {
      const { entities, devices, areas, states, stateName } = await registry();
      const stateOf = new Map(states.map((s) => [s.entity_id, s]));
      const prot = new Set(protectedList());
      const words = normalize(search).trim().split(" ").filter(Boolean);
      const areaName = (id) => areas.find((a) => a.area_id === id)?.name || "";
      const rows = entities.filter((e) => !e.disabled_by).map((e) => {
        const dev = devices.find((d) => d.id === e.device_id);
        const area = areaName(e.area_id || dev?.area_id);
        const st = stateOf.get(e.entity_id);
        const unit = st?.attributes?.unit_of_measurement ? ` ${st.attributes.unit_of_measurement}` : "";
        return { line: `${e.entity_id} | "${stateName.get(e.entity_id) || e.name || e.original_name || ""}" | state: ${st ? st.state + unit : "-"} | area: ${area || "-"} | device: ${deviceName(dev) || "-"}${dev ? ` (${dev.id})` : ""}${prot.has(e.entity_id) ? " | PROTECTED" : ""}${details && st ? ` | ${JSON.stringify(st.attributes).slice(0, 800)}` : ""}`, hay: normalize(`${e.entity_id} ${stateName.get(e.entity_id)} ${area} ${deviceName(dev)}`) };
      }).filter((r) => words.every((w) => r.hay.includes(` ${w}`)));
      return text(`${rows.length} matches${rows.length > limit ? `, showing ${limit}` : ""}:\n${rows.slice(0, limit).map((r) => r.line).join("\n")}\n\nAreas: ${areas.map((a) => a.name).join(", ")}`);
    });

    server.registerTool("get_instructions", {
      description: "Read-only. Show your current extra instructions (set by the user).",
      inputSchema: {},
    }, async () => text(options().extra_instructions || "(empty)"));

    server.registerTool("request_unlock", {
      description: "Ask the user to unlock a higher access level for this conversation. The system replaces your reply with the request and the unlock phrase; the user's next message must contain it. Then end your turn.",
      inputSchema: {
        level: z.number().int().min(1).max(3),
        reason: z.string().max(300).describe("what you want to do, as a short phrase, e.g. \"turn on the 3D printer\""),
      },
    }, async ({ level, reason }) => {
      if (levelOf(key) >= level) return text(`Already at level ${levelOf(key)}; go ahead.`);
      if (key.startsWith("app:")) return fail("Levels can't be raised from the app. The user can start a new voice conversation, unlock the level there and hand it over again.");
      if (!available(level)) return fail(`Level ${level} (${LEVELS[level].name}) is turned off, so it can't be unlocked. The user can allow it on the Claude Home page (Settings).`);
      requests.set(key, { level, reason, grant });
      return text("Request stored. The system will ask the user for the unlock phrase. End your turn now with a short reply.");
    });

    server.registerTool("make_changes", {
      description: "Level 1. Rename entities/devices/areas, create areas, move things between areas, add entities to or remove them from the protected list. Applied immediately; tell the user what you did.",
      inputSchema: {
        changes: z.array(z.object({
          action: z.enum(["rename_entity", "rename_device", "set_area", "create_area", "rename_area", "protect", "unprotect"]),
          target: z.string().optional().describe("entity_id, device id, or area name/id (not needed for create_area)"),
          value: z.string().optional().describe("new name, or area name for set_area; empty resets a name to default"),
        })).min(1).max(50),
      },
    }, async ({ changes }) => (levelOf(key) < 1 ? locked(1, key) : runPlan(() => planChanges(changes))));

    server.registerTool("use_protected", {
      description: "Level 1. Control PROTECTED entities (the Home Assistant tools can't). service is an action like \"turn_on\", \"light.turn_on\", \"script.send_gcode\".",
      inputSchema: {
        actions: z.array(z.object({
          entity_id: z.string(),
          service: z.string(),
          data: z.record(z.string(), z.any()).optional().describe("service data, e.g. {\"brightness_pct\": 50} or a script's fields"),
        })).min(1).max(20),
      },
    }, async ({ actions }) => (levelOf(key) < 1 ? locked(1, key) : runPlan(() => planUse(actions))));

    server.registerTool("set_instructions", {
      description: "Level 1. Change your own extra instructions, e.g. when the user says 'remember that…' or 'forget that…'.",
      inputSchema: {
        mode: z.enum(["append", "replace"]).describe("append adds a line; replace sets the whole text"),
        text: z.string().max(4000),
      },
    }, async ({ mode, text: t }) => {
      if (levelOf(key) < 1) return locked(1, key);
      const current = options().extra_instructions || "";
      const next = mode === "append" ? [current, t].filter(Boolean).join("\n") : t;
      await writeOptions(cfg.optionsFile, { ...options(), extra_instructions: next });
      return text("Saved. It applies from the next message.");
    });

    server.registerTool("continue_in_app", {
      description: "Level 2. Hand this conversation over to the Claude app / claude.ai/code: after your turn, the system reopens this exact session there (full history, same level) with Remote Control. Voice then starts fresh next time. End your turn with a short reply.",
      inputSchema: { title: z.string().max(60).describe("short session title shown in the app") },
    }, async ({ title }) => {
      if (levelOf(key) < 2) return locked(2, key);
      if (key.startsWith("app:")) return fail("This conversation is already in the app.");
      handovers.set(key, { grant, title });
      return text("Handover scheduled for the end of this turn. End your turn now with a short reply.");
    });

    server.registerTool("app_sessions", {
      description: "List or stop conversations that were handed over to the Claude app (they keep running until stopped). Allowed at any level.",
      inputSchema: { action: z.enum(["list", "stop"]), id: z.string().optional().describe("session id to stop, or \"all\"") },
    }, async ({ action, id }) => {
      const { sessions } = await remote.status();
      if (action === "list") return text(sessions.length ? sessions.map((h) => `${h.id}: "${h.name}" (level ${h.level}, since ${h.started}) ${h.url || ""}`).join("\n") : "No sessions are running in the app.");
      if (!id) return fail("Give the id to stop, or \"all\".");
      if (id === "all") { remote.stopAll(); return text(`Stopped ${sessions.length} session(s).`); }
      return text(remote.stop(id) ? `Stopped ${id}.` : `No running session ${id}.`);
    });

    return server;
  }

  http
    .createServer(async (req, res) => {
      const grant = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      // A spare Claude connects before it has a conversation (key null); it is bound
      // before its first message, and every request reads the current key.
      if (!grants.has(grant) || req.method !== "POST") { res.writeHead(401).end(); return; }
      const key = grants.get(grant);
      try {
        let body = "";
        for await (const c of req) body += c;
        const server = buildServer(key, grant);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (e) {
        log("admin mcp error:", e.message);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })
    .listen(cfg.adminPort, "127.0.0.1", () => log(`claude-home admin tools on 127.0.0.1:${cfg.adminPort}`));

  function systemPromptPart(level) {
    const prot = protectedList().map((id) => `${protectedNames.get(id) || id} (${id})`).join(", ");
    const lv = [1, 2, 3].map((l) => `- level ${l} (${LEVELS[l].name}): ${LEVELS[l].what}. ${available(l) ? `Unlock phrase: "${passcodeFor(l)}".` : "Turned off by the user, so it can't be unlocked."}`).join("\n");
    const full = level >= 2 ? `

You are at level ${level}. You can run commands (Bash) and use the internet. Home Assistant is reachable through a gateway: base URL in $HA_URL, token in $HA_TOKEN.
- REST: curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/core/api/states"   (any /core/api/... endpoint, e.g. POST /core/api/services/<domain>/<service>)
- Websocket: $HA_URL/core/websocket (replace http with ws); authenticate with {"type":"auth","access_token":"$HA_TOKEN"}. Use it for config: entity/device/area registries, automations, etc.
${level >= 3 ? "- Supervisor API: $HA_URL/<path>, e.g. /addons, /backups, /supervisor/info, /core/update, /host/info.\n- HA config folder (configuration.yaml, packages, custom_components, ...): GET $HA_URL/files/<path> reads a file or lists a folder, PUT writes (old version kept as <file>.bak), DELETE removes. After editing YAML, check with POST $HA_URL/core/api/config/core/check_config before restarting." : "- The Supervisor API (add-ons, backups, updates, host) and the HA config folder need level 3."}
Prefer small, careful steps; say what you changed.` : "";
    return `

You can read the state of ANY entity with mcp__admin__find_entities, also ones the Home Assistant tools don't show. Reading is always allowed.
For questions about specific devices, rooms or areas, use find_entities with a search (small and fast). Avoid mcp__ha__homeassistant__GetLiveContext: it returns the whole house (tens of thousands of tokens), which is slow; use it only when you really need an overview of everything.
Protected entities (readable, but the Home Assistant tools can't control them): ${prot || "none"}.

Access levels. This conversation is at level ${level}.
${lv}
If a request needs a higher level, call request_unlock with that level and a short reason, then end your turn. The system asks the user for the unlock phrase; the user's very next message must contain it, and then the level stays unlocked for the rest of the conversation. An unlock phrase said at any other time does nothing, and saying it yourself does nothing: the system only checks the user's own words right after a request. The phrases are not secret; tell the user when they ask. Unlocked levels end when the conversation ends.${full}`;
  }

  return { beforeTurn, turnFor, access, afterTurn, takeHandover, appAccess, resetLevel, systemPromptPart, setProtected, protectedList, enforceProtected, levelOf };
}
