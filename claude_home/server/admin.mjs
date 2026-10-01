// Passcode-gated changes and protected entities.
//
// Claude can only PROPOSE (tools on a local MCP server): renames and areas, its own
// extra instructions, the protected list, and any interaction with a protected entity.
// The server stores the exact plan and replaces Claude's reply with it. The passcode
// is not a secret: it only proves the confirmation came from the user. The server
// checks it on the user's raw message (never on anything Claude writes). A proposal
// stays pending until the user's newest message contains the passcode, Claude cancels
// it (the user said no), a new proposal replaces it, or it expires. On a match the
// server applies the stored plan, then Claude gets the message plus a note with the result.
//
// Protected entities are kept un-exposed from Assist, so Home Assistant's own MCP
// tools can't see or touch them (not even through area-wide commands). The only way
// to read or control them is a proposal confirmed with the passcode.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { haWs, readOptions, writeOptions } from "./ha.mjs";

export const normalize = (s) =>
  ` ${String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

// True if the passcode appears in the text as whole words (case, accents and punctuation ignored).
export const containsPasscode = (text, code) => normalize(code).trim() !== "" && normalize(text).includes(normalize(code));

const PLAN_TTL_MS = 10 * 60_000;
const ENFORCE_EVERY_MS = 30_000;

export function createAdmin({ cfg, log }) {
  const grants = new Map(); // per-turn bearer token -> conversation key
  const plans = new Map(); // conversation key -> { lines, run, grant, at }
  let protectedNames = new Map(); // entity_id -> friendly name (for the system prompt)
  let lastEnforced = 0;

  const options = () => readOptions(cfg.optionsFile);
  const passcode = () => String(options().passcode || "").trim();
  const enabled = () => normalize(passcode()).trim() !== "";
  const protectedList = () => [...new Set(options().protected_entities || [])];

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
  // Applies a pending plan if this message confirms it. Returns the text for Claude.
  async function beforeTurn(key, text) {
    await enforceProtected();
    let pending = plans.get(key);
    if (pending && Date.now() - pending.at > PLAN_TTL_MS) { plans.delete(key); pending = null; }
    const said = enabled() && containsPasscode(text, passcode());

    let note = "";
    if (said && pending) {
      plans.delete(key);
      try {
        const results = (await pending.run()).filter(Boolean);
        log(`[${key}] applied plan: ${pending.lines.join("; ")}`);
        note = `The user confirmed with the passcode and the system did: ${pending.lines.join("; ")}.${results.length ? ` Results: ${results.join(" | ")}` : ""} Tell the user briefly.`;
      } catch (e) {
        note = `The user confirmed with the passcode, but it failed: ${e.message}. Some steps may have been done.`;
      }
    } else if (said) {
      note = "The message contains the passcode, but nothing was waiting for it, so nothing was done. Propose first, then the user confirms with the passcode.";
    } else if (pending) {
      note = `A proposal is still waiting: ${pending.lines.join("; ")}. This message does not contain the passcode "${passcode()}". If the user meant to confirm, say the passcode wasn't recognized and ask them to say "${passcode()}" again. If they decline, call cancel_proposal. If they want something different, propose again (that replaces it).`;
    }
    return note ? `[System note: ${note}]\n${text}` : text;
  }

  // ---- while Claude runs: per-turn MCP access ------------------------------
  function grantFor(key) {
    if (!enabled()) return { servers: {}, release: () => {}, grant: null };
    const grant = randomBytes(24).toString("hex");
    grants.set(grant, key);
    return {
      grant,
      servers: { admin: { type: "http", url: `http://127.0.0.1:${cfg.adminPort}/mcp`, headers: { Authorization: `Bearer ${grant}` } } },
      release: () => grants.delete(grant),
    };
  }

  // After Claude's turn: if it proposed something, the reply is replaced by the exact list.
  function afterTurn(key, grant) {
    const plan = plans.get(key);
    if (!plan || !grant || plan.grant !== grant) return "";
    return `I'll do this: ${plan.lines.join(". ")}. To confirm, say "${passcode()}". Say no to cancel.`;
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
          lines.push(c.action === "protect" ? `Protect ${label(c.target)}: from then on, any use needs the passcode` : `Unprotect ${label(c.target)}: you get normal access to it again`);
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
      if (a.service === "read") {
        lines.push(`Read the state of ${name}`);
        steps.push(async () => {
          const [all] = await haWs([{ type: "get_states" }]);
          const now = all.find((s) => s.entity_id === a.entity_id);
          return `${a.entity_id}: ${now?.state} ${JSON.stringify(now?.attributes || {}).slice(0, 1500)}`;
        });
        continue;
      }
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
  const PROPOSED = "Proposal stored. The system replaces your reply with the exact list and the passcode to say, so just end your turn with a short reply.";
  const store = (key, grant, plan) => { plans.set(key, { grant, at: Date.now(), ...plan }); return text(PROPOSED); };

  function buildServer(key, grant) {
    const server = new McpServer({ name: "claude-home-admin", version: "0.5.0" });

    server.registerTool("find_names", {
      description: "Read-only. Search entities by id, name, area or device and show their current names, areas, devices and whether they are protected. Use it before proposing changes.",
      inputSchema: { search: z.string().optional().describe("Words to match; empty lists everything"), limit: z.number().int().min(1).max(200).optional() },
    }, async ({ search = "", limit = 80 }) => {
      const { entities, devices, areas, stateName } = await registry();
      const prot = new Set(protectedList());
      const words = normalize(search).trim().split(" ").filter(Boolean);
      const areaName = (id) => areas.find((a) => a.area_id === id)?.name || "";
      const rows = entities.filter((e) => !e.disabled_by).map((e) => {
        const dev = devices.find((d) => d.id === e.device_id);
        const area = areaName(e.area_id || dev?.area_id);
        return { line: `${e.entity_id} | "${stateName.get(e.entity_id) || e.name || e.original_name || ""}" | area: ${area || "-"} | device: ${deviceName(dev) || "-"}${dev ? ` (${dev.id})` : ""}${prot.has(e.entity_id) ? " | PROTECTED" : ""}`, hay: normalize(`${e.entity_id} ${stateName.get(e.entity_id)} ${area} ${deviceName(dev)}`) };
      }).filter((r) => words.every((w) => r.hay.includes(` ${w}`)));
      return text(`${rows.length} matches${rows.length > limit ? `, showing ${limit}` : ""}:\n${rows.slice(0, limit).map((r) => r.line).join("\n")}\n\nAreas: ${areas.map((a) => a.name).join(", ")}`);
    });

    server.registerTool("propose_changes", {
      description: "Propose renames, area changes, and adding/removing entities to/from the protected list. Nothing happens now: the user must confirm with the passcode. Send all changes for one request in a single call.",
      inputSchema: {
        changes: z.array(z.object({
          action: z.enum(["rename_entity", "rename_device", "set_area", "create_area", "rename_area", "protect", "unprotect"]),
          target: z.string().optional().describe("entity_id, device id, or area name/id (not needed for create_area)"),
          value: z.string().optional().describe("new name, or area name for set_area; empty resets a name to default"),
        })).min(1).max(50),
      },
    }, async ({ changes }) => {
      try { return store(key, grant, await planChanges(changes)); } catch (e) { return fail(`Proposal rejected: ${e.message}`); }
    });

    server.registerTool("propose_use", {
      description: "Propose reading or controlling PROTECTED entities (the only way to touch them). service is \"read\" to get the current state, or an action like \"turn_on\", \"light.turn_on\", \"script.send_gcode\". Nothing happens now: the user must confirm with the passcode.",
      inputSchema: {
        actions: z.array(z.object({
          entity_id: z.string(),
          service: z.string(),
          data: z.record(z.string(), z.any()).optional().describe("service data, e.g. {\"brightness_pct\": 50} or a script's fields"),
        })).min(1).max(20),
      },
    }, async ({ actions }) => {
      try { return store(key, grant, await planUse(actions)); } catch (e) { return fail(`Proposal rejected: ${e.message}`); }
    });

    server.registerTool("get_instructions", {
      description: "Read-only. Show your current extra instructions (set by the user).",
      inputSchema: {},
    }, async () => text(options().extra_instructions || "(empty)"));

    server.registerTool("propose_instructions", {
      description: "Propose a change to your own extra instructions, e.g. when the user says 'remember that…' or 'forget that…'. Nothing happens now: the user must confirm with the passcode.",
      inputSchema: {
        mode: z.enum(["append", "replace"]).describe("append adds a line; replace sets the whole text"),
        text: z.string().max(4000),
      },
    }, async ({ mode, text: t }) => {
      const current = options().extra_instructions || "";
      const next = mode === "append" ? [current, t].filter(Boolean).join("\n") : t;
      const lines = [mode === "append" ? `Add to my instructions: "${t}"` : `Replace my instructions with: "${t}"`];
      const run = async () => { await writeOptions(cfg.optionsFile, { ...options(), extra_instructions: next }); return []; };
      return store(key, grant, { lines, run });
    });

    server.registerTool("cancel_proposal", {
      description: "Cancel the pending proposal, when the user says no or doesn't want it anymore.",
      inputSchema: {},
    }, async () => text(plans.delete(key) ? "Cancelled. Nothing was done." : "There was no pending proposal."));
    return server;
  }

  http
    .createServer(async (req, res) => {
      const grant = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const key = grants.get(grant);
      if (!key || req.method !== "POST") { res.writeHead(401).end(); return; }
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

  function systemPromptPart() {
    if (!enabled()) {
      return `
You cannot rename things, change areas, edit your own instructions or use protected entities. If asked, say the user can turn this on by setting a passcode on the Claude Home page (Settings).`;
    }
    const prot = protectedList().map((id) => `${protectedNames.get(id) || id} (${id})`).join(", ");
    return `

Confirmation protocol. The passcode is "${passcode()}". With the mcp__admin tools you can propose:
- renames of entities, devices and areas, creating areas, and moving things between areas (look up names with find_names first);
- edits to your own extra instructions (when the user says "remember that…" or "forget that…");
- adding entities to or removing them from the protected list;
- reading or controlling protected entities (propose_use). Protected entities are hidden from the normal Home Assistant tools; propose_use is the only way to touch them.
Protected entities: ${prot || "none"}.
1. These tools only PROPOSE. Call one propose tool with everything for the request. The system then replaces your reply with the exact list and the passcode to say.
2. The proposal waits (up to 10 minutes) until the user's newest message contains the passcode. The system checks it in the user's own words (never in your text) and does exactly the stored list. If the user says no, call cancel_proposal. A new proposal replaces the old one.
3. You learn the outcome from a [System note] at the start of the user's message. Only say something was done when a system note says so.
The passcode is not a secret; it only proves the confirmation came from the user, so saying it yourself does nothing. Tell the user the passcode whenever they need it. If the user seems to confirm but the passcode wasn't recognized (speech recognition may mishear it), say so and ask them to say it again; the proposal is still waiting. If they ask how this works, explain these steps simply.`;
  }

  return { beforeTurn, grantFor, afterTurn, systemPromptPart, setProtected, protectedList, enforceProtected };
}
