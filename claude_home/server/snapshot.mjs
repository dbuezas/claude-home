// A small "home snapshot" sent with every message: the main devices exposed to Assist,
// grouped by area, with their current state. The first message of a conversation gets
// all of it; later ones only what changed (Claude has the rest in its history). It lets Claude answer most state questions
// and find the right device without a tool round trip, for ~3k tokens instead of the
// ~50k of Home Assistant's GetLiveContext.
import { haWs } from "./ha.mjs";

const CONTROL = new Set(["light", "switch", "climate", "cover", "fan", "media_player", "lock", "vacuum", "scene", "script",
  "input_boolean", "humidifier", "water_heater", "alarm_control_panel", "valve"]);
const SENSORS = { sensor: ["temperature", "humidity"], binary_sensor: ["window", "door", "garage_door", "opening"] };
const REGISTRY_TTL_MS = 5 * 60_000;
const MAX_ITEMS = 300;

let registry = { at: 0, value: null };

async function loadRegistry() {
  if (Date.now() - registry.at < REGISTRY_TTL_MS) return registry.value;
  const [exposed, ents, devs, areas] = await haWs([
    { type: "homeassistant/expose_entity/list" },
    { type: "config/entity_registry/list" },
    { type: "config/device_registry/list" },
    { type: "config/area_registry/list" },
  ]);
  const ent = new Map(ents.map((e) => [e.entity_id, e]));
  const dev = new Map(devs.map((d) => [d.id, d]));
  const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
  const value = {
    exposed: exposed.exposed_entities || {},
    ent,
    areaOf: (id) => { const e = ent.get(id); return areaName.get(e?.area_id || dev.get(e?.device_id)?.area_id) || "No area"; },
  };
  registry = { at: Date.now(), value };
  return value;
}

function state(s) {
  const a = s.attributes, d = s.entity_id.split(".")[0];
  if (d === "light" && s.state === "on" && a.brightness != null) return `on ${Math.round(a.brightness / 2.55)}%`;
  if (d === "climate") return `${s.state}, ${a.current_temperature ?? "?"}° now, set ${a.temperature ?? "?"}°`;
  if (d === "cover" && a.current_position != null) return `${s.state} ${a.current_position}%`;
  if (d === "sensor" && !Number.isNaN(Number(s.state))) return `${Math.round(Number(s.state) * 10) / 10}${a.unit_of_measurement || ""}`;
  return s.state;
}

// Current state of the main devices: Map entity_id -> { area, label, text }.
// protectedIds: entities Claude can read but not control with the Assist tools.
export async function homeState(protectedIds = []) {
  const [{ exposed, ent, areaOf }, [states]] = await Promise.all([loadRegistry(), haWs([{ type: "get_states" }])]);
  const prot = new Set(protectedIds);
  const keep = (s) => {
    const d = s.entity_id.split(".")[0], e = ent.get(s.entity_id);
    if (!exposed[s.entity_id]?.conversation && !prot.has(s.entity_id)) return false;
    if (e?.entity_category || e?.hidden_by || e?.disabled_by) return false;
    if (s.state === "unavailable" || s.state === "unknown") return false;
    return CONTROL.has(d) || (SENSORS[d] || []).includes(s.attributes.device_class);
  };
  const items = new Map();
  for (const s of states.filter(keep).slice(0, MAX_ITEMS)) {
    const name = s.attributes.friendly_name || s.entity_id;
    items.set(s.entity_id, {
      area: areaOf(s.entity_id),
      label: `${name} (${s.entity_id}${prot.has(s.entity_id) ? ", protected" : ""})`,
      text: state(s),
    });
  }
  return { time: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), items };
}

function byArea(entries) {
  const g = {};
  for (const [, it, text] of entries) (g[it.area] ||= []).push(`${it.label}: ${text}`);
  return Object.entries(g).sort(([a], [b]) => a.localeCompare(b)).map(([area, xs]) => `${area}: ${xs.join("; ")}`).join("\n");
}

export function renderFull(cur) {
  return `[Home snapshot, ${cur.time}. Main devices only; use tools for anything else.]\n${byArea([...cur.items].map(([id, it]) => [id, it, it.text]))}`;
}

// Only what changed since `prev` (the last snapshot this conversation got).
// Returns the text and the state Claude now knows.
export function renderDiff(prev, cur) {
  const known = new Map(prev.items);
  const lines = [];
  for (const [id, it] of cur.items) {
    const old = prev.items.get(id);
    if (!old || old.text !== it.text) { lines.push([id, it, old ? `${old.text} → ${it.text}` : `${it.text} (new)`]); known.set(id, it); }
  }
  for (const [id, it] of prev.items) if (!cur.items.has(id)) { lines.push([id, it, "now unavailable"]); known.delete(id); }
  const text = lines.length
    ? `[Home snapshot changes since ${prev.time} (everything else as before):]\n${byArea(lines)}`
    : `[Home snapshot: nothing changed since ${prev.time}.]`;
  return { text, known: { time: cur.time, items: known } };
}
