# Regenerate with: /home/velvet-work/sendspin-venv/bin/python -I test/fixtures/sendspin/gen_pairing_vectors.py
# Drives aiosendspin's own pairing client and server functions against each other over an
# in-memory socket, with secrets.token_bytes replaced by a seeded generator, and records every
# message and every random value each side drew.
import asyncio
import hashlib
import inspect
import json
import pathlib
import secrets
from types import SimpleNamespace

import cpace
from aiohttp import WSMsgType

from aiosendspin.models.types import PairAbortReason, PairingCodeFormat
from aiosendspin.noise import pairing as P
from aiosendspin.noise.keys import Identity, b64url_encode, psk_id_for
from aiosendspin.noise.pairing_token import (
    PSKPairingToken,
    decode_pairing_code_token,
    decode_psk_token,
    encode_pairing_code_token,
    encode_psk_token,
)
from aiosendspin.noise.session import NoiseCipherSuite
from aiosendspin.noise.trust_store import InMemoryClientPairingStore, InMemoryServerPairingStore

OUT = pathlib.Path(__file__).with_name("pairing-vectors.json")
WHO = {
    "_run_server_pake": "serverScalar",
    "_run_client_pake": "clientScalar",
    "run_dynamic_pairing_code_server": "nonceA",
    "run_dynamic_pairing_code_client": "nonceB",
    "resolve_pairing_outcome": "longTermPsk",
}


def seed(label):
    return hashlib.sha256(label.encode()).digest()


CLIENT = Identity.from_private_bytes(seed("velvet-test-client-static"))
SERVER = Identity.from_private_bytes(seed("velvet-test-server-static"))
PAIRING_PSK = seed("velvet-test-pairing-psk")


class Rng:
    def __init__(self, label):
        self.label = label
        self.n = 0
        self.draws = []

    def __call__(self, size=32):
        who = next((WHO[f.function] for f in inspect.stack() if f.function in WHO), "other")
        self.n += 1
        value = hashlib.sha256(f"{self.label}-{self.n}".encode()).digest()[:size]
        self.draws.append({"who": who, "hex": value.hex()})
        return value


class FakeWs:
    def __init__(self, name, suite, log):
        self.name = name
        self.session = SimpleNamespace(suite=suite)
        self.inbox = asyncio.Queue()
        self.peer = None
        self.log = log

    async def send_str(self, text):
        self.log.append({"from": self.name, "message": json.loads(text)})
        await self.peer.inbox.put(SimpleNamespace(type=WSMsgType.TEXT, data=text))

    async def receive(self):
        return await self.inbox.get()


def link(suite):
    log = []
    server = FakeWs("server", suite, log)
    client = FakeWs("client", suite, log)
    server.peer, client.peer = client, server
    return server, client, log


async def outcome(coro):
    try:
        return {"ok": await coro}
    except P.PairingAbortError as exc:
        return {"abort": exc.reason.value, "local": isinstance(exc, P.LocalPairingAbortError)}
    except P.PairingError as exc:
        return {"error": str(exc)}


async def run(label, suite, server_coro, client_coro):
    rng = Rng(label)
    secrets.token_bytes = rng
    cpace.secrets.token_bytes = rng
    server_res, client_res = await asyncio.gather(outcome(server_coro), outcome(client_coro))
    return rng, server_res, client_res


def record_json(rec):
    if rec is None:
        return None
    return {"clientId": rec.client_id, "psk": rec.psk.hex(), "pskId": rec.psk_id,
            "pairMethods": [m.value for m in rec.pair_methods]}


def codes(entries):
    queue = list(entries)

    async def provider():
        return queue.pop(0)

    return provider


async def flow_psk():
    suite = NoiseCipherSuite.CHACHAPOLY
    server, client, log = link(suite)
    sstore, cstore = InMemoryServerPairingStore(), InMemoryClientPairingStore()
    rng, sres, cres = await run(
        "psk", suite,
        P.run_pairing_psk_server(server, pairing_index=1, client_id=CLIENT.peer_id, store=sstore,
                                 pairing_psk=PAIRING_PSK),
        P.run_pairing_psk_client(client, pairing_index=1, server_id=SERVER.peer_id, store=cstore),
    )
    crec = await cstore.record_by_server_id(SERVER.peer_id)
    return {"method": "pairing_psk", "suite": suite.value, "pairingIndex": 1, "draws": rng.draws,
            "messages": log, "serverRecord": record_json(sres.get("ok")),
            "clientRecordPsk": crec.psk.hex() if crec else None, "server": _res(sres), "client": _res(cres)}


