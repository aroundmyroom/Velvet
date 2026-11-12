"""Fixtures: a fake Velvet server on 127.0.0.1 and a configured entry."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from unittest.mock import patch

from aiohttp.test_utils import TestServer
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.velvet.const import CONF_INSTANCE_ID, CONF_TOKEN, DOMAIN
from homeassistant.const import CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant

from .fake_velvet import INSTANCE, TOKEN, FakeVelvet


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Load custom_components/ in every test."""


@pytest.fixture(autouse=True)
def fast_pairing() -> None:
    with patch("custom_components.velvet.config_flow.PAIR_POLL_INTERVAL", 0.01):
        yield


@pytest.fixture
async def velvet(socket_enabled: None) -> AsyncGenerator[FakeVelvet]:
    fake = FakeVelvet()
    server = TestServer(fake.app(), host="127.0.0.1")
    await server.start_server()
    fake.url = str(server.make_url("")).rstrip("/")
    fake.server = server
    yield fake
    await server.close()


@pytest.fixture
def entry(velvet: FakeVelvet) -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        title="Velvet (ha@127.0.0.1)",
        unique_id=INSTANCE,
        data={
            CONF_URL: velvet.url,
            CONF_VERIFY_SSL: True,
            CONF_TOKEN: TOKEN,
            CONF_USERNAME: "ha",
            CONF_INSTANCE_ID: INSTANCE,
        },
    )


@pytest.fixture
async def setup_entry(hass: HomeAssistant, entry: MockConfigEntry) -> MockConfigEntry:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
