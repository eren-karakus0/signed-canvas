#!/usr/bin/env python3
"""Notice when the public site can no longer reach the archive.

The canvas is served from Vercel and reads its data through `ARCHIVE_ORIGIN`, which points at
a Cloudflare **quick** tunnel. Cloudflare reassigns that hostname on every tunnel restart, and
`canvas-tunnel.service` is deliberately `Restart=no` so a restart fails loudly rather than
silently moving the archive to an address nothing has been told about.

Loudly, though, was only true on the box. Nothing watched it: `flop-watchdog` checks the
Technocore identity, so a tunnel that died at three in the morning left the public site
showing "the archive could not be read" until a person happened to look.

WHAT IS CHECKED, and in this order, because the order is the diagnosis:

    1. the deployed site's own `/api/health` — what a visitor gets, end to end
    2. the tunnel unit — is the process even running
    3. the hostname cloudflared is currently advertising, read from its journal
    4. the archive directly on loopback — is the data still there behind all of it

A failure at (1) with (4) healthy is the expected shape of this outage: the archive is fine
and the address is stale. The alert then carries the new hostname, so the fix is one paste
into `vercel env` rather than an investigation.

Alerts are deduplicated: a transition always sends, and a persisting failure repeats at most
once every `REPEAT_HOURS` so a broken weekend is not a hundred messages.

Exit codes: 0 healthy, 1 degraded (alert sent or suppressed), 2 could not run the checks.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SITE_HEALTH = "https://signed-canvas.vercel.app/api/health"
LOCAL_HEALTH = "http://127.0.0.1:8787/health"
TUNNEL_UNIT = "canvas-tunnel"
STATE_FILE = Path("/root/flop/canvas/tunnel-watch.json")
TELEGRAM_FILE = Path("/root/flop/telegram.json")

HTTP_TIMEOUT_SECONDS = 20
REPEAT_HOURS = 6
# cloudflared prints the assigned hostname once, in a banner, when the tunnel comes up.
TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

log = logging.getLogger("tunnel-watch")


def get_json(url: str) -> dict:
    """Fetch and parse JSON.

    Raises:
        RuntimeError: for any transport, status or parse failure, with the reason.
    """
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()[:120]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except Exception as exc:
        raise RuntimeError(str(exc)[:160]) from exc
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"not JSON: {body[:120]!r}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"unexpected shape: {type(parsed).__name__}")
    return parsed


def unit_is_active(unit: str) -> bool:
    result = subprocess.run(
        ["systemctl", "is-active", unit], capture_output=True, text=True, timeout=20
    )
    return result.stdout.strip() == "active"


def current_tunnel_host() -> str | None:
    """The hostname cloudflared last advertised, or None if the journal does not say.

    Read from the journal rather than from configuration because a quick tunnel has no
    configuration: the address is assigned at startup and announced exactly once.
    """
    try:
        result = subprocess.run(
            ["journalctl", "-u", TUNNEL_UNIT, "-n", "400", "--no-pager", "-o", "cat"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as exc:
        log.warning("could not read the tunnel journal: %s", exc)
        return None
    found = TUNNEL_URL.findall(result.stdout)
    return found[-1] if found else None


def notify(text: str) -> bool:
    """Best-effort Telegram push. Never raises — a dead notifier must not mask the outage."""
    try:
        config = json.loads(TELEGRAM_FILE.read_text(encoding="utf-8"))
        token, chat = config["bot_token"], config["chat_id"]
    except Exception as exc:
        log.warning("telegram config unusable (%s); alert not sent", exc)
        return False

    payload = urllib.parse.urlencode(
        {"chat_id": chat, "text": text, "disable_web_page_preview": "true"}
    ).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            response.read()
        return True
    except Exception as exc:
        log.warning("telegram push failed: %s", exc)
        return False


def read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        # A missing or corrupt state file means "nothing known yet", which is the safe
        # reading: the next transition alerts rather than being swallowed as a repeat.
        return {}


def write_state(state: dict) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as exc:
        log.warning("could not record state: %s", exc)


def diagnose() -> tuple[bool, str, str | None]:
    """(healthy, human-readable report, current tunnel host)."""
    host = current_tunnel_host()
    tunnel_up = unit_is_active(TUNNEL_UNIT)

    try:
        site = get_json(SITE_HEALTH)
        room = site.get("room", "?")
        lag = site.get("lag", "?")
        placements = site.get("placements", "?")
        return (
            True,
            f"the site reaches the archive · room {room} · {placements} placements · lag {lag}",
            host,
        )
    except RuntimeError as exc:
        # Bound to a plain name: Python unbinds the `as` variable at the end of the block,
        # and the report below is built after it.
        site_error = str(exc)

    try:
        local = get_json(LOCAL_HEALTH)
        archive_note = (
            f"the archive itself is healthy on loopback "
            f"({local.get('placements')} placements, lag {local.get('lag')})"
        )
        data_is_safe = True
    except RuntimeError as local_error:
        archive_note = f"the archive is ALSO unreachable on loopback: {local_error}"
        data_is_safe = False

    lines = [
        "🔴 signed-canvas: the public site cannot reach the archive.",
        "",
        f"site   {SITE_HEALTH}",
        f"       {site_error}",
        f"tunnel {TUNNEL_UNIT} is {'running' if tunnel_up else 'NOT RUNNING'}",
        f"       cloudflared last advertised: {host or 'nothing in the journal'}",
        f"archive {archive_note}",
        "",
    ]

    if not tunnel_up:
        lines.append(
            "Fix: systemctl start canvas-tunnel, then update ARCHIVE_ORIGIN to the"
        )
        lines.append(
            "new hostname it prints — a quick tunnel gets a new one every start."
        )
    elif data_is_safe and host:
        lines.append("The data is fine; the address the site was given is stale. Fix:")
        lines.append("  vercel env rm ARCHIVE_ORIGIN production --yes")
        lines.append(f"  echo {host} | vercel env add ARCHIVE_ORIGIN production")
        lines.append("  vercel --prod")
    else:
        lines.append(
            "Both the site and the archive are unreachable — this is not just the"
        )
        lines.append(
            "tunnel. Check canvas-api and the disk before touching the address."
        )

    return False, "\n".join(lines), host


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    try:
        healthy, report, host = diagnose()
    except Exception as exc:  # a watcher that crashes is a watcher that is not watching
        log.error("checks could not be run: %s", exc)
        return 2

    state = read_state()
    was_healthy = bool(state.get("healthy", True))
    last_host = state.get("host")
    last_alert = float(state.get("last_alert", 0))
    now = time.time()

    if healthy:
        log.info("%s", report)
        if not was_healthy:
            notify(f"🟢 signed-canvas: back up.\n\n{report}")
        # A hostname that changed while everything still works is worth knowing about: the
        # tunnel restarted and the site is running on borrowed time until someone updates it.
        elif last_host and host and host != last_host:
            notify(
                "🟡 signed-canvas: the tunnel hostname changed but the site still works.\n\n"
                f"was {last_host}\nnow {host}\n\n"
                "Nothing is broken yet. Update ARCHIVE_ORIGIN before the deployment is "
                "rebuilt, or the next deploy will point at an address that no longer exists."
            )
        write_state({"healthy": True, "host": host, "last_alert": last_alert})
        return 0

    log.error("%s", report)
    transition = was_healthy
    stale = now - last_alert > REPEAT_HOURS * 3600
    if transition or stale:
        notify(report)
        last_alert = now
    else:
        log.info("alert suppressed: already reported within %d hours", REPEAT_HOURS)
    write_state({"healthy": False, "host": host, "last_alert": last_alert})
    return 1


if __name__ == "__main__":
    sys.exit(main())
