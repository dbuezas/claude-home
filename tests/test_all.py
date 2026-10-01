from homeassistant import config_entries
from homeassistant.components import conversation
from homeassistant.core import Context
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

DOMAIN = "claude_home"
URL = "http://local-claude-home:8099/conversation"
DATA = {"host": "local-claude-home", "port": 8099, "token": "t0k"}


async def test_user_flow(hass, aioclient_mock):
    assert await async_setup_component(hass, "homeassistant", {})
    aioclient_mock.post(URL, status=401, json={"error": "unauthorized"})
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {**DATA, "token": "bad"})
    assert r["errors"] == {"base": "invalid_auth"}
    aioclient_mock.clear_requests(); aioclient_mock._mocks.clear()
    aioclient_mock.post(URL, status=400, json={"error": "text required"})
    r = await hass.config_entries.flow.async_configure(r["flow_id"], DATA)
    assert r["type"] is FlowResultType.CREATE_ENTRY and r["data"] == DATA


async def test_hassio_discovery(hass, aioclient_mock):
    assert await async_setup_component(hass, "homeassistant", {})
    aioclient_mock.post(URL, status=400, json={})
    r = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO},
        data=HassioServiceInfo(config=DATA, name="Claude Home", slug="local_claude_home", uuid="x"))
    assert r["step_id"] == "hassio_confirm"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["type"] is FlowResultType.CREATE_ENTRY and r["data"] == DATA


async def test_conversation(hass, aioclient_mock):
    assert await async_setup_component(hass, "homeassistant", {})
    assert await async_setup_component(hass, "conversation", {})
    entry = MockConfigEntry(domain=DOMAIN, data=DATA)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    agent = hass.states.async_entity_ids("conversation")
    agent_id = [a for a in agent if "claude" in a][0]

    aioclient_mock.post(URL, json={"speech": "Kitchen light is on. Anything else?"})
    r = await conversation.async_converse(hass, "turn on the kitchen", None, Context(), agent_id=agent_id)
    assert r.response.speech["plain"]["speech"] == "Kitchen light is on. Anything else?"
    assert r.continue_conversation is True
    cid = r.conversation_id
    sent = aioclient_mock.mock_calls[-1]
    assert sent[2] == {"text": "turn on the kitchen", "conversation_id": cid}
    assert sent[3]["Authorization"] == "Bearer t0k"

    r2 = await conversation.async_converse(hass, "and the bedroom", cid, Context(), agent_id=agent_id)
    assert aioclient_mock.mock_calls[-1][2]["conversation_id"] == cid
    assert r2.conversation_id == cid


async def test_conversation_addon_down(hass, aioclient_mock):
    import aiohttp
    assert await async_setup_component(hass, "homeassistant", {})
    entry = MockConfigEntry(domain=DOMAIN, data=DATA); entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id); await hass.async_block_till_done()
    agent_id = [a for a in hass.states.async_entity_ids("conversation") if "claude" in a][0]
    aioclient_mock.post(URL, exc=aiohttp.ClientError("boom"))
    r = await conversation.async_converse(hass, "hi", None, Context(), agent_id=agent_id)
    assert "Can't reach" in r.response.speech["plain"]["speech"]
