# Claude Home

Claude Code, logged in with **your Claude subscription**, running as a Home Assistant add-on:

- **Assist conversation agent** – talk to it from the HA app, dashboards or voice satellites. Follow-ups like "and the bedroom too" keep context until the conversation has been idle for 15 min (configurable).
- **Fast** – about 2 s for a simple question: Claude stays running between messages, and every message carries a small snapshot of the main devices, so most questions need no tool call.
- **Reads everything, changes little by default** – Claude can read every entity and control the ones exposed to Assist. More needs an access level you unlock in the conversation (see below).
- **Continue in the Claude app** – hand a voice conversation over to the Claude app or claude.ai/code, with its full history.
- **Settings page** in the HA sidebar (Claude): Claude login, model, speed, access levels, protected devices.

```
Assist ─► claude_home integration ─HTTP+token─► add-on ─► claude (user "claude") ─► gateway ─► Home Assistant
                                                              └─► add-on tools (read, levels, protected, app handover)
```

Requires HA OS or Supervised (it's an add-on) and HA 2025.8+.

## Install

**0. Prerequisites in HA**
- Settings → Devices & services → Add integration → **Model Context Protocol Server**. Claude controls the house through it.
- Settings → Voice assistants → Expose: the entities Claude may control without unlocking a level.

**1. Add-on** – [![Add the add-on repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fdbuezas%2Fclaude-home)
(or Settings → Add-ons → Add-on Store → ⋮ → Repositories → add `https://github.com/dbuezas/claude-home`) → install **Claude Home** (builds locally, a few minutes) → Start.

**2. Log in** – open **Claude** in the sidebar → Settings → Claude account → **Log in to Claude**. Open the link, sign in with your Claude subscription, paste the code back. One login covers everything, including continuing in the Claude app.

**3. Integration** – [![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=dbuezas&repository=claude-home&category=integration)
(or HACS → ⋮ → Custom repositories → same URL, type *Integration*) → download → restart HA.
HA then shows **Claude Home discovered** under Settings → Devices & services → Configure. (Manual setup: host = *Hostname* on the add-on's Info page, port 8099, token from the add-on log.)

**4. Use it** – Settings → Voice assistants → your assistant → Conversation agent: **Claude Home**.
Enable *Prefer handling commands locally* so "turn off the kitchen light" stays instant and only real questions go to Claude.

## Settings page

Sidebar → **Claude**:
- **Status** – connection to Home Assistant, model, how many Claudes are running.
- **Settings** – Claude account login and running app sessions, model and effort, conversation memory, timeout, extra instructions, speed (fast or normal, how many Claudes to keep, when to close unused ones), the highest access level.
- **Protected** – which devices need level 1 before Claude may control them.
- **Conversations** – recent conversations; reopen any of them in the Claude app.

Changes apply to the next message; no restart needed.

## Access levels

| Level | Unlock phrase | Unlocks |
|---|---|---|
| 0 | – | Read every entity; control what is exposed to Assist |
| 1 | "unlock protected entities" | Control protected devices, rename things, areas, Claude's own instructions, the protected list |
| 2 | "unlock full access" | Commands, internet, all of Home Assistant core, continuing in the Claude app |
| 3 | "unlock supervisor" | Also add-ons, backups, updates, the host, and files in the HA config folder |

How unlocking works:
1. Claude asks for a level and says why.
2. Your **very next** message must contain that level's phrase. The add-on checks it in your own words, never in anything Claude writes.
3. The level stays unlocked for the rest of the conversation (until it is idle for the conversation-memory time).

The phrase said at any other time does nothing. The highest level Claude may ask for is a setting.

How it is enforced:
- Claude runs as an unprivileged user and never gets the Supervisor token. It reaches Home Assistant through a gateway on localhost that only allows what the conversation's level allows.
- Below level 2, Claude has no shell, no files and no internet: only Home Assistant's Assist tools and the add-on's own tools.
- Protected devices are hidden from Assist, so the Assist tools can't control them (not even with "turn off the living room"). Claude can still read them. Scripts, scenes or groups that include a protected device are side doors.

## Continue in the Claude app

At level 2 ("unlock full access"), say "continue this in the app". The add-on reopens the same Claude Code session, with its full history (messages and tool calls) and the same level, as an interactive Claude with Remote Control on. It shows up in the Claude app and on claude.ai/code under the title Claude gave it. Your next voice message starts a fresh conversation, so only one place owns the session.

App sessions keep running, also across days, until you stop them (Settings page, or ask Claude "stop my app sessions"). After an add-on restart or update they are reopened. The **Conversations** tab can also reopen an older conversation in the app, at a level you pick. In the app, the level can't be raised; unlock it by voice first.

This uses the login from install step 2.

## Speed

Measured on my HA box with Opus/medium:

| | Simple question ("is the lamp on?") | Multi-step question |
|---|---|---|
| Fast mode (default) | ~2 s | ~1 s less than normal mode |
| Normal mode | ~2–3 s | ~5–7 s |

- **Fast mode** keeps a Claude running per conversation, plus one spare for the next new conversation. It saves 0.7–0.9 s per message and costs ~190 MB of RAM for the first running Claude and ~120 MB for each more. A Claude that is closed loses nothing: the conversation is on disk and the next message resumes it.
- **Home snapshot**: the first message of a conversation carries the main devices exposed to Assist (lights, switches, climate, covers, locks, media players, scripts, room temperature/humidity, windows and doors) with their current state, ~10 KB for ~150 devices. Later messages only carry what changed. Home Assistant's own "whole house" tool returns ~50k tokens here, so Claude is told to use a targeted search instead.

## Options

All of these are also on the Settings page.

| Option | Default | |
|---|---|---|
| `main_model` | `opus` | `opus`, `sonnet`, `haiku` or a full model name |
| `effort` | `low` | Thinking effort; `default` uses the model's own |
| `session_idle_minutes` | 15 | Conversation memory |
| `request_timeout` | 120 | Seconds per message |
| `max_level` | 3 | Highest access level Claude may ask for |
| `fast_mode` | true | Keep Claude running between messages |
| `fast_keep` | 3 | Claudes kept running (the spare included) |
| `fast_idle_minutes` | 15 | Close an unused Claude after this long |
| `protected_entities` | – | Easier to manage on the Protected tab |
| `extra_instructions` | – | Appended to the system prompt (room nicknames, house quirks) |
| `anthropic_api_key` | – | Optional Anthropic API key. If set, voice and chat use it (billed per token) instead of the subscription login. Also settable on the Claude page. Remote Control (app handover) always needs the subscription login |
| `api_token` | auto | Token the integration uses (shown in the add-on log) |

## Notes

- No port is opened on your network. Only Home Assistant can reach the add-on.
- Conversation histories stay on the add-on's storage (they are never deleted because of age). The **Conversations** tab lists the recent ones and can reopen any of them in the Claude app.
- Claude's own guide to this add-on is [`claude_home/agent-guide.md`](claude_home/agent-guide.md); Claude reads it in every session and can read this repo's code at level 2+.
- Every message counts against your subscription's usage limits.
- Automated use of a consumer subscription: check Anthropic's current terms for your plan.
- If you want to use an API key: (Claude page → Settings → Claude account, or the `anthropic_api_key` option). Voice and chat then use the key and never the subscription. The key is visible to Claude at level 2+ (it can run commands), like the login is.

## Tests

```sh
pip install -r requirements_test.txt && pytest
```
