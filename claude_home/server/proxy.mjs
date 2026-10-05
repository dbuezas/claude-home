// Gateway between Claude and Home Assistant, on 127.0.0.1 only.
//
// Claude never gets the Supervisor token. It gets a grant token instead, and this
// proxy swaps it for the real token, but only for the paths its level allows:
//   any level  : /core/api/mcp        (Home Assistant's Assist MCP server)
//   level >= 2 : /core/api/*, /core/websocket   (everything in Home Assistant core)
//   level >= 3 : every other Supervisor path    (add-ons, backups, updates, host)
//                and /files/<path>              (the HA config folder, served here)
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

const SUPERVISOR = "supervisor";
const CONFIG_DIR = "/secure/config"; // mapped homeassistant_config, root-only (see run.sh)

// /files/<path> on the HA config folder. GET reads a file or lists a folder,
// PUT writes a file (the previous version is kept as <file>.bak), DELETE removes one.
async function files(req, res, rel) {
  let root;
  try { root = await fs.realpath(CONFIG_DIR); } catch { return res.writeHead(503).end("HA config folder is not mapped"); }
  const target = path.resolve(root, "." + decodeURIComponent(rel));
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  // Follow symlinks for anything that exists (or its parent, for new files) and stay inside the folder.
  const real = await fs.realpath(target).catch(() => fs.realpath(path.dirname(target)).then((d) => path.join(d, path.basename(target))).catch(() => null));
  if (!real) return res.writeHead(404).end("no such folder");
  if (!inside(real)) return res.writeHead(403).end("outside the HA config folder");
  try {
    if (req.method === "GET") {
      const st = await fs.stat(real);
      if (st.isDirectory()) {
        const list = await fs.readdir(real, { withFileTypes: true });
        return res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(list.map((d) => d.name + (d.isDirectory() ? "/" : "")).sort()));
      }
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(await fs.readFile(real));
    }
    if (req.method === "PUT") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await fs.copyFile(real, real + ".bak").catch(() => {});
      const tmp = real + ".tmp-" + randomBytes(4).toString("hex");
      await fs.writeFile(tmp, Buffer.concat(chunks));
      await fs.rename(tmp, real);
      return res.writeHead(200).end("ok");
    }
    if (req.method === "DELETE") {
      await fs.unlink(real);
      return res.writeHead(200).end("ok");
    }
    return res.writeHead(405).end("GET, PUT or DELETE");
  } catch (e) {
    return res.writeHead(e.code === "ENOENT" ? 404 : 500).end(e.message);
  }
}

export function createProxy({ port, log }) {
  const token = process.env.SUPERVISOR_TOKEN || "";
  const grants = new Map(); // grant -> level

  function grant(level) {
    const g = randomBytes(24).toString("hex");
    grants.set(g, level);
    return { token: g, release: () => grants.delete(g) };
  }

  const needed = (path) =>
    path === "/core/api/mcp" || path.startsWith("/core/api/mcp?") ? 0
      : path.startsWith("/core/api/") || path === "/core/api" || path.startsWith("/core/websocket") ? 2
        : 3;

  const levelOf = (header) => grants.get(String(header || "").replace(/^Bearer\s+/i, ""));

  const server = http.createServer((req, res) => {
    // Resolve "..", "%2e%2e" and the like before checking the path.
    const u = new URL(req.url, "http://x");
    req.url = u.pathname + u.search;
    const level = levelOf(req.headers.authorization);
    if (level === undefined) return res.writeHead(401).end("unknown or expired token");
    if (level < needed(req.url)) return res.writeHead(403).end(`this needs access level ${needed(req.url)}; the conversation is at level ${level}`);
    if (u.pathname === "/files" || u.pathname.startsWith("/files/")) return files(req, res, u.pathname.slice("/files".length) || "/");
    const headers = { ...req.headers, host: SUPERVISOR, authorization: `Bearer ${token}` };
    const up = http.request({ host: SUPERVISOR, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502).end(e.message); });
    req.pipe(up);
  });

  // Websocket: the client authenticates with its grant; we authenticate upstream.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname !== "/core/websocket") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${SUPERVISOR}/core/websocket`);
      let authed = false;
      const queue = [];
      upstream.on("open", () => queue.splice(0).forEach((m) => upstream.send(m)));
      upstream.on("message", (m) => client.readyState === 1 && client.send(m.toString()));
      upstream.on("close", () => client.close());
      upstream.on("error", () => client.close());
      client.on("close", () => upstream.close());
      client.on("message", (raw) => {
        let msg = raw.toString();
        if (!authed) {
          let m; try { m = JSON.parse(msg); } catch { return client.close(); }
          if (m.type !== "auth" || (levelOf(m.access_token) ?? -1) < 2) {
            client.send(JSON.stringify({ type: "auth_invalid", message: "needs access level 2" }));
            return client.close();
          }
          authed = true;
          msg = JSON.stringify({ type: "auth", access_token: token });
        }
        upstream.readyState === 1 ? upstream.send(msg) : queue.push(msg);
      });
    });
  });

  server.listen(port, "127.0.0.1", () => log(`claude-home gateway on 127.0.0.1:${port}`));
  return { grant, url: `http://127.0.0.1:${port}` };
}
