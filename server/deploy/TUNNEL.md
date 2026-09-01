# Exposing the archive — Cloudflare Tunnel

The archive listens on `127.0.0.1:8787` and nothing else. `ss -tlnp` on the host shows port
22 and that loopback socket; no inbound port was opened for this service and none should be.

That is the decision from ADR 0001, taken because this box also runs `flop-agent`,
`flop-watchdog`, `alertbot` and `kartel-ca-watcher`. Opening 443 would put all of them behind
a new public surface to serve one 3.5 KB JSON document.

## Why this step is not scripted

`cloudflared tunnel login` opens a browser and asks you to pick a zone. It needs a human with
the Cloudflare account, and a token minted by that login is a credential this repository
should never hold. So the commands are here, and you run them.

## Steps

Run these on the server. In this terminal, prefix with `!` to run them here and put the
output in the conversation — for example `! ssh -i ~/.ssh/id_ed25519 root@<host>`.

`<host>` is deliberately not written down. This file is public and the address of a box that
accepts root over SSH is not something to publish for the sake of saving a paste.

**1. Install cloudflared** (Cloudflare's own apt repository):

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update && apt-get install -y cloudflared
cloudflared --version
```

**2. Authenticate.** This prints a URL; open it, pick the zone you want the hostname under.

```bash
cloudflared tunnel login
```

**3. Create the tunnel and route a hostname.** Pick the hostname; `canvas.<your-domain>` is
the obvious one.

```bash
cloudflared tunnel create signed-canvas
cloudflared tunnel route dns signed-canvas canvas.<your-domain>
```

**4. Configure it** — `/etc/cloudflared/config.yml`:

```yaml
tunnel: signed-canvas
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: canvas.<your-domain>
    service: http://127.0.0.1:8787
  # Anything not matched is refused rather than forwarded. Without this the tunnel is a
  # general-purpose door into the host's loopback interface, where the other projects live.
  - service: http_status:404
```

**5. Run it as a service:**

```bash
cloudflared service install
systemctl enable --now cloudflared
systemctl is-active cloudflared
```

**6. Check it from outside the box:**

```bash
curl -fsS https://canvas.<your-domain>/health
```

Expect the same JSON that `curl http://127.0.0.1:8787/health` returns on the host.

## After it is up

- **Confirm nothing else opened.** `ss -tlnp` must still show only `22` and the loopback
  `8787`. If a new `0.0.0.0` socket appeared, something other than this tunnel did it.
- **Set the cache.** `/snapshot` and `/since` already send `cache-control: max-age=2`; a
  Cloudflare cache rule on `/snapshot` is what makes the archive cheap to read at any traffic
  level. `/health` and `/witness` must not be cached.
- **`/witness` is the only write.** It accepts a signature and stores it only if the
  signature verifies against a placement already in the archive. It cannot introduce or alter
  a pixel. Still worth a Cloudflare rate-limit rule, since it is the one route that does work
  on request.

## If the tunnel is not set up

Nothing breaks. The archive keeps following the room and keeps its record; it is simply not
readable from anywhere but the host. The client cannot load a snapshot until this is done, so
it falls back to reading the room directly — the last 200 placements and nothing older, which
`design.md` requires the interface to state plainly rather than pass off as the whole canvas.