def _res(res):
    return {k: v for k, v in res.items() if k != "ok"} or {"ok": True}


async def flow_dynamic(label, suite, fmt, pairing_index, entered, h):
    server, client, log = link(suite)
    sstore, cstore = InMemoryServerPairingStore(), InMemoryClientPairingStore()
    emitted = []
    typed = []

    async def emitter(code):
        emitted.append(code)

    plan = list(entered)

    async def provider():
        while not emitted:
            await asyncio.sleep(0)
        typed.append(plan.pop(0)(emitted[-1]))
        return typed[-1]

    rng, sres, cres = await run(
        label, suite,
        P.run_dynamic_pairing_code_server(server, handshake_hash=h, pairing_index=pairing_index,
                                          pairing_code_provider=provider, pairing_format=fmt,
                                          client_id=CLIENT.peer_id, store=sstore),
        P.run_dynamic_pairing_code_client(client, handshake_hash=h, pairing_index=pairing_index,
                                          pairing_format=fmt, pairing_code_emitter=emitter,
                                          server_id=SERVER.peer_id, store=cstore),
    )
    crec = await cstore.record_by_server_id(SERVER.peer_id)
    return {"method": "dynamic_pairing_code", "format": fmt.value, "suite": suite.value, "label": label,
            "pairingIndex": pairing_index, "handshakeHash": h.hex(), "entered": typed, "emitted": emitted,
            "draws": rng.draws, "messages": log, "serverRecord": record_json(sres.get("ok")),
            "clientRecordPsk": crec.psk.hex() if crec else None, "server": _res(sres), "client": _res(cres)}


async def flow_static(label, suite, pairing_index, entered, code, h):
    server, client, log = link(suite)
    sstore, cstore = InMemoryServerPairingStore(), InMemoryClientPairingStore()
    rng, sres, cres = await run(
        label, suite,
        P.run_static_pairing_code_server(server, handshake_hash=h, pairing_index=pairing_index,
                                         pairing_code_provider=codes([entered]), client_id=CLIENT.peer_id,
                                         store=sstore),
        P.run_static_pairing_code_client(client, handshake_hash=h, pairing_index=pairing_index,
                                         static_pairing_code=code, server_id=SERVER.peer_id, store=cstore),
    )
    crec = await cstore.record_by_server_id(SERVER.peer_id)
    return {"method": "static_pairing_code", "suite": suite.value, "label": label, "pairingIndex": pairing_index,
            "handshakeHash": h.hex(), "staticCode": code, "entered": [entered], "draws": rng.draws,
            "messages": log, "serverRecord": record_json(sres.get("ok")),
            "clientRecordPsk": crec.psk.hex() if crec else None, "server": _res(sres), "client": _res(cres)}


def cpace_vector():
    prs = b"12345678"
    sid = P._pake_sid(seed("velvet-test-h"), 3, 2)
    ya_s, yb_s = seed("cpace-a"), seed("cpace-b")
    gen = cpace._calculate_generator(prs, b"", sid)
    a = cpace.CPace(role=cpace.CPaceRole.INITIATOR, sid=sid, ad=b"server", scalar=ya_s,
                    public_share=cpace._scalar_mult_vfy(ya_s, gen))
    b = cpace.CPace(role=cpace.CPaceRole.RESPONDER, sid=sid, ad=b"client", scalar=yb_s,
                    public_share=cpace._scalar_mult_vfy(yb_s, gen))
    ya, yb = a.public_share, b.public_share
    a.derive(yb, b"client")
    b.derive(ya, b"server")
    assert a.isk == b.isk and a.verify(b.tag()) and b.verify(a.tag())
    elligator = []
    for i in range(8):
        r = int.from_bytes(seed(f"elligator-{i}"), "little")
        elligator.append({"r": hex(r), "u": cpace._elligator2(r).hex()})
    elligator.append({"r": hex(0), "u": cpace._elligator2(0).hex()})
    return {"prs": prs.hex(), "sid": sid.hex(), "generatorString": cpace._generator_string(prs, b"", sid).hex(),
            "generator": gen.hex(), "scalarA": ya_s.hex(), "scalarB": yb_s.hex(), "Ya": ya.hex(), "Yb": yb.hex(),
            "isk": a.isk.hex(), "Ta": a.tag().hex(), "Tb": b.tag().hex(), "elligator": elligator,
            "lowOrderShareRejected": cpace._scalar_mult_vfy(ya_s, bytes(32)) is None}


