// Remote Control: a one-time full Claude login, and the `claude remote-control`
// process that makes this add-on show up in claude.ai/code and the Claude app.
// Both run as the unprivileged "claude" user. The long-lived token from
// `claude setup-token` can't do Remote Control; it needs a full login.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export function createRemoteControl({ cfg, user, baseEnv, log }) {
  let login = null; // { proc, url, output }
  let rc = null; // { proc, level, output, release }

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
      email = s.email || s.account?.email || null;
    } catch {}
    return {
      loggedIn, email,
      login: login ? { url: login.url, waiting: true } : null,
      running: !!rc,
      level: rc?.level ?? null,
      output: rc ? rc.output.slice(-1500) : "",
    };
  }

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
    await promisify(execFile)(cfg.claudeBin, ["auth", "logout"], opts()).catch(() => {});
  }

  // level: the access level the remote sessions get (2 or 3); grant: a gateway grant for it.
  async function start(level, grant) {
    if (rc) { grant.release(); return status(); }
    if (!(await status()).loggedIn) { grant.release(); throw new Error("Remote Control needs a one-time Claude login on the Claude Home page (Settings → Remote Control)."); }
    const proc = spawn(cfg.claudeBin, [
      "remote-control", "--name", "Home Assistant", "--permission-mode", "bypassPermissions",
    ], opts({ HA_URL: grant.url, HA_TOKEN: grant.token, CLAUDE_HOME_LEVEL: String(level) }));
    rc = { proc, level, output: "", release: grant.release };
    const onData = (d) => { if (rc?.proc === proc) rc.output = (rc.output + d).slice(-20_000); };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("close", (code) => {
      log(`remote-control exited ${code}`);
      if (rc?.proc === proc) { rc.release(); rc = null; }
    });
    await new Promise((r) => setTimeout(r, 4000)); // let it register and print its link
    log(`remote-control started at level ${level}`);
    return status();
  }

  function stop() {
    if (!rc) return false;
    rc.proc.kill("SIGTERM");
    return true;
  }

  return { status, startLogin, submitCode, logout, start, stop };
}
