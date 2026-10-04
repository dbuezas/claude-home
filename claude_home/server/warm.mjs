// Fast mode: keep Claude running between messages instead of starting `claude -p` for
// each one. Saves ~0.7-0.9 s per message (start-up and connecting to Home Assistant)
// at ~120-210 MB of RAM per running Claude.
//
// - Each conversation keeps its own Claude (claude -p --input-format stream-json).
// - One spare Claude waits, already started, for the next new conversation.
// - A Claude is replaced when what it was started with changes (level, model, effort,
//   system prompt); the replacement resumes the same session from disk.
// - At most `max` run at once (the spare included); unused ones close after `idleMs`.
// Conversations are saved on disk, so closing a Claude loses nothing: the next message
// resumes the session.

export function createPool({ launch, log }) {
  const live = new Map(); // conversation key -> entry
  let spare = null;
  let limits = { max: 3, idleMs: 15 * 60_000 };

  // launch({ level, sid, key }) -> { proc, access }; entry tracks one running Claude.
  function start(fp, level, sid, key) {
    const { proc, access } = launch({ level, sid, key });
    const e = { proc, access, fp, level, key, last: Date.now(), busy: false, closed: false, buf: "", stderr: "", waiter: null, tools: [] };
    proc.stdout.on("data", (d) => {
      e.buf += d;
      let i;
      while ((i = e.buf.indexOf("\n")) >= 0) {
        const line = e.buf.slice(0, i); e.buf = e.buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "assistant") {
          for (const c of m.message?.content || []) if (c.type === "tool_use") e.tools.push(c.name.replace(/^mcp__ha__/, "").replace(/^mcp__admin__/, "admin."));
        }
        if (m.type === "result" && e.waiter) { const w = e.waiter; e.waiter = null; w.resolve(m); }
      }
    });
    proc.stderr.on("data", (d) => { e.stderr = (e.stderr + d).slice(-2000); });
    proc.on("close", (code) => {
      e.closed = true;
      e.access.release();
      if (e.waiter) { const w = e.waiter; e.waiter = null; w.reject(new Error(`claude exited ${code}: ${e.stderr.trim().slice(-400)}`)); }
      if (live.get(e.key) === e) live.delete(e.key);
      if (spare === e) spare = null;
    });
    proc.on("error", (err) => e.waiter?.reject(err));
    return e;
  }

  const kill = (e) => { if (e && !e.closed) e.proc.kill("SIGTERM"); };
  const count = () => live.size + (spare ? 1 : 0);

  // Close the least recently used idle Claudes until there is room for one more.
  function makeRoom() {
    while (count() >= limits.max) {
      const idle = [...live.values()].filter((e) => !e.busy).sort((a, b) => a.last - b.last)[0];
      if (idle) { live.delete(idle.key); kill(idle); continue; }
      if (spare) { kill(spare); spare = null; continue; }
      break; // all busy: allow one more for now
    }
  }

  function send(e, text, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { kill(e); reject(new Error(`claude timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      e.tools = [];
      e.waiter = {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      e.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
  }

  // One message. fp: what the Claude must have been started with; sid: session to resume.
  async function ask({ key, fp, level, sid, text, timeoutMs }) {
    let e = live.get(key);
    if (e && (e.closed || e.fp !== fp)) { live.delete(key); kill(e); e = null; }
    if (!e && !sid && spare && !spare.closed && spare.fp === fp) {
      e = spare; spare = null;
      e.key = key; e.access.bind(key);
    }
    if (!e) { makeRoom(); e = start(fp, level, sid, key); }
    live.set(key, e);
    e.busy = true;
    try {
      const m = await send(e, await text, timeoutMs);
      return { m, tools: e.tools.slice(), access: e.access };
    } finally {
      e.busy = false;
      e.last = Date.now();
    }
  }

  // Keep one spare ready (spec() -> { fp, level } or null when fast mode is off).
  function refill(spec) {
    const want = spec();
    if (spare && (spare.closed || !want || spare.fp !== want.fp)) { kill(spare); spare = null; }
    if (!want || spare) return;
    if (count() >= limits.max) return;
    spare = start(want.fp, want.level, undefined, null);
    log(`fast mode: spare Claude started (${count()}/${limits.max} running)`);
  }

  // Close a conversation's Claude and wait until it has exited (before a handover).
  async function close(key) {
    const e = live.get(key);
    if (!e) return;
    live.delete(key);
    if (e.closed) return;
    const done = new Promise((r) => e.proc.once("close", r));
    kill(e);
    await done;
  }

  function closeAll() { for (const e of live.values()) kill(e); live.clear(); kill(spare); spare = null; }

  function configure({ max, idleMs }) {
    limits = { max, idleMs };
    while (count() > max) {
      const idle = [...live.values()].filter((e) => !e.busy).sort((a, b) => a.last - b.last)[0];
      if (idle) { live.delete(idle.key); kill(idle); } else if (spare) { kill(spare); spare = null; } else break;
    }
  }

  // Close Claudes unused for longer than idleMs (the spare stays).
  setInterval(() => {
    for (const e of live.values()) if (!e.busy && Date.now() - e.last > limits.idleMs) { live.delete(e.key); kill(e); }
  }, 30_000).unref();

  const status = () => ({ running: count(), conversations: live.size, spare: !!spare, ...limits });

  return { ask, refill, close, closeAll, configure, status };
}
