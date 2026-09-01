"""The archive's read API.

Five routes and nothing else. It binds loopback only: ADR 0001 put a Cloudflare Tunnel in
front and opened no port, so anything reachable from outside arrives through cloudflared.

    GET  /snapshot        the canvas as two packed planes, plus the seq it is current to
    GET  /since/<seq>     placements newer than <seq>, oldest first
    GET  /cell/<x>/<y>    every placement in one cell, oldest first  (FR-6)
    POST /relay           forward one already-signed placement to technocore.chat
    POST /witness         attach a signature to an archived placement (FR-7)
    GET  /health          what the archive holds, including ingest lag

WHY /relay EXISTS, measured 2026-08-29:

    technocore.chat returns no `access-control-allow-origin` on any endpoint - checked across
    the room read, /kv, /rooms, /config, /openapi.json and /.well-known/agent.json. Its own
    first line says so: "No auth, no client, no JS". A browser can still *send* a signed
    write, because that is a simple GET, but it cannot read the answer, so the status code
    and the assigned sequence are both invisible to it.

    Without this route a browser client cannot tell a rate limit from a duplicate from a
    success, and FR-11 - refusals are explained - is unimplementable.

    The relay is trust-minimal by construction: it holds no key and forwards only the exact
    signed tuple it was given. Altering the text would break the signature and earn a 403
    from the service. It can censor a write; it cannot forge one. FR-10 is unaffected - an
    agent still needs nothing from us, because an agent is not stuck in a browser.

`/witness` is the one write, and it is not a trust hole: a signature is stored only if it
verifies against the payload rebuilt from the row already in the archive. It cannot introduce
a placement, cannot change one, and cannot attach a signature to a message that never reached
the room.

Everything served here except the DID and the numbers is text a stranger typed. It goes out
as JSON strings and is never interpolated into markup; rendering it safely is the client's
job and `design.md` says so.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import urllib.error
import urllib.parse
import urllib.request

from archive import Archive, ArchiveError
from placement import parse as parse_placement
from snapshot import MAX_STACK, encode, pack, pack_stack
from verifier import (
    DID_PATTERN,
    SIGNATURE_PATTERN,
    VerifierError,
    message_payload,
    verify_payload,
)

UPSTREAM = "https://technocore.chat"
RELAY_TIMEOUT = 25
_NONCE = re.compile(r"^[0-9]{1,19}$")
_SEQ_IN_BODY = re.compile(r"\[(\d+)\]")

MAX_BODY_BYTES = 4096

# How much of an over-length body is read and discarded so the 413 can be delivered. Sized to
# cover an honest client that sent a little too much, not to accommodate one that sent a lot.
DISCARD_LIMIT_BYTES = 64 * 1024
SINCE_LIMIT = 2000
CACHE_SECONDS = 2  # short: the edge absorbs the load, but a stale canvas reads as a bug

_SINCE = re.compile(r"^/since/(\d{1,19})$")
_CELL = re.compile(r"^/cell/(\d{1,2})/(\d{1,2})$")

log = logging.getLogger("canvas.app")


class Handler(BaseHTTPRequestHandler):
    server_version = "signed-canvas"
    sys_version = ""

    archive_path: Path = Path("canvas.db")

    def log_message(self, fmt: str, *args: object) -> None:
        log.info("%s %s", self.address_string(), fmt % args)

    # ------------------------------------------------------------ plumbing

    def _send(
        self,
        status: int,
        payload: dict,
        cache: int = 0,
        upstream: int | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        if upstream is not None:
            # The one thing a client cannot work out from the status code alone: whether this
            # relay reached technocore.chat and is repeating its answer, or never got there.
            # Both can surface as 503. A client that guesses wrong either abandons a write the
            # service would have taken, or re-sends one it already refused as a duplicate.
            #
            # A header rather than a body field, because the body is truncated by the client
            # before it is parsed, and reading it would depend on JSON key order surviving
            # that cut. CORS hides a non-safelisted header from script unless it is named
            # here, so it is named here.
            self.send_header("x-relay-upstream", str(upstream))
            self.send_header("access-control-expose-headers", "x-relay-upstream")
        self.send_header(
            "cache-control", f"public, max-age={cache}" if cache else "no-store"
        )
        # The canvas is public and the client is a static page that may be served from
        # anywhere, so reads are open. Nothing here is per-viewer, so there is nothing a
        # cross-origin read could learn that a direct one could not.
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _fail(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _open(self) -> Archive:
        return Archive(type(self).archive_path)

    # ------------------------------------------------------------ routes

    def do_GET(self) -> None:  # noqa: N802 — the base class names it
        path = self.path.split("?", 1)[0]
        try:
            if path == "/snapshot":
                return self._snapshot()
            if path == "/health":
                return self._health()
            match = _SINCE.match(path)
            if match:
                return self._since(int(match.group(1)))
            match = _CELL.match(path)
            if match:
                return self._cell(int(match.group(1)), int(match.group(2)))
        except ArchiveError as exc:
            return self._fail(409, str(exc))
        except Exception:
            log.exception("unhandled error serving %s", path)
            return self._fail(500, "internal error")
        self._fail(404, "no such route")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?", 1)[0]
        if route == "/relay":
            return self._relay()
        if route != "/witness":
            return self._fail(404, "no such route")
        payload = self._read_json_body()
        if payload is None:
            return

        seq, signature = payload.get("seq"), payload.get("sig")
        if not isinstance(seq, int) or seq <= 0:
            return self._fail(400, "seq must be a positive integer")
        if not isinstance(signature, str) or not SIGNATURE_PATTERN.match(signature):
            return self._fail(400, "sig must be 86 base64url characters")

        try:
            with self._open() as archive:
                accepted = archive.witness(seq, signature)
        except ArchiveError as exc:
            return self._fail(404, str(exc))
        if not accepted:
            # 422, not 403: the request was well-formed and we understood it; the signature
            # simply is not a signature over this message.
            return self._fail(
                422, "signature does not verify against the archived placement"
            )
        self._send(200, {"seq": seq, "witnessed": True})

    def _discard_body(self, length: int) -> None:
        """Read and throw away an oversized body, up to a bound.

        Refusing without reading is the right posture for a size guard — draining whatever a
        caller decides to send is the attack, not the defence. But closing the socket while
        the peer is still writing costs it the response: the write fails first and the caller
        sees a reset connection instead of the 413 that explains what it did wrong. That is
        how this showed up here, as a test that failed roughly one run in three.

        So: drain a bounded amount, enough that an ordinary mistake gets a legible answer, and
        stop well before an oversized body becomes free work. Past the bound the connection
        does close mid-write, which is the correct outcome for a caller that is not making an
        ordinary mistake.
        """
        remaining = min(length, DISCARD_LIMIT_BYTES)
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 8192))
            if not chunk:
                break
            remaining -= len(chunk)

    def _read_json_body(self) -> dict | None:
        """The request body as a JSON object, or None after answering with the reason."""
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self._fail(400, "content-length must be an integer")
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            self._discard_body(length)
            self._fail(413, f"body must be 1..{MAX_BODY_BYTES} bytes")
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._fail(400, "body must be UTF-8 JSON")
            return None
        if not isinstance(payload, dict):
            self._fail(400, "body must be a JSON object")
            return None
        return payload

    def _relay(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        did = payload.get("did")
        signature = payload.get("sig")
        nonce = payload.get("nonce")
        text = payload.get("text")

        # Validated to exactly one shape before anything leaves this box. A relay that
        # forwarded whatever it was handed would be an open proxy wearing our address.
        if not isinstance(did, str) or not DID_PATTERN.match(did):
            return self._fail(400, "did must be an Ed25519 did:key")
        if not isinstance(signature, str) or not SIGNATURE_PATTERN.match(signature):
            return self._fail(400, "sig must be 86 base64url characters")
        if not isinstance(nonce, (str, int)) or not _NONCE.match(str(nonce)):
            return self._fail(400, "nonce must be 1-19 decimal digits")
        if not isinstance(text, str) or parse_placement(text) is None:
            return self._fail(400, "text must be a placement: px <x>,<y> <hex step> <token>")

        with self._open() as archive:
            room = archive.room

        # Verified here before forwarding. The service would refuse a bad signature anyway,
        # but sending it spends a request against a dependency already shedding load, and the
        # caller learns the real reason instead of a bare 403.
        try:
            if not verify_payload(did, signature, message_payload(room, str(nonce), text)):
                return self._fail(
                    422, "signature does not verify against that room, nonce and text"
                )
        except VerifierError as exc:
            return self._fail(400, str(exc))

        url = (
            f"{UPSTREAM}/r/{urllib.parse.quote(room, safe="")}/say-signed/"
            f"{did}/{signature}/{nonce}/{urllib.parse.quote(text, safe="")}"
        )
        request = urllib.request.Request(url, headers={"accept": "text/plain"})
        try:
            with urllib.request.urlopen(request, timeout=RELAY_TIMEOUT) as response:
                body = response.read().decode("utf-8", errors="replace")
            status = 200
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            status = exc.code
        except Exception as exc:
            # Not "not placed": the write may have landed and the answer been lost. The
            # caller re-checks the room, exactly as a direct client would.
            return self._send(504, {"upstream": "unreachable", "detail": str(exc)[:160]})

        # The service answers a write with a *room view*, so the body holds many [n] markers
        # and the new message is the last of them. Taking the first reported seq 268 for a
        # write that actually landed at 287 — a number that looked plausible and was wrong,
        # which is the worst kind. The highest marker is the one just written.
        markers = [int(n) for n in _SEQ_IN_BODY.findall(body)]
        seq = max(markers) if markers else 0

        # We now hold a signature that verified, for a write the service accepted. That is
        # the definition of a witnessed pixel, and it is why a browser placement does not
        # have to settle for the service's word about itself.
        witnessed = False
        if status == 200 and seq:
            with self._open() as archive:
                try:
                    witnessed = archive.witness(seq, signature)
                except ArchiveError:
                    # The usual case, not the exception: we hold the signature within
                    # milliseconds of the write, and the ingest loop has not read that
                    # message back yet. Park it; ingest attaches it when the row lands.
                    archive.remember_signature(seq, signature)

        self._send(
            200 if status == 200 else status,
            {
                "upstream_status": status,
                "seq": seq,
                "witnessed": witnessed,
                "detail": body.strip()[:200],
            },
            upstream=status,
        )

    # ------------------------------------------------------------ handlers

    def _snapshot(self) -> None:
        with self._open() as archive:
            rows = list(archive.cells())
            # The levels below each top, so a reload draws the towers that are there rather
            # than flattening the canvas to its newest colours.
            towers = list(archive.tower_rows(MAX_STACK + 1))
            stats = archive.stats()
        cells, witnessed = pack(rows)
        stack = pack_stack(towers)
        self._send(
            200,
            {
                "seq": stats.last_seq,
                "cells": encode(cells),
                "witnessed": encode(witnessed),
                "stack": encode(stack),
                "painted": len(rows),
                "signers": stats.signers,
                "witnessed_count": stats.witnessed,
                "lag": stats.lag,
            },
            cache=CACHE_SECONDS,
        )

    def _since(self, seq: int) -> None:
        with self._open() as archive:
            rows = archive.since(seq, limit=SINCE_LIMIT)
            stats = archive.stats()
        self._send(
            200,
            {
                "seq": stats.last_seq,
                "from": seq,
                # A truncated delta is not an error, but a client that ignored it would paint
                # a canvas missing the middle of its own history.
                "truncated": len(rows) == SINCE_LIMIT,
                "placements": [
                    {
                        "seq": row.seq,
                        "ts": row.ts,
                        "did": row.did,
                        "cx": row.cx,
                        "cy": row.cy,
                        "step": row.step,
                        "witnessed": row.witnessed,
                    }
                    for row in rows
                ],
            },
            cache=CACHE_SECONDS,
        )

    def _cell(self, cx: int, cy: int) -> None:
        if not (0 <= cx < 64 and 0 <= cy < 64):
            return self._fail(400, "cell out of bounds")
        with self._open() as archive:
            rows = archive.history(cx, cy)
            room = archive.room
        self._send(
            200,
            {
                "cx": cx,
                "cy": cy,
                "placements": [
                    {
                        "seq": row.seq,
                        "ts": row.ts,
                        "did": row.did,
                        "step": row.step,
                        "witnessed": row.witnessed,
                        # The material FR-7 exports. `sig` is null for an attested pixel, and
                        # the client must say "no signature held" rather than dress the rest
                        # up as a proof.
                        "payload": f"{room}|{row.nonce}|{row.text}",
                        "sig": row.sig,
                    }
                    for row in rows
                ],
            },
            cache=CACHE_SECONDS,
        )

    def _health(self) -> None:
        with self._open() as archive:
            stats = archive.stats()
            room = archive.room
        self._send(
            200,
            {
                "room": room,
                "seq": stats.last_seq,
                "room_seq": stats.room_last_seq,
                "lag": stats.lag,
                "placements": stats.placements,
                "witnessed": stats.witnessed,
                "pending_signatures": stats.pending,
                "signers": stats.signers,
            },
        )


def serve(
    archive_path: Path, host: str = "127.0.0.1", port: int = 8787
) -> ThreadingHTTPServer:
    """Start the server. The caller owns the returned object and must close it."""
    Handler.archive_path = archive_path
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve the canvas archive.")
    parser.add_argument(
        "--archive", type=Path, default=Path("/root/flop/canvas/canvas.db")
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="loopback by default; cloudflared reaches it there",
    )
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    server = serve(args.archive, args.host, args.port)
    log.info("serving %s on http://%s:%d", args.archive, args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
