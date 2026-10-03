# Claude Home

Claude Code, logged in with **your Claude subscription**, running as a Home Assistant add-on:

- **Assist conversation agent** – talk to it from the HA app, dashboards or voice satellites. Multi-turn: follow-ups like "and the bedroom too" keep context until the conversation has been idle for 15 min (configurable).
- **Fast by default** – Opus with low effort. In tests it was faster than Haiku on multi-step questions (Haiku makes more tool calls) and more accurate.
- **Locked down by default** – Claude can read every entity and control the ones exposed to Assist. Everything else needs an access level (see below).

```
Assist ──► custom_components/claude_home ──HTTP+token──► add-on ──► claude -p (opus, low effort) ──► HA MCP server
```

Requires HA OS or Supervised (it's an add-on) and HA 2025.8+.

## Install

**0. Prerequisites in HA**
- Settings → Devices & services → Add integration → **Model Context Protocol Server**. Claude controls the house through it.
- Settings → Voice assistants → Expose: the entities Claude may control without unlocking a level.

**1. Subscription token** – on any computer with Claude Code: `claude setup-token`, copy the `sk-ant-oat…` token.

**2. Add-on** – Settings → Add-ons → Add-on Store → ⋮ → Repositories → add
`https://github.com/dbuezas/claude-home` → install **Claude Home** (builds locally, a few minutes) → Configuration: paste the token → Start. Check the log.

**3. Integration** – HACS → ⋮ → Custom repositories → same URL, type *Integration* → download → restart HA.
HA then shows **Claude Home discovered** under Settings → Devices & services → Configure. (Manual setup: host = *Hostname* on the add-on's Info page, port 8099, token from the add-on log.)

**4. Use it** – Settings → Voice assistants → your assistant → Conversation agent: **Claude Home**.
Enable *Prefer handling commands locally* so "turn off the kitchen light" stays instant and only real questions go to Claude.

## Access levels

| Level | Unlock phrase | Unlocks |
|---|---|---|
| 0 | – | Read every entity; control what is exposed to Assist |
| 1 | "unlock protected entities" | Control protected devices, rename things, areas, Claude's own instructions, the protected list |
| 2 | "unlock full access" | Commands, internet, all of Home Assistant core, Remote Control |
| 3 | "unlock supervisor" | Also add-ons, backups, updates, the host |

How unlocking works:
1. Claude asks for a level and says why.
2. Your **very next** message must contain that level's phrase. The add-on checks it in your own words, never in anything Claude writes.
3. The level stays unlocked for the rest of the conversation (until it is idle for the conversation-memory time).

The phrase said at any other time does nothing. The highest level Claude may ask for is a setting (sidebar → Claude → Settings, or `max_level`).

How it is enforced:
- Claude runs as an unprivileged user and never gets the Supervisor token. It reaches Home Assistant through a gateway on localhost that only allows what the conversation's level allows.
- Below level 2, Claude has no shell, no files and no internet: only Home Assistant's Assist tools and the add-on's own tools.
- Protected devices are hidden from Assist, so the Assist tools can't control them (not even with "turn off the living room"). Scripts, scenes or groups that include a protected device are side doors.

## Remote Control

At level 2 ("unlock full access"), Claude can start Remote Control. A machine called "Home Assistant" then shows up in the Claude app and on claude.ai/code; a session you start there runs inside the add-on with the same level. Remote Control needs a one-time login (Settings → Remote Control); the token from the Configuration tab can't do it. It runs until you stop it (Settings) or restart the add-on.

## Options

| Option | Default | |
|---|---|---|
| `main_model` | `opus` | Handles every request |
| `effort` | `low` | Thinking effort; lower is faster |
| `session_idle_minutes` | 15 | Conversation context lifetime |
| `request_timeout` | 120 | Seconds per request |
| `api_token` | auto | Token for the integration |
| `ha_token` | – | Long-lived HA token, only if the Supervisor token can't reach `/api/mcp` (the log warns you) |
| `extra_instructions` | – | Appended to the system prompt (room nicknames, house quirks) |

## Notes

- No port is opened on your network. Only Home Assistant can reach the add-on.
- Each request spawns `claude -p`; expect about 5–8 seconds. Fine for chat, noticeable for voice.
- Every request counts against your subscription's usage limits.
- Automated use of a consumer subscription: check Anthropic's current terms for your plan.

## Tests

```sh
pip install -r requirements_test.txt && pytest
```
