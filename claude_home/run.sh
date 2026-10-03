#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e

export HOME=/data/home
mkdir -p "$HOME" /data/work

# Claude runs as the unprivileged "claude" user: it owns its home and work dir,
# and can't read the Supervisor token or the add-on's own files.
# Trust the work dir up front: Remote Control refuses an untrusted workspace and
# there is no terminal here to accept the trust dialog.
CJ="$HOME/.claude.json"
[ -s "$CJ" ] || echo '{}' > "$CJ"
jq '.projects["/data/work"].hasTrustDialogAccepted = true | .hasCompletedOnboarding = true' "$CJ" > "$CJ.tmp" && mv "$CJ.tmp" "$CJ"
chown -R claude:claude "$HOME" /data/work
chmod 700 /run/s6/container_environment 2>/dev/null || true
chmod 711 /data   # claude can reach its own dirs, but not list or read the rest

# --- Claude subscription token (from `claude setup-token`) ---
if ! bashio::config.has_value 'claude_oauth_token'; then
  bashio::exit.nok "Set 'claude_oauth_token' (run 'claude setup-token' on any computer and paste the result)."
fi
export CLAUDE_CODE_OAUTH_TOKEN="$(bashio::config 'claude_oauth_token')"
export DISABLE_AUTOUPDATER=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# --- token the HA integration uses to call this add-on ---
if bashio::config.has_value 'api_token'; then
  API_TOKEN="$(bashio::config 'api_token')"
else
  [ -s /data/api_token ] || head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > /data/api_token
  API_TOKEN="$(cat /data/api_token)"
fi
export API_TOKEN

# --- how Claude reaches Home Assistant's MCP server ---
if bashio::config.has_value 'ha_token'; then
  HA_MCP_URL="http://homeassistant:8123/api/mcp"
  HA_AUTH="$(bashio::config 'ha_token')"
else
  HA_MCP_URL="http://supervisor/core/api/mcp"
  HA_AUTH="${SUPERVISOR_TOKEN}"
fi
jq -n --arg url "$HA_MCP_URL" --arg auth "Bearer $HA_AUTH" \
  '{mcpServers: {ha: {type: "http", url: $url, headers: {Authorization: $auth}}}}' > /data/mcp.json
chmod 600 /data/mcp.json

# Models, timeouts and extra instructions are read live from /data/options.json.
export MCP_CONFIG=/data/mcp.json WORK_DIR=/data/work PORT=8099 UI_PORT=8098 CLAUDE_HOME_DIR=/data/home
chmod 600 /data/api_token 2>/dev/null || true

# Notes for Claude when it works here at level 2+ (also for Remote Control sessions).
cat > /data/work/CLAUDE.md <<'NOTES'
# Claude Home: how you are set up

You are Claude Code running inside **Claude Home**, a Home Assistant add-on. Source (public):
https://github.com/dbuezas/claude-home. The add-on's server code is also on disk at /opt/server
(index.mjs, admin.mjs, proxy.mjs, rc.mjs, ui.mjs, ptyrun.py) and readable at level 2+.
When asked how Claude Home works, answer from this file; at level 2+ read the code for details.

## How a request reaches you
- The user talks to Assist (HA app, dashboards, voice satellites). The `claude_home` custom
  integration forwards each message to the add-on, which runs `claude -p` as the unprivileged
  user "claude" in /data/work, resuming the same session for follow-ups (until idle for the
  "conversation memory" setting, 15 min by default).
- Model, effort, timeouts and extra instructions are settings on the add-on page (sidebar →
  Claude → Settings); they apply live.

## Tools
- mcp__ha__*: Home Assistant's own Assist MCP server. Controls only entities exposed to Assist.
- mcp__admin__*: the add-on's tools: find_entities (read any entity, always allowed),
  get_instructions, request_unlock, and the level-gated ones below.

## Access levels (per conversation)
- 0: read everything, control what's exposed to Assist.
- 1 "unlock protected entities": control protected entities (use_protected), renames/areas and
  the protected list (make_changes), own extra instructions (set_instructions).
- 2 "unlock full access": Bash, files, internet, all of HA core via a gateway, continue_in_app.
- 3 "unlock supervisor": also the Supervisor API (add-ons, backups, updates, host).
Handshake: you call request_unlock(level, reason); the server replaces your reply with the
request; the user's very next message must contain the phrase; then the level stays for the
rest of the conversation. The server checks only the user's words. The highest allowed level
is a setting (max_level).

## Protected entities
Kept un-exposed from Assist (re-checked every 30 s), so mcp__ha__* can't control them. You can
still read them. Scripts/scenes/groups that include them are known side doors.

## Gateway (level 2+)
You never get the Supervisor token. $HA_URL / $HA_TOKEN point to a localhost gateway that
allows /core/api/mcp at any level, /core/api/* and /core/websocket at level 2, and every other
Supervisor path at level 3 (HTTP 403 otherwise).
- REST: `curl -s -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/core/api/states"`
- Websocket: `$HA_URL/core/websocket` (ws://), first message `{"type":"auth","access_token":"<HA_TOKEN>"}`;
  use it for registries, automations, scripts, dashboards.
- Supervisor (level 3): `$HA_URL/addons`, `/backups`, `/supervisor/info`, `/host/info`, ...

## Continue in the app (level 2)
continue_in_app reopens this exact session as interactive Claude with Remote Control (in a
pseudo-terminal), so it shows up in the Claude app / claude.ai/code with full history and the
same level. Voice starts fresh afterwards. App sessions run until stopped (app_sessions tool,
the add-on page, or an add-on restart). In the app, levels can't be raised.

Make small, careful changes and say what you changed.
NOTES
chown claude:claude /data/work/CLAUDE.md

# --- sanity check: can Claude see HA's MCP server? ---
if ! curl -sf -o /dev/null -X POST -H "Authorization: Bearer $HA_AUTH" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
     "$HA_MCP_URL"; then
  bashio::log.warning "Home Assistant MCP server not reachable at ${HA_MCP_URL}."
  bashio::log.warning "Add the 'Model Context Protocol Server' integration in HA. If it is installed and this still fails, create a long-lived token (your profile -> Security) and set it as 'ha_token'."
fi

# --- tell the integration where we are (Supervisor discovery) ---
HOSTNAME_SELF="$(bashio::addon.hostname)"
if bashio::discovery "claude_home" "$(jq -n --arg h "$HOSTNAME_SELF" --arg t "$API_TOKEN" '{host: $h, port: 8099, token: $t}')" >/dev/null; then
  bashio::log.info "Discovery sent: Home Assistant should now offer to set up 'Claude Home'."
else
  bashio::log.warning "Discovery failed; add the integration manually (host ${HOSTNAME_SELF}, port 8099, token below)."
fi
bashio::log.info "API token (for the integration): ${API_TOKEN}"

cd /opt/server
exec node index.mjs
