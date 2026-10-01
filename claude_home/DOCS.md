# Claude Home

Claude Code, logged in with **your Claude subscription**, running as a Home Assistant add-on:

- **Assist conversation agent** – talk to it from the HA app, dashboards or voice satellites. Multi-turn: follow-ups like "and the bedroom too" keep context until the conversation has been idle for 15 min (configurable).
- **Haiku → Opus routing** – Haiku answers everything by default and delegates multi-step / ambiguous requests to an Opus `home-planner` subagent.
- **MCP server for remote Claude Code** – other machines get an `ask_home` tool.
- **Locked down** – Claude only gets HA's MCP tools (entities exposed to Assist) plus the planner subagent. No shell, no file access, no web.

```
Assist ──► custom_components/claude_home ──HTTP+token──► add-on ──► claude -p (haiku) ──► HA MCP server
                                                            ▲            └─► home-planner (opus)
remote Claude Code ──MCP (ask_home)─────────────────────────┘
```

Requires HA OS or Supervised (it's an add-on) and HA 2025.8+.

## Install

**0. Prerequisites in HA**
- Settings → Devices & services → Add integration → **Model Context Protocol Server**. Claude controls the house through it.
- Settings → Voice assistants → Expose: the entities Claude may see and control.

**1. Subscription token** – on any computer with Claude Code: `claude setup-token`, copy the `sk-ant-oat…` token.

**2. Add-on** – Settings → Add-ons → Add-on Store → ⋮ → Repositories → add
`https://github.com/dbuezas/claude-home` → install **Claude Home** (builds locally, a few minutes) → Configuration: paste the token → Start. Check the log.

**3. Integration** – HACS → ⋮ → Custom repositories → same URL, type *Integration* → download → restart HA.
HA then shows **Claude Home discovered** under Settings → Devices & services → Configure. (Manual setup: host = *Hostname* on the add-on's Info page, port 8099, token from the add-on log.)

**4. Use it** – Settings → Voice assistants → your assistant → Conversation agent: **Claude Home**.
Enable *Prefer handling commands locally* so "turn off the kitchen light" stays instant and only real questions go to Claude.

## Remote Claude Code

Add-on → Configuration → Network: map `8099`. Then on the other computer:

```sh
claude mcp add --transport http home http://homeassistant.local:8099/mcp \
  --header "Authorization: Bearer <API token from the add-on log>"
```

`ask_home` returns a `conversation_id`; pass it back to continue the same conversation.
Away from home, use the Tailscale add-on. **Never port-forward this to the internet.**

## Options

| Option | Default | |
|---|---|---|
| `main_model` | `haiku` | Handles every request |
| `planner_model` | `opus` | Subagent for complex requests |
| `session_idle_minutes` | 15 | Conversation context lifetime |
| `request_timeout` | 120 | Seconds per request |
| `api_token` | auto | Token for the integration / remote clients |
| `ha_token` | – | Long-lived HA token, only if the Supervisor token can't reach `/api/mcp` (the log warns you) |
| `extra_instructions` | – | Appended to the system prompt (room nicknames, house quirks) |

## Notes

- Each request spawns `claude -p`; expect a few seconds with Haiku, more when Opus plans. Fine for chat, noticeable for voice.
- Every request counts against your subscription's usage limits.
- Automated use of a consumer subscription: check Anthropic's current terms for your plan.

## Tests

```sh
pip install -r requirements_test.txt && pytest
```
