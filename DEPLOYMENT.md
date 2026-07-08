# FoundryVTT Docker Deployment Guide

Deploying this repo's FoundryVTT stack:

- ✅ Secure credential management (no secrets in the repo)
- ✅ Live data on the host at `FOUNDRY_DATA_PATH`
- ✅ Optional remote access via Cloudflare Tunnel (no inbound ports)
- ✅ Optional monitoring stack (Netdata + Dozzle)

## Quick Start

### 1. Initial setup

```bash
cp .env.example .env
./deploy-setup.sh        # guided setup — or edit .env by hand
```

Required variables:

- `FOUNDRY_RELEASE_URL` — timed URL from your Foundry license page (Node.js
  option), **or** `FOUNDRY_USERNAME` + `FOUNDRY_PASSWORD` as fallback
- `FOUNDRY_ADMIN_KEY` — admin panel password (compose refuses to start
  without it)

Optional:

- `CF_TUNNEL_TOKEN` — for remote access via Cloudflare Tunnel
- `FOUNDRY_PORT` — published port (default 30000)
- `FOUNDRY_DATA_PATH` — host data directory
  (default `~/.local/share/FoundryVTT`)

### 2. Start

```bash
docker compose up -d                                              # basic, local access only
docker compose -f compose.yml -f compose.cloudflare.yml up -d     # + Cloudflare Tunnel remote access
docker compose --profile monitoring up -d                         # + Netdata/Dozzle dashboards
```

Foundry answers on <http://localhost:30000>.

### 3. Stop

```bash
docker compose -f compose.yml -f compose.cloudflare.yml stop cloudflared   # stop just the tunnel
docker compose down                                                        # stop everything
```

## Data location (important)

The live server data is at `FOUNDRY_DATA_PATH` from `.env`
(default `~/.local/share/FoundryVTT`), bind-mounted to `/data` in the
container. Everything you change in the FoundryVTT UI is written there
immediately and survives container restarts and upgrades.

```bash
# Quick worlds backup before risky changes
tar -czf ~/foundry-worlds-backup-$(date +%F).tar.gz \
  -C ~/.local/share/FoundryVTT/Data worlds

# Worlds reference images/audio in assets/ — back that up too when it changes.
# NOTE: FoundryVTT's built-in backups (Setup -> Manage Backups) do NOT include
# multimedia assets; a worlds-only restore will have broken image/audio links.
tar -czf ~/foundry-assets-backup-$(date +%F).tar.gz \
  -C ~/.local/share/FoundryVTT/Data assets
```

Migrating data from another machine, and restoring Foundry-native backups,
is covered in **[BACKUP_RESTORE.md](./BACKUP_RESTORE.md)** (SSH key setup,
rsync pull, step-by-step restore, troubleshooting).

## Remote access via Cloudflare Tunnel

A Cloudflare Tunnel gives players a stable HTTPS URL with **no port forwarding
and no inbound ports** — `cloudflared` dials outbound to Cloudflare's edge,
which terminates TLS. It's free and faster than the free ngrok tier this repo
used previously. Requires a Cloudflare account and a domain on Cloudflare.

The tunnel lives in the `compose.cloudflare.yml` overlay, applied with `-f` so
the base stack (and plain `http://localhost:30000`) is unaffected when you're
not tunneling.

### One-time setup

1. **Create the tunnel.** Cloudflare Zero Trust dashboard → **Networks →
   Tunnels → Create a tunnel** (type *Cloudflared*). Copy the **tunnel token**.
2. **Route a hostname to it.** In the tunnel's *Public Hostnames*, add e.g.
   `vtt.example.com` → service `http://foundry:30000`. Cloudflare creates the
   DNS record for you.
3. **Set the env vars** in `.env`:

   ```bash
   CF_TUNNEL_TOKEN=<token from step 1>
   FOUNDRY_HOSTNAME=vtt.example.com     # the public hostname from step 2
   ```

   Leave `FOUNDRY_SSL_CERT`/`FOUNDRY_SSL_KEY` empty — Cloudflare owns TLS. The
   overlay sets `FOUNDRY_PROXY_PORT=443` and `FOUNDRY_PROXY_SSL=true` so Foundry
   advertises `https`/`wss` URLs while serving plain http internally.

### Run

