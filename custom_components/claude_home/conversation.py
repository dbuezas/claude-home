"""Conversation agent that forwards Assist to the Claude Home add-on."""

from __future__ import annotations

import asyncio
from typing import Literal

import aiohttp

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import CONF_TOKEN, DOMAIN, REQUEST_TIMEOUT


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the conversation entity."""
    async_add_entities([ClaudeHomeAgent(entry)])


class ClaudeHomeAgent(conversation.ConversationEntity):
    """Assist agent backed by Claude Code running in the add-on."""

    _attr_has_entity_name = True
    _attr_name = None
    # Claude controls devices itself via HA's MCP server, so HA may offer
    # "Prefer handling commands locally" for the fast path.
    _attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize."""
        self._entry = entry
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Claude Home",
            manufacturer="Anthropic",
            model="Claude Code",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Claude handles any language."""
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Send the utterance to the add-on and return its reply."""
        data = self._entry.data
        text = user_input.text
        if user_input.extra_system_prompt:
            text = f"[context: {user_input.extra_system_prompt}]\n{text}"
        try:
            async with async_get_clientsession(self.hass).post(
                f"http://{data[CONF_HOST]}:{data[CONF_PORT]}/conversation",
                json={"text": text, "conversation_id": chat_log.conversation_id},
                headers={"Authorization": f"Bearer {data[CONF_TOKEN]}"},
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                body = await resp.json(content_type=None)
                speech = body.get("speech") if resp.status == 200 else None
                if speech is None:
                    speech = f"Claude error: {body.get('error', resp.status)}"
        except asyncio.TimeoutError:
            speech = "Claude took too long to answer."
        except aiohttp.ClientError as err:
            speech = f"Can't reach the Claude Home add-on: {err}"

        chat_log.async_add_assistant_content_without_tools(
            conversation.AssistantContent(agent_id=self.entity_id, content=speech)
        )
        return conversation.async_get_result_from_chat_log(user_input, chat_log)