def tokens():
    spec_key = bytes(range(32))
    spec_psk = bytes(range(0xE0, 0x100))
    spec_code = bytes(range(0xE0, 0xF8))
    spec_cid = b64url_encode(spec_key)
    out = {
        "specPsk": {"clientKey": spec_key.hex(), "clientId": spec_cid, "pairingPsk": spec_psk.hex(),
                    "token": encode_psk_token(PSKPairingToken(client_id=spec_cid, pairing_psk=spec_psk))},
        "specCode": {"code": spec_code.hex(), "token": encode_pairing_code_token(spec_code)},
        "client": {"clientId": CLIENT.peer_id, "pairingPsk": PAIRING_PSK.hex(),
                   "pairingPskId": psk_id_for(PAIRING_PSK),
                   "token": encode_psk_token(PSKPairingToken(client_id=CLIENT.peer_id, pairing_psk=PAIRING_PSK))},
    }
    tok = out["client"]["token"]
    lenient = ["  " + tok.lower() + "\n", tok[3:], tok.replace("9", "2"), "sp:" + tok[3:].lower(),
               tok + "AAAAAAAA"]
    out["lenient"] = []
    for v in lenient:
        d = decode_psk_token(v)
        out["lenient"].append({"input": v, "clientId": d.client_id, "pairingPsk": d.pairing_psk.hex()})
    bad = ["", "SP:", "SP:1" + tok[4:], tok[:-10], "SP:0!!!!", "SP:0AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYP6BYPC4PSOLZXH5DU6V97M5XXO74HR6LZ7J5PW674PT6X37T6757Y1",
           "SP:0é"]
    out["rejected"] = []
    for v in bad:
        try:
            decode_psk_token(v)
            out["rejected"].append({"input": v, "rejected": False})
        except ValueError as exc:
            out["rejected"].append({"input": v, "rejected": True, "error": str(exc)})
    assert decode_pairing_code_token(out["specCode"]["token"]) == spec_code
    return out


async def main():
    h1, h2, h3 = seed("velvet-test-h-1"), seed("velvet-test-h-2"), seed("velvet-test-h-3")
    flows = [await flow_psk()]
    # Digits: a wrong code in round 1, so the client retries; the emitted code in round 2.
    flows.append(await flow_dynamic("dyn-digits", NoiseCipherSuite.CHACHAPOLY, PairingCodeFormat.DIGITS, 1,
                                    [lambda c: f"{(int(c) + 1) % 1_000_000:06d}", lambda c: c[:3] + " " + c[3:]], h1))
    flows.append(await flow_dynamic("dyn-qr", NoiseCipherSuite.AESGCM, PairingCodeFormat.QR_CODE, 2,
                                    [lambda c: "  " + c.lower()], h2))
    flows.append(await flow_static("static-ok", NoiseCipherSuite.AESGCM, 1, "1234-5678", "12345678", h3))
    flows.append(await flow_static("static-wrong", NoiseCipherSuite.CHACHAPOLY, 1, "87654321", "12345678", h3))
    for f in flows:
        assert not any(d["who"] == "other" for d in f["draws"]), f["label"] if "label" in f else f["method"]
    out = {
        "generator": "test/fixtures/sendspin/gen_pairing_vectors.py (aiosendspin pairing + cpace-py)",
        "serverId": SERVER.peer_id,
        "clientId": CLIENT.peer_id,
        "pairingPsk": PAIRING_PSK.hex(),
        "tokens": tokens(),
        "cpace": cpace_vector(),
        "flows": flows,
    }
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", OUT)
    for f in flows:
        print(f.get("label", f["method"]), "server:", f["server"], "client:", f["client"],
              "msgs:", [m["message"]["type"] for m in f["messages"]])


asyncio.run(main())
