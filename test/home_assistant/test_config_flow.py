"""Config flow: pairing, password, public mode, errors, reauth."""

from __future__ import annotations

from unittest.mock import patch

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.velvet.api import VelvetSslError
from custom_components.velvet.const import CONF_INSTANCE_ID, CONF_TOKEN, DOMAIN
from homeassistant import config_entries
from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from .fake_velvet import INSTANCE, TOKEN, FakeVelvet


async def _start(hass: HomeAssistant, url: str, verify: bool = True):
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    return await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: url + "/", CONF_VERIFY_SSL: verify}
    )


async def _pair(hass: HomeAssistant, flow_id: str):
    result = await hass.config_entries.flow.async_configure(flow_id, {"next_step_id": "pair"})
    assert result["type"] is FlowResultType.SHOW_PROGRESS
    assert result["description_placeholders"]["code"] == "ABC234"
    await hass.async_block_till_done()
    return await hass.config_entries.flow.async_configure(flow_id)


async def test_pairing_creates_entry(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    result = await _start(hass, velvet.url, verify=False)
    assert result["type"] is FlowResultType.MENU
    assert result["menu_options"] == ["pair", "password"]

    result = await _pair(hass, result["flow_id"])
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Velvet (ha@127.0.0.1)"
    assert result["result"].unique_id == INSTANCE
    assert result["data"] == {
        CONF_URL: velvet.url,
        CONF_VERIFY_SSL: False,
        CONF_TOKEN: TOKEN,
        CONF_USERNAME: "ha",
        CONF_INSTANCE_ID: INSTANCE,
    }
    assert len(velvet.calls("/api/v1/auth/pair/status")) == 2
    assert velvet.calls("/api/v1/auth/login") == []


async def test_pairing_expired_offers_new_code(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    velvet.pair_expire = True
    result = await _start(hass, velvet.url)
    result = await _pair(hass, result["flow_id"])
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "pair_expired"

    velvet.pair_expire = False
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.SHOW_PROGRESS
    await hass.async_block_till_done()
    result = await hass.config_entries.flow.async_configure(result["flow_id"])
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert len(velvet.calls("/api/v1/auth/pair/start")) == 2


async def test_pairing_user_without_rooms_permission(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    velvet.rooms_status = 403
    velvet.rooms_code = "forbidden"
    result = await _start(hass, velvet.url)
    result = await _pair(hass, result["flow_id"])
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_rooms_permission"


async def test_password_login(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    result = await _start(hass, velvet.url)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "password"})
    assert result["step_id"] == "password"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "ha", CONF_PASSWORD: "wrong"}
    )
    assert result["errors"] == {"base": "invalid_auth"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "ha", CONF_PASSWORD: "secret"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_TOKEN] == TOKEN
    assert CONF_PASSWORD not in result["data"]


async def test_password_rooms_disabled(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    velvet.rooms_status = 404
    velvet.rooms_code = "rooms_disabled"
    result = await _start(hass, velvet.url)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "password"})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "ha", CONF_PASSWORD: "secret"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "rooms_disabled"}


async def test_public_server_needs_no_sign_in(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    velvet.has_users = False
    result = await _start(hass, velvet.url)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_TOKEN] is None
    assert result["title"] == "Velvet (127.0.0.1)"


async def test_bad_url_and_unreachable(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    result = await _start(hass, "music.local")
    assert result["errors"] == {CONF_URL: "invalid_url"}
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: "http://127.0.0.1:1", CONF_VERIFY_SSL: True}
    )
    assert result["errors"] == {"base": "cannot_connect"}


async def test_already_configured_updates_url(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    old = MockConfigEntry(domain=DOMAIN, unique_id=INSTANCE, data={CONF_URL: "https://old", CONF_INSTANCE_ID: INSTANCE})
    old.add_to_hass(hass)
    result = await _start(hass, velvet.url)
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert old.data[CONF_URL] == velvet.url


async def test_reauth_by_pairing(hass: HomeAssistant, velvet: FakeVelvet, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_TOKEN: "stale"})
    result = await entry.start_reauth_flow(hass)
    assert result["step_id"] == "reauth_confirm"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.MENU
    result = await _pair(hass, result["flow_id"])
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data[CONF_TOKEN] == TOKEN


async def test_reauth_wrong_server(hass: HomeAssistant, velvet: FakeVelvet) -> None:
    other = MockConfigEntry(
        domain=DOMAIN,
        unique_id="someone-else",
        data={CONF_URL: velvet.url, CONF_VERIFY_SSL: True, CONF_TOKEN: "x", CONF_INSTANCE_ID: "someone-else"},
    )
    other.add_to_hass(hass)
    result = await other.start_reauth_flow(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "wrong_server"


async def test_self_signed_certificate_hint(hass: HomeAssistant) -> None:
    with patch(
        "custom_components.velvet.config_flow.VelvetClient.ping_public",
        side_effect=VelvetSslError("certificate verify failed"),
    ):
        result = await _start(hass, "https://music.local:3000")
    assert result["errors"] == {"base": "ssl_error"}
