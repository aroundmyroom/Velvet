"""Config flow: add a Velvet server by approving a pairing code (or a password)."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
import logging
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol

from homeassistant.config_entries import SOURCE_REAUTH, ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    VelvetApiError,
    VelvetAuthError,
    VelvetClient,
    VelvetConnectionError,
    VelvetError,
    VelvetSslError,
    normalize_url,
)
from .const import CONF_INSTANCE_ID, CONF_TOKEN, DOMAIN, PAIR_POLL_INTERVAL

_LOGGER = logging.getLogger(__name__)

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): str,
        vol.Optional(CONF_VERIFY_SSL, default=True): bool,
    }
)
PASSWORD_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_USERNAME): str,
        vol.Required(CONF_PASSWORD): str,
    }
)


class RoomsUnavailable(Exception):
    """The account cannot use Velvet Rooms; the value is the abort/error key."""


class VelvetConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Velvet."""

    VERSION = 1

    def __init__(self) -> None:
        self._url = ""
        self._verify_ssl = True
        self._instance_id = ""
        self._pair: dict[str, Any] | None = None
        self._pair_task: asyncio.Task[dict[str, Any] | None] | None = None
        self._approved: dict[str, Any] | None = None

    def _client(self, token: str | None = None) -> VelvetClient:
        session = async_get_clientsession(self.hass, verify_ssl=self._verify_ssl)
        return VelvetClient(session, self._url, token)

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Ask for the server address."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url = normalize_url(user_input[CONF_URL])
            if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).hostname:
                errors[CONF_URL] = "invalid_url"
            else:
                self._url = url
                self._verify_ssl = user_input[CONF_VERIFY_SSL]
                try:
                    info = await self._client().ping_public()
                except VelvetSslError:
                    errors["base"] = "ssl_error"
                except VelvetError:
                    errors["base"] = "cannot_connect"
                else:
                    self._instance_id = info["instanceId"]
                    await self.async_set_unique_id(self._instance_id)
                    self._abort_if_unique_id_configured(
                        updates={CONF_URL: self._url, CONF_VERIFY_SSL: self._verify_ssl}
                    )
                    if info.get("hasUsers", True):
                        return await self.async_step_auth()
                    try:
                        return await self._async_finish(None, None)
                    except RoomsUnavailable as err:
                        errors["base"] = str(err)
                    except VelvetError:
                        errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(USER_SCHEMA, user_input),
            errors=errors,
            description_placeholders={"example": "https://music.example.net:3000"},
        )

    async def async_step_auth(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Choose: approve a code in Velvet, or type a password."""
        return self.async_show_menu(step_id="auth", menu_options=["pair", "password"])

    async def async_step_pair(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show a code; wait until it is approved in Velvet."""
        if self._pair_task is None:
            try:
                self._pair = await self._client().pair_start()
            except VelvetError:
                return self.async_abort(reason="cannot_connect")
            self._pair_task = self.hass.async_create_task(self._async_wait_for_approval())

        if not self._pair_task.done():
            return self.async_show_progress(
                step_id="pair",
                progress_action="wait_for_approval",
                description_placeholders={"code": self._pair["code"], "url": self._url},
                progress_task=self._pair_task,
            )

        self._approved = self._pair_task.result()
        self._pair_task = None
        if self._approved is None:
            return self.async_show_progress_done(next_step_id="pair_expired")
        return self.async_show_progress_done(next_step_id="pair_done")

    async def _async_wait_for_approval(self) -> dict[str, Any] | None:
        assert self._pair is not None
        client = self._client()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + float(self._pair.get("expiresInSec", 300)) + 5
        while loop.time() < deadline:
            try:
                status = await client.pair_status(self._pair["pairId"])
            except VelvetError as err:
                _LOGGER.debug("Pairing poll failed: %s", err)
            else:
                if status.get("status") == "approved" and status.get("token"):
                    return status
                if status.get("status") == "expired":
                    return None
            await asyncio.sleep(PAIR_POLL_INTERVAL)
        return None

    async def async_step_pair_done(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The code was approved."""
        assert self._approved is not None
        try:
            return await self._async_finish(self._approved["token"], self._approved.get("username"))
        except RoomsUnavailable as err:
            return self.async_abort(reason=str(err))
        except VelvetError:
            return self.async_abort(reason="cannot_connect")

    async def async_step_pair_expired(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The code expired before anyone approved it; offer a new one."""
        if user_input is not None:
            return await self.async_step_pair()
        return self.async_show_form(step_id="pair_expired")

    async def async_step_password(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Log in with a username and password (the password is not stored)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                token = await self._client().login(user_input[CONF_USERNAME], user_input[CONF_PASSWORD])
                return await self._async_finish(token, user_input[CONF_USERNAME])
            except VelvetAuthError:
                errors["base"] = "invalid_auth"
            except RoomsUnavailable as err:
                errors["base"] = str(err)
            except VelvetConnectionError:
                errors["base"] = "cannot_connect"
            except VelvetApiError:
                errors["base"] = "unknown"
        return self.async_show_form(
            step_id="password",
            data_schema=self.add_suggested_values_to_schema(
                PASSWORD_SCHEMA, {CONF_USERNAME: (user_input or {}).get(CONF_USERNAME)}
            ),
            errors=errors,
        )

    async def _async_finish(self, token: str | None, username: str | None) -> ConfigFlowResult:
        try:
            await self._client(token).rooms()
        except VelvetApiError as err:
            if err.status == 403:
                raise RoomsUnavailable("no_rooms_permission") from err
            if err.code == "rooms_disabled":
                raise RoomsUnavailable("rooms_disabled") from err
            raise
        data = {
            CONF_URL: self._url,
            CONF_VERIFY_SSL: self._verify_ssl,
            CONF_TOKEN: token,
            CONF_USERNAME: username,
            CONF_INSTANCE_ID: self._instance_id,
        }
        if self.source == SOURCE_REAUTH:
            return self.async_update_reload_and_abort(self._get_reauth_entry(), data_updates=data)
        host = urlsplit(self._url).hostname
        title = f"Velvet ({username}@{host})" if username else f"Velvet ({host})"
        return self.async_create_entry(title=title, data=data)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The stored token stopped working."""
        self._url = entry_data[CONF_URL]
        self._verify_ssl = entry_data.get(CONF_VERIFY_SSL, True)
        self._instance_id = entry_data[CONF_INSTANCE_ID]
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm, then sign in again."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                info = await self._client().ping_public()
            except VelvetError:
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(info["instanceId"])
                self._abort_if_unique_id_mismatch(reason="wrong_server")
                if not info.get("hasUsers", True):
                    try:
                        return await self._async_finish(None, None)
                    except RoomsUnavailable as err:
                        return self.async_abort(reason=str(err))
                    except VelvetError:
                        return self.async_abort(reason="cannot_connect")
                return await self.async_step_auth()
        return self.async_show_form(
            step_id="reauth_confirm",
            description_placeholders={"url": self._url},
            errors=errors,
        )

    def async_remove(self) -> None:
        """Stop polling when the flow is closed."""
        if self._pair_task and not self._pair_task.done():
            self._pair_task.cancel()