```bash
docker compose -f compose.yml -f compose.cloudflare.yml up -d
docker compose -f compose.yml -f compose.cloudflare.yml logs -f cloudflared
```

Foundry is then reachable at `https://<FOUNDRY_HOSTNAME>`.

> **Hardening:** put **Cloudflare Access** in front of the hostname (Zero Trust
> → Access → Applications) to require SSO/email before Foundry even loads —
> dashboard-side, no compose change. On the free plan, uploads *through* the
> tunnel are capped at 100 MB per request; upload large assets locally via
> `http://localhost:30000` instead. Pin the `cloudflared` image to a digest
> (see the note in `compose.cloudflare.yml`).

## Monitoring & performance

### Live monitoring (optional, off by default)

```bash
docker compose --profile monitoring up -d    # start
docker compose --profile monitoring down     # stop
```

- **Netdata** (<http://localhost:19999>): per-container CPU, memory, network,
  and disk graphs. Check the `foundry` container here during a laggy session
  to rule the server in or out.
- **Dozzle** (<http://localhost:8080>): live container logs in the browser.

Both bind to loopback — reachable from the host only, by design (they are
unauthenticated and mount the docker socket).

### Diagnosing lag during a session

1. **Framerate vs network** (official FoundryVTT test): have the affected
   player disable the Game Canvas in settings. If chat/sheets/rolls become
   responsive, it's their client GPU/framerate; if delays persist, it's
   network.
2. **One player or everyone?** The player list shows a per-player latency
   indicator — one red ping means their connection, all red means your side.
3. **Your side**: open Netdata. If the foundry container is idle (it usually
   is), the bottleneck is your upload bandwidth. FoundryVTT recommends at
   least 12 Mbps upload for self-hosting.

Note: the FoundryVTT **server** is headless Node.js and does not use a GPU —
rendering happens in each player's browser. There is nothing to accelerate
server-side.

### Performance settings

Static-file and websocket compression are enabled by default via
`FOUNDRY_MINIFY_STATIC_FILES` and `FOUNDRY_COMPRESS_WEBSOCKET` in
`compose.yml`. The container regenerates `Config/options.json` from
environment variables on every start — change settings in `.env` /
`compose.yml`, not by editing `options.json` directly.

## Common commands

```bash
docker compose logs -f foundry        # follow server logs
docker compose ps                     # status / health
docker compose restart foundry        # restart the server
```

## Troubleshooting

### FoundryVTT won't start

- Check logs: `docker compose logs foundry`
- Verify `FOUNDRY_RELEASE_URL` in `.env` (timed URLs expire — regenerate on
  the license page), or valid fallback credentials
- Ensure port 30000 is not in use

### Cloudflare Tunnel not connecting

- Verify `CF_TUNNEL_TOKEN` in `.env` matches the tunnel in the dashboard
- Check the tunnel shows **Healthy** in Zero Trust → Networks → Tunnels
- Confirm the public hostname routes to `http://foundry:30000`
- Check logs:
  `docker compose -f compose.yml -f compose.cloudflare.yml logs cloudflared --tail=100`

## Security considerations

1. **Never commit `.env`** — it's in `.gitignore`, and agents are barred from
   reading it (see [SECURITY.md](SECURITY.md))
2. **Cloudflare Tunnel token** (`CF_TUNNEL_TOKEN`) — a live credential; if
   exposed, delete and recreate the tunnel in the dashboard (it can't be
   rotated in place)
3. **Firewall** — restrict access to port 30000 if not tunneling. The tunnel
   itself opens no inbound ports; players never reach 30000 directly
4. **SSL/TLS** — configure `FOUNDRY_SSL_CERT` / `FOUNDRY_SSL_KEY` when
   exposing directly

## Production hardening ideas

1. SSL/TLS with valid certificates (or terminate at a Cloudflare Tunnel)
2. Watchtower for automatic image updates (see
   `docker-compose.override.example.yml`)
3. Scheduled backups of the live data path (worlds **and** assets)
4. Resource limits in a compose override

## Support & resources

- FoundryVTT docs: <https://foundryvtt.com/>
- Container image: <https://ghcr.io/felddy/foundryvtt> —
  all image environment variables:
  [upstream README](https://github.com/felddy/foundryvtt-docker#readme)
- Cloudflare Tunnel docs:
  <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
