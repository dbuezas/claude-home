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
chmod 700 /secure # HA config folder lives below; only the gateway (root) reads it
mkdir -p /data/config-backups && chmod 700 /data/config-backups # previous versions of edited config files

# Claude uses the one-time login from the Claude page in the sidebar (stored in $HOME).
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

# Claude reaches Home Assistant only through the add-on's gateway (proxy.mjs), which
# uses the Supervisor token. Older versions wrote a token file here; remove it.
rm -f /data/mcp.json

# Models, timeouts and extra instructions are read live from /data/options.json.
export WORK_DIR=/data/work PORT=8099 UI_PORT=8098 CLAUDE_HOME_DIR=/data/home
chmod 600 /data/api_token 2>/dev/null || true

# Claude's guide to this add-on (agent-guide.md in the repo). Claude Code loads CLAUDE.md
# from its work dir in every session, voice and app.
cp /opt/server/agent-guide.md /data/work/CLAUDE.md
chown claude:claude /data/work/CLAUDE.md

# --- sanity check: can the add-on reach HA's MCP server? ---
if ! curl -sf -o /dev/null -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
     "http://supervisor/core/api/mcp"; then
  bashio::log.warning "Home Assistant MCP server not reachable. Add the 'Model Context Protocol Server' integration in HA (Settings -> Devices & services)."
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
