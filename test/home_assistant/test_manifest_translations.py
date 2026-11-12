"""Hassfest-style checks: manifest keys, strings vs translations, keys used in code."""

from __future__ import annotations

import json
from pathlib import Path
import re

from awesomeversion import AwesomeVersion

ROOT = Path(__file__).resolve().parents[2]
COMPONENT = ROOT / "custom_components" / "velvet"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _flatten(tree: dict, prefix: str = "") -> dict[str, str]:
    flat: dict[str, str] = {}
    for key, value in tree.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            flat.update(_flatten(value, path))
        else:
            flat[path] = value
    return flat


def test_manifest() -> None:
    manifest = _load(COMPONENT / "manifest.json")
    required = {"domain", "name", "codeowners", "config_flow", "documentation", "iot_class", "requirements", "version"}
    assert required <= manifest.keys()
    assert manifest["domain"] == "velvet"
    assert manifest["iot_class"] == "local_polling"
    assert manifest["integration_type"] == "hub"
    assert AwesomeVersion(manifest["version"]).valid
    keys = list(manifest)
    assert keys == ["domain", "name", *sorted(keys[2:])], "hassfest wants domain, name, then sorted keys"
    hacs = _load(ROOT / "hacs.json")
    assert hacs["name"] == manifest["name"]
    assert AwesomeVersion(hacs["homeassistant"]).valid


def test_english_translation_matches_strings() -> None:
    assert _load(COMPONENT / "translations" / "en.json") == _load(COMPONENT / "strings.json")


def test_dutch_translation_complete() -> None:
    en = _flatten(_load(COMPONENT / "strings.json"))
    nl = _flatten(_load(COMPONENT / "translations" / "nl.json"))
    assert en.keys() == nl.keys()
    for key, text in en.items():
        assert set(re.findall(r"{(\w+)}", text)) == set(re.findall(r"{(\w+)}", nl[key])), key


def test_keys_used_in_code_exist() -> None:
    strings = _load(COMPONENT / "strings.json")
    flow = (COMPONENT / "config_flow.py").read_text()
    player = (COMPONENT / "media_player.py").read_text()
    config = strings["config"]
    for step in re.findall(r'(?<!_)step_id="(\w+)"', flow):
        assert step in config["step"] or step == "pair", step
    for error in re.findall(r'errors\["base"\] = "(\w+)"', flow):
        assert error in config["error"], error
    for reason in re.findall(r'reason="(\w+)"', flow):
        assert reason in config["abort"], reason
    for raised in re.findall(r'RoomsUnavailable\("(\w+)"\)', flow):
        assert raised in config["abort"], raised
        assert raised in config["error"], raised
    for action in re.findall(r'progress_action="(\w+)"', flow):
        assert action in config["progress"], action
    for key in re.findall(r'translation_key="(\w+)"', player):
        assert key in strings["exceptions"], key
