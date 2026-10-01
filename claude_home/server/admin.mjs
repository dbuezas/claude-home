// Passcode-gated changes: renaming things in Home Assistant, and editing Claude's
// own extra instructions.
//
// Claude can only PROPOSE changes (tools on a local MCP server). The server stores
// the exact plan and appends it to the reply. The passcode is not a secret: it only
// proves the confirmation came from the user. The server checks it on the user's
// raw message (never on anything Claude writes), and only in the message right
// after the proposal. If it matches, the server applies the stored plan, then
// Claude gets the message plus a note saying what was applied.
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

  const options = () => readOptions(cfg.optionsFile);
  const enabledScopes = () => Object.keys(SCOPES).filter((s) => normalize(options()[SCOPES[s].passcode]).trim());

  function confirmPrompt(scope) {
    const o = options(), { hint, label } = SCOPES[scope];
    const h = String(o[hint] || "").trim();
    return `To confirm, say your ${label}.${h ? ` Hint: ${/[.?!]$/.test(h) ? h : h + "."}` : ""} Anything else cancels.`;
  }

  // ---- before Claude runs -------------------------------------------------
  // Applies a pending plan if this message confirms it. Returns the text for Claude.
  async function beforeTurn(key, text) {
    const o = options();
    const source = key.split(":")[0];
    const pending = plans.get(key);
    plans.delete(key); // a plan is only valid for the very next message
    const said = Object.keys(SCOPES).filter((s) => o[SCOPES[s].passcode] && containsPasscode(text, o[SCOPES[s].passcode]));

    let note = "";
    if (said.length && source === "mcp") {
      note = "The message contains a passcode, but passcodes don't work from remote Claude Code. Nothing was changed.";
    } else if (said.length && pending && said.includes(pending.scope)) {
      try {
        await pending.run();
        log(`[${key}] applied ${pending.scope} plan: ${pending.lines.join("; ")}`);
        note = `The user confirmed with the passcode and the system applied: ${pending.lines.join("; ")}. Confirm briefly.`;
      } catch (e) {
        note = `The user confirmed with the passcode, but applying failed: ${e.message}. Some changes may have been applied.`;
      }
    } else if (said.length) {
      note = "The message contains a passcode, but nothing was waiting for it, so nothing was changed. Changes must be proposed first, then confirmed in the next message.";
    } else if (pending) {
      note = "The user did not give the passcode, so the proposed changes were discarded.";
    }
    return note ? `[System note: ${note}]\n${text}` : text;
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
  const PROPOSED = "Proposal stored. The system will append the exact list of changes and ask the user for the passcode. In your reply, say in one short sentence what you propose; do not list the changes again or ask for the passcode (the system does), and never say it is done.";

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

  return { beforeTurn, grantFor, afterTurn, systemPromptPart: () => {
    const scopes = enabledScopes();
    if (!scopes.length) {
      return `
You cannot rename things, change areas or edit your own instructions. If asked, say the user can turn this on by setting passcodes on the Claude Home page (Settings).`;
    }
    const can = [
      scopes.includes("admin") && "rename entities, devices and areas, create areas and move things between areas (admin passcode; look up current names with find_names first)",
      scopes.includes("instructions") && "edit your own extra instructions, e.g. when the user says \"remember that…\" or \"forget that…\" (instructions passcode)",
    ].filter(Boolean).join("; and ");
    return `

Confirmation protocol for changes. With the mcp__admin tools you can ${can}.
1. These tools only PROPOSE. Call the propose tool once with every change for the request. Then reply with one short sentence about what you propose. The system appends the exact list of changes and asks for the passcode, with the user's reminder question.
2. The user's NEXT message must contain the matching passcode. The system checks it in the user's own words (never in your text) and applies exactly the stored list. Any other message cancels the proposal.
3. You learn the outcome from a [System note] at the start of the user's message. Only say something was done when a system note says it was applied.
The passcode is not a secret; it only proves the confirmation came from the user. You don't know it and can't confirm for the user. Don't ask for it yourself. If the user wants to confirm but no passcode was recognized, say nothing was changed and ask them to request it again and then say the passcode. If they ask how this works, explain these steps simply.`;
  } };
}
