// Remote Control handover: reopen a voice conversation's Claude Code session as an
// interactive Claude with Remote Control on, so it continues in the Claude app or on
// claude.ai/code with its full history (messages and tool calls).
//
// Interactive Claude needs a terminal; ptyrun.py provides a pseudo-terminal and
// answers the start-up questions. Everything runs as the unprivileged "claude" user.
// Remote Control needs a one-time full Claude login (the long-lived token from
// `claude setup-token` can't do it), done from the web UI.
//
// Handed-over sessions show up in the Claude app; they keep running (also across days)
// until stopped from the web UI, by asking Claude, or by restarting the add-on.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const PTYRUN = new URL("./ptyrun.py", import.meta.url).pathname;

export function createRemoteControl({ cfg, user, baseEnv, log }) {
  let login = null; // { proc, url, output, ready }
  const handovers = new Map(); // id -> { id, name, sid, level, started, url, output, proc, release }

  // Remote Control and login must use the full login, not CLAUDE_CODE_OAUTH_TOKEN.
  const env = (extra = {}) => {
    const e = { ...baseEnv(), ...extra };
    delete e.CLAUDE_CODE_OAUTH_TOKEN;
    delete e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    return e;
  };
  const opts = (extra) => ({ cwd: cfg.workDir, env: env(extra), uid: user.uid, gid: user.gid });

  async function status() {
    let loggedIn = false, email = null;
    try {
      const { stdout } = await promisify(execFile)(cfg.claudeBin, ["auth", "status"], opts());
      const s = JSON.parse(stdout);
      loggedIn = !!s.loggedIn;
      email = s.email || null;
    } catch {}
    return {
      loggedIn, email,
      login: login ? { url: login.url } : null,
      sessions: [...handovers.values()].map(({ id, name, level, started, url }) => ({ id, name, level, started, url })),
    };
  }

  // ---- one-time login -------------------------------------------------------
  function startLogin() {
    if (login) return login.ready;
    const proc = spawn(cfg.claudeBin, ["auth", "login"], opts());
    login = { proc, url: null, output: "" };
    login.ready = new Promise((resolve) => {
      const onData = (d) => {
        login.output += d;
        const m = login.output.match(/https:\/\/\S+/);
        if (m && !login.url) { login.url = m[0]; resolve({ url: login.url }); }
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("close", (code) => {
        log(`claude auth login exited ${code}`);
        resolve({ url: null, error: login?.output.slice(-300) });
        login = null;
      });
    });
    return login.ready;
  }

  async function submitCode(code) {
    if (!login) throw new Error("No login in progress. Start it again.");
    const proc = login.proc;
    const done = new Promise((resolve) => proc.on("close", resolve));
    proc.stdin.write(`${String(code).trim()}\n`);
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 30_000));
    if ((await Promise.race([done, timeout])) === "timeout") { proc.kill(); login = null; throw new Error("Login did not finish. Try again."); }
    const s = await status();
    if (!s.loggedIn) throw new Error("Login failed. Try again with a fresh code.");
    return s;
  }

  async function logout() {
    stopAll();
    await promisify(execFile)(cfg.claudeBin, ["auth", "logout"], opts()).catch(() => {});
  }

  // ---- handover -------------------------------------------------------------
  // sid: the voice conversation's Claude Code session. grant: gateway grant for `level`.
  async function handover({ sid, name, level, grant, mcpServers, appendSystemPrompt }) {
    if (!(await status()).loggedIn) { grant.release(); throw new Error("Remote Control needs a one-time Claude login on the Claude Home page (Settings → Remote Control)."); }
    const id = randomUUID().slice(0, 8);
    const args = [
      PTYRUN, cfg.claudeBin, "--resume", sid, "--remote-control", name,
      "--permission-mode", "bypassPermissions",
      "--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config",
      "--append-system-prompt", appendSystemPrompt,
    ];
    const proc = spawn("python3", args, opts({ HA_URL: grant.url, HA_TOKEN: grant.token, CLAUDE_HOME_LEVEL: String(level) }));
    const h = { id, name, sid, level, started: new Date().toISOString(), url: null, output: "", proc, release: grant.release };
    handovers.set(id, h);
    const onData = (d) => {
      h.output = (h.output + d).slice(-20_000);
      const m = h.output.replace(/\s+/g, "").match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/);
      if (m && !h.url) { h.url = m[0]; log(`handover ${id} "${name}" is live: ${h.url}`); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", (code) => {
      log(`handover ${id} "${name}" ended (${code})${h.url ? "" : `: ${h.output.trim().slice(-300)}`}`);
      h.release();
      handovers.delete(id);
    });
    // Wait for Remote Control to report its link.
    for (let i = 0; i < 40 && !h.url && handovers.has(id); i++) await new Promise((r) => setTimeout(r, 500));
    if (!handovers.has(id)) throw new Error(`The handover did not start: ${h.output.trim().slice(-300)}`);
    return { id, name, url: h.url };
  }

  function stop(id) {
    const h = handovers.get(id);
    if (!h) return false;
    h.proc.kill("SIGTERM");
    return true;
  }
  function stopAll() { for (const id of handovers.keys()) stop(id); }

  const activeSessions = () => new Set([...handovers.values()].map((h) => h.sid));

  return { status, startLogin, submitCode, logout, handover, stop, stopAll, activeSessions };
}
