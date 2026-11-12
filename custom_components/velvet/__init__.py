"""The Velvet integration: Velvet Rooms as media players."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import VelvetClient
from .const import CONF_INSTANCE_ID, CONF_TOKEN, DOMAIN
from .coordinator import VelvetCoordinator
from .library import VelvetLibrary

PLATFORMS: list[Platform] = [Platform.MEDIA_PLAYER]


@dataclass
class VelvetData:
    """Runtime data of one config entry."""

    client: VelvetClient
    coordinator: VelvetCoordinator
    library: VelvetLibrary


type VelvetConfigEntry = ConfigEntry[VelvetData]


async def async_setup_entry(hass: HomeAssistant, entry: VelvetConfigEntry) -> bool:
    """Set up Velvet from a config entry."""
    session = async_get_clientsession(hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True))
    client = VelvetClient(session, entry.data[CONF_URL], entry.data.get(CONF_TOKEN))
    coordinator = VelvetCoordinator(hass, entry, client, entry.data[CONF_INSTANCE_ID])
    await coordinator.async_config_entry_first_refresh()
    dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.data[CONF_INSTANCE_ID])},
        name=entry.title,
        manufacturer="Velvet",
        model="Velvet music server",
        configuration_url=client.base_url,
    )
    entry.runtime_data = VelvetData(client, coordinator, VelvetLibrary(client))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: VelvetConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
