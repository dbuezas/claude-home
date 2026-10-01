"""Config flow for Claude Home."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .const import CONF_TOKEN, DEFAULT_PORT, DOMAIN


async def _validate(hass, host: str, port: int, token: str) -> str | None:
    """Return an error key, or None if the add-on accepts the token."""
    # An empty body is rejected with 400 when authorized and 401 when not,
    # so this checks reachability and the token without running Claude.
    try:
        async with async_get_clientsession(hass).post(
            f"http://{host}:{port}/conversation",
            json={},
            headers={"Authorization": f"Bearer {token}"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status == 401:
                return "invalid_auth"
            if resp.status != 400:
                return "cannot_connect"
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return "cannot_connect"
    return None


class ClaudeHomeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Claude Home."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize."""
        self._discovered: dict[str, Any] = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manual setup."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        errors: dict[str, str] = {}
        if user_input is not None:
            err = await _validate(
                self.hass, user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_TOKEN]
            )
            if err is None:
                return self.async_create_entry(title="Claude Home", data=user_input)
            errors["base"] = err
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default="local-claude-home"): str,
                    vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                    vol.Required(CONF_TOKEN): str,
                }
            ),
            errors=errors,
        )

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Set up from Supervisor discovery (sent by the add-on)."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(
            updates={
                CONF_HOST: discovery_info.config["host"],
                CONF_PORT: discovery_info.config["port"],
                CONF_TOKEN: discovery_info.config["token"],
            }
        )
        self._discovered = dict(discovery_info.config)
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm discovery."""
        if user_input is not None:
            data = {
                CONF_HOST: self._discovered["host"],
                CONF_PORT: self._discovered["port"],
                CONF_TOKEN: self._discovered["token"],
            }
            err = await _validate(self.hass, **data)
            if err:
                return self.async_abort(reason=err)
            return self.async_create_entry(title="Claude Home", data=data)
        return self.async_show_form(step_id="hassio_confirm")
