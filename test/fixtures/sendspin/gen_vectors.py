# Regenerate with: /home/velvet-work/sendspin-venv/bin/python test/fixtures/sendspin/gen_vectors.py
import base64
import warnings
import hashlib
import json
import pathlib

from aiosendspin.noise.constants import SENTINEL_PSK
from aiosendspin.noise.keys import Identity, b64url_encode, psk_id_for
from aiosendspin.noise.models import (
    ClientInitMessage,
    ClientInitPayload,
    NoiseHandshakeMessage,
    NoiseHandshakePayload,
    NoiseMsg1Payload,
    ServerInitMessage,
    ServerInitPayload,
)
from aiosendspin.noise.session import NoiseCipherSuite, NoiseSession, _build_conn
from aiosendspin.noise.wire import _fragment

BLOB_LEN = 140000
OUT = pathlib.Path(__file__).with_name("noise-vectors.json")


def seed(label):
    return hashlib.sha256(label.encode()).digest()


def ident(label):
    return Identity.from_private_bytes(seed(label))


def b64(data):
    return base64.b64encode(data).decode()


SERVER = ident("velvet-test-server-static")
CLIENT = ident("velvet-test-client-static")
LT_PSK = seed("velvet-test-long-term-psk")
PR_PSK = seed("velvet-test-pairing-psk")


def keypair_json(i):
    return {"privateKey": i.private_bytes.hex(), "publicKey": i.public_bytes.hex(), "id": i.peer_id}


def handshake(suite, prologue, tag, *, psk, category, responder_psk):
    ie = ident(f"velvet-test-{suite.name}-{tag}-init-ephemeral")
    re_ = ident(f"velvet-test-{suite.name}-{tag}-resp-ephemeral")
    init = NoiseSession(
        _build_conn(suite=suite, initiator=True, local_static_priv=SERVER.private_bytes,
                    remote_static_pub=CLIENT.public_bytes, prologue=prologue, psk=psk,
                    ephemeral_priv=ie.private_bytes),
        suite=suite,
    )
    resp = NoiseSession(
        _build_conn(suite=suite, initiator=False, local_static_priv=CLIENT.private_bytes,
                    remote_static_pub=SERVER.public_bytes, prologue=prologue, psk=b"\x00" * 32,
                    ephemeral_priv=re_.private_bytes),
        suite=suite,
    )
    msg1_pt = NoiseMsg1Payload(psk_id=psk_id_for(psk), psk_category=category).to_json().encode()
    msg1 = init.write_message(msg1_pt)
    assert resp.read_message(msg1) == msg1_pt
    resp.mix_psk(responder_psk)
    msg2_pt = b"{}"
    msg2 = resp.write_message(msg2_pt)
    fallback = responder_psk != psk
    if fallback:
        init._rebuild = None
        init = NoiseSession(
            _build_conn(suite=suite, initiator=True, local_static_priv=SERVER.private_bytes,
                        remote_static_pub=CLIENT.public_bytes, prologue=prologue, psk=responder_psk,
                        ephemeral_priv=ie.private_bytes),
            suite=suite,
        )
        assert init.write_message(msg1_pt) == msg1
    assert init.read_message(msg2) == msg2_pt
    assert init.handshake_hash == resp.handshake_hash

    to_resp, to_init = [], []
    for i in range(3):
        pt = bytes([0]) + json.dumps({"type": "server/time", "payload": {"n": i}}, separators=(",", ":")).encode()
        to_resp.append({"plaintext": b64(pt), "ciphertext": b64(init.encrypt(pt))})
        pt2 = bytes([0]) + json.dumps({"type": "client/time", "payload": {"n": i}}, separators=(",", ":")).encode()
        to_init.append({"plaintext": b64(pt2), "ciphertext": b64(resp.encrypt(pt2))})
    for pt in [to_resp[0]["plaintext"]]:
        assert resp.decrypt(base64.b64decode(to_resp[0]["ciphertext"])) == base64.b64decode(pt)
    return init, resp, {
        "tag": tag,
        "prologue": b64(prologue),
        "psk": psk.hex(),
        "pskCategory": category,
        "responderPsk": responder_psk.hex(),
        "sentinelFallback": fallback,
        "initiatorEphemeral": keypair_json(ie),
        "responderEphemeral": keypair_json(re_),
        "msg1Payload": msg1_pt.decode(),
        "msg1": b64(msg1),
        "msg1Handshake": NoiseHandshakeMessage(payload=NoiseHandshakePayload(data=b64url_encode(msg1))).to_json(),
        "msg2Payload": msg2_pt.decode(),
        "msg2": b64(msg2),
        "handshakeHash": init.handshake_hash.hex(),
        "toResponder": to_resp,
        "toInitiator": to_init,
    }, to_resp


def suite_vectors(suite):
    client_init = ClientInitMessage(payload=ClientInitPayload(client_id=CLIENT.peer_id, version=1, suite=suite.value)).to_json()
    server_init = ServerInitMessage(payload=ServerInitPayload(server_id=SERVER.peer_id, version=1)).to_json()
    prologue = client_init.encode() + server_init.encode()
    cases = []

    init, resp, case, _ = handshake(suite, prologue, "sentinel", psk=SENTINEL_PSK, category="sn", responder_psk=SENTINEL_PSK)
    body = json.dumps({"type": "server/state", "payload": {"blob": "x" * BLOB_LEN}}, separators=(",", ":")).encode()
    plaintext = bytes([0]) + body
    frames = _fragment(plaintext)
    case["fragmented"] = {
        "json": {"type": "server/state", "payload": {"blob": "x" * 8}},
        "blobLength": BLOB_LEN,
        "plaintextSha256": hashlib.sha256(plaintext).hexdigest(),
        "frames": [
            {
                "length": len(f),
                "head": b64(f[:8]),
                "plaintextSha256": hashlib.sha256(f).hexdigest(),
                "ciphertextSha256": hashlib.sha256(init.encrypt(f)).hexdigest(),
            }
            for f in frames
        ],
    }
    cases.append(case)

    init, resp, case, _ = handshake(suite, prologue, "long_term", psk=LT_PSK, category="lt", responder_psk=LT_PSK)
    cases.append(case)
    rh_prologue = init.handshake_hash
    _, _, rcase, _ = handshake(suite, rh_prologue, "rehandshake", psk=PR_PSK, category="pr", responder_psk=PR_PSK)
    cases.append(rcase)

    _, _, case, _ = handshake(suite, prologue, "sentinel_fallback", psk=LT_PSK, category="lt", responder_psk=SENTINEL_PSK)
    cases.append(case)

    return {"suite": suite.value, "clientInit": client_init, "serverInit": server_init, "cases": cases}


def main():
    warnings.filterwarnings("ignore", message=".*ephemeral keypairs is already set.*")
    out = {
        "generator": "test/fixtures/sendspin/gen_vectors.py (aiosendspin noise + noiseprotocol)",
        "server": keypair_json(SERVER),
        "client": keypair_json(CLIENT),
        "longTermPsk": LT_PSK.hex(),
        "pairingPsk": PR_PSK.hex(),
        "sentinelPsk": SENTINEL_PSK.hex(),
        "sentinelPskId": psk_id_for(SENTINEL_PSK),
        "suites": [suite_vectors(s) for s in NoiseCipherSuite],
    }
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", OUT)


main()
