// Passcode-gated changes: renaming things in Home Assistant, and editing Claude's
// own extra instructions.
//
// Claude can only PROPOSE changes (tools on a local MCP server). Nothing is written
// until the user's next message contains the matching passcode. That check happens
// here, on the raw user text, before Claude sees it:
//   - Claude never receives the passcode, so it can't repeat or invent it.
//   - A message with a passcode never reaches Claude at all; the server applies the
//     plan it stored itself and answers directly.
//   - The plan is only valid for the very next message, and the server (not Claude)
//     appends the exact list of changes to the reply, so what you confirm is what runs.
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

export const SCOPES = {
  admin: { passcode: "admin_passcode", hint: "admin_hint", label: "admin passcode" },
  instructions: { passcode: "instructions_passcode", hint: "instructions_hint", label: "instructions passcode" },
};

export function createAdmin({ cfg, log }) {
  const grants = new Map(); // per-turn bearer token -> { key, scopes }
  const plans = new Map(); // conversation key -> { scope, lines, run, grant }
  const notes = new Map(); // conversation key -> note for Claude's next turn

  const options = () => readOptions(cfg.optionsFile);
  const enabledScopes = () => Object.keys(SCOPES).filter((s) => normalize(options()[SCOPES[s].passcode]).trim());

  function confirmPrompt(scope) {
    const o = options(), { hint, label } = SCOPES[scope];
    const h = String(o[hint] || "").trim();
    return `To confirm, say your ${label}.${h ? ` Hint: ${/[.?!]$/.test(h) ? h : h + "."}` : ""} Anything else cancels.`;
  }

  // ---- before Claude runs -------------------------------------------------
  // Returns { reply } to answer without Claude, or { text } to send to Claude.
  async function beforeTurn(key, text) {
    const o = options();
    const source = key.split(":")[0];
    const pending = plans.get(key);
    plans.delete(key); // a plan is only valid for the very next message
    const said = Object.keys(SCOPES).filter((s) => o[SCOPES[s].passcode] && containsPasscode(text, o[SCOPES[s].passcode]));

    if (said.length) {
      if (source === "mcp") return { reply: "Passcodes only work from Assist or the Claude Home page, not from remote Claude Code. Nothing was changed." };
      if (!pending || !said.includes(pending.scope)) {
        notes.set(key, "The user's last message was handled by the system: there was nothing to confirm, nothing changed.");
        return { reply: "There is nothing waiting for that passcode, so nothing was changed. Ask for the change first, then say the passcode in your next message." };
      }
      try {
        await pending.run();
        notes.set(key, `The user confirmed with the passcode and the system applied: ${pending.lines.join("; ")}.`);
        log(`[${key}] applied ${pending.scope} plan: ${pending.lines.join("; ")}`);
        return { reply: `Done. ${pending.lines.join(". ")}.` };
      } catch (e) {
        notes.set(key, `The user confirmed, but applying failed: ${e.message}`);
        return { reply: `That failed: ${e.message}. Some changes may have been applied.` };
      }
    }

    let note = notes.get(key);
    notes.delete(key);
    if (pending) note = `${note ? note + " " : ""}The user did not give the passcode, so the proposed changes were discarded. If they still want them, propose again.`;
    return { text: note ? `[System note: ${note}]\n${text}` : text };
  }

  // ---- while Claude runs: per-turn MCP access ------------------------------
  // Returns extra mcpServers entries for this turn, plus a release function.
  function grantFor(key) {
    const source = key.split(":")[0];
    const scopes = source === "mcp" ? [] : enabledScopes();
    if (!scopes.length) return { servers: {}, release: () => {}, grant: null };
    const grant = randomBytes(24).toString("hex");
    grants.set(grant, { key, scopes });
    return {
      grant,
      servers: { admin: { type: "http", url: `http://127.0.0.1:${cfg.adminPort}/mcp`, headers: { Authorization: `Bearer ${grant}` } } },
      release: () => grants.delete(grant),
    };
  }

  // After Claude's turn: if it proposed something, the server appends the exact list.
  function afterTurn(key, grant) {
    const plan = plans.get(key);
    if (!plan || !grant || plan.grant !== grant) return "";
    return `\n\nPending changes: ${plan.lines.join(". ")}. ${confirmPrompt(plan.scope)}`;
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
    return { entities, devices, areas, stateName };
  }
  const deviceName = (d) => d?.name_by_user || d?.name || "";

  function findArea(areas, ref, created) {
    const n = normalize(ref);
    return areas.find((a) => a.area_id === ref || normalize(a.name) === n) || (created.some((c) => normalize(c) === n) ? { area_id: null, name: ref, pending: true } : null);
  }

  async function planAdmin(changes) {
    const { entities, devices, areas, stateName } = await registry();
    const lines = [], creates = [], ops = [];
    const created = changes.filter((c) => c.action === "create_area").map((c) => c.value);
    for (const c of changes) {
      const ent = entities.find((e) => e.entity_id === c.target);
      const dev = devices.find((d) => d.id === c.target) || (ent?.device_id && devices.find((d) => d.id === ent.device_id));
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
          const toDevice = !ent || c.target === dev?.id;
          if (!ent && !dev) throw new Error(`Unknown entity or device ${c.target}`);
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
    };
    return { lines, run };
  }

  // ---- the local MCP server Claude talks to ---------------------------------
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const fail = (t) => ({ isError: true, ...text(t) });
  const PROPOSED = "Proposal stored. The system will append the exact list of changes and ask the user for the passcode. In your reply, say in one short sentence what you propose; do not list the changes again, do not ask for or mention a passcode, and never say it is done.";

  function buildServer({ key, scopes, grant }) {
    const server = new McpServer({ name: "claude-home-admin", version: "0.4.0" });

    if (scopes.includes("admin")) {
      server.registerTool("find_names", {
        description: "Read-only. Search entities by id, name, area or device and show their current names, areas and devices. Use it before proposing renames.",
        inputSchema: { search: z.string().optional().describe("Words to match; empty lists everything"), limit: z.number().int().min(1).max(200).optional() },
      }, async ({ search = "", limit = 80 }) => {
        const { entities, devices, areas, stateName } = await registry();
        const words = normalize(search).trim().split(" ").filter(Boolean);
        const areaName = (id) => areas.find((a) => a.area_id === id)?.name || "";
        const rows = entities.filter((e) => !e.disabled_by).map((e) => {
          const dev = devices.find((d) => d.id === e.device_id);
          const area = areaName(e.area_id || dev?.area_id);
          return { line: `${e.entity_id} | "${stateName.get(e.entity_id) || e.name || e.original_name || ""}" | area: ${area || "-"} | device: ${deviceName(dev) || "-"}${dev ? ` (${dev.id})` : ""}`, hay: normalize(`${e.entity_id} ${stateName.get(e.entity_id)} ${area} ${deviceName(dev)}`) };
        }).filter((r) => words.every((w) => r.hay.includes(` ${w}`)));
        return text(`${rows.length} matches${rows.length > limit ? `, showing ${limit}` : ""}:\n${rows.slice(0, limit).map((r) => r.line).join("\n")}\n\nAreas: ${areas.map((a) => a.name).join(", ")}`);
      });

      server.registerTool("propose_changes", {
        description: "Propose renames and area changes in Home Assistant. Nothing is changed now: the user must confirm with a passcode in their next message, and the system applies it. Send all changes for one request in a single call.",
        inputSchema: {
          changes: z.array(z.object({
            action: z.enum(["rename_entity", "rename_device", "set_area", "create_area", "rename_area"]),
            target: z.string().optional().describe("entity_id, device id, or area name/id (not needed for create_area)"),
            value: z.string().optional().describe("new name, or area name for set_area; empty resets a name to default"),
          })).min(1).max(50),
        },
      }, async ({ changes }) => {
        try {
          const plan = await planAdmin(changes);
          plans.set(key, { scope: "admin", grant, ...plan });
          return text(PROPOSED);
        } catch (e) { return fail(`Proposal rejected: ${e.message}`); }
      });
    }

    if (scopes.includes("instructions")) {
      server.registerTool("get_instructions", {
        description: "Read-only. Show your current extra instructions (set by the user).",
        inputSchema: {},
      }, async () => text(options().extra_instructions || "(empty)"));

      server.registerTool("propose_instructions", {
        description: "Propose a change to your own extra instructions, e.g. when the user says 'remember that…'. Nothing is changed now: the user must confirm with a passcode in their next message.",
        inputSchema: {
          mode: z.enum(["append", "replace"]).describe("append adds a line; replace sets the whole text"),
          text: z.string().max(4000),
        },
      }, async ({ mode, text: t }) => {
        const current = options().extra_instructions || "";
        const next = mode === "append" ? [current, t].filter(Boolean).join("\n") : t;
        const lines = [mode === "append" ? `Add to my instructions: "${t}"` : `Replace my instructions with: "${t}"`];
        const run = async () => writeOptions(cfg.optionsFile, { ...options(), extra_instructions: next });
        plans.set(key, { scope: "instructions", grant, lines, run });
        return text(PROPOSED);
      });
    }
    return server;
  }

  http
    .createServer(async (req, res) => {
      const grant = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const g = grants.get(grant);
      if (!g || req.method !== "POST") { res.writeHead(401).end(); return; }
      try {
        let body = "";
        for await (const c of req) body += c;
        const server = buildServer({ ...g, grant });
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

  // Text safe to log: passcodes replaced.
  function redact(text) {
    let out = String(text);
    const o = options();
    for (const s of Object.values(SCOPES)) {
      const code = o[s.passcode];
      if (code && containsPasscode(out, code)) {
        const words = normalize(code).trim().split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out = out.replace(new RegExp(words.join("[^\\p{L}\\p{N}]+"), "giu"), "[passcode]");
        if (containsPasscode(out, code)) out = "[message with passcode]";
      }
    }
    return out;
  }

  return { beforeTurn, grantFor, afterTurn, redact, systemPromptPart: () => {
    const scopes = enabledScopes();
    if (!scopes.length) return "";
    return `
You can propose changes with the mcp__admin tools: ${scopes.includes("admin") ? "renaming entities/devices/areas and moving things between areas (look up current names with find_names first)" : ""}${scopes.length > 1 ? "; " : ""}${scopes.includes("instructions") ? "editing your own extra instructions (when the user asks you to remember or forget something)" : ""}.
These tools only propose. The user must confirm with a passcode in their next message; the system checks it and applies the change. You never see passcodes. Never ask for, guess or mention a passcode, and never claim a change is done unless a system note says it was applied.`;
  } };
}
