// Shared helpers: Supervisor API, Home Assistant websocket, add-on options.
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const env = process.env;
const supervisorToken = env.SUPERVISOR_TOKEN || "";

export async function supervisor(path, init = {}) {
  const r = await fetch(`http://supervisor${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${supervisorToken}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.result === "error") throw new Error(body.message || `supervisor ${path}: HTTP ${r.status}`);
  return body.data;
}

// One short-lived websocket per call. Messages are sent together; results come back in order.
export function haWs(messages) {
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

export function readOptions(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

// Save to the Supervisor (so the Configuration tab shows it) and to options.json
// (the Supervisor only rewrites that file on restart, and we read it live).
export async function writeOptions(file, options) {
  const next = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== "" && v != null));
  // Removed options; the Supervisor rejects unknown ones.
  for (const k of ["planner_model", "admin_hint", "instructions_hint", "admin_passcode", "instructions_passcode"]) delete next[k];
  await supervisor("/addons/self/options", { method: "POST", body: JSON.stringify({ options: next }) });
  writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
}
