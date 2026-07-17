# Cloudflare Access + Discord Login for FoundryVTT — Design

Date: 2026-07-17
Status: Approved (brainstorming session)

## Problem

The FoundryVTT stack is exposed to players over a Cloudflare Tunnel bound to a named
hostname (`FOUNDRY_HOSTNAME`) on the operator's own domain. Anyone with the URL can reach
the Foundry login page — the tunnel adds transport security (TLS at the edge, no open inbound
port) but no identity gate. The operator runs D&D games for a community that already lives on
Discord and wants login gated by Discord identity: hand players the Cloudflare URL, let only
known players in.

Constraints that shaped the design:

- **The operator is not an admin of the Discord server.** Guild-membership gating is therefore
  unsafe — the operator cannot control who joins the server, and Foundry access grants
  world-level power (see below). Gating must be on a list the operator *does* control.
- **Foundry access is high-privilege.** A logged-in user can be the GM (delete the world, read
  every hidden note/handout). Password-less convenience is acceptable for *players* only if the
  gate in front is trustworthy and the GM account keeps its own password.
- **Discord is not an OIDC provider.** Discord OAuth2 has no `openid` scope, no JWKS endpoint,
  and issues no `id_token`. Cloudflare Access's identity connectors speak OIDC/SAML, so Discord
  cannot be wired to Access directly — a shim is mandatory.
- The tunnel only runs during live sessions; it is not up 24/7.

## Approach (chosen: Cloudflare Access + Discord OIDC shim Worker)

Put **Cloudflare Access** (Zero Trust) in front of the existing tunnel hostname. Access
intercepts every request before it reaches Foundry and requires a successful login against a
configured identity provider. Because Discord isn't OIDC, deploy a small **Discord→OIDC shim
Worker** that Access treats as a Generic OIDC identity provider. Gate on an **allowlist of
specific player Discord user IDs** — a list the operator maintains in the Access policy, not
Discord server membership.

This is entirely dashboard- and Worker-side. **No change to `compose.cloudflare.yml` or the
tunnel** — Access binds to the hostname that is already routed.

### Rejected alternatives

- **Discord guild-membership gate** — rejected: operator is not server admin, cannot control
  membership; would hand GM-capable access to the whole community.
- **Password-protect every Foundry user instead of Access** — rejected: Foundry's own auth is
  weak (shared world, no MFA, brute-forceable over the public URL), and leaves the login page
  itself exposed to the internet.
- **Erisa/discord-oidc-worker (upstream shim)** — rejected as the pinned choice: 17 months
  stale, wrangler 3, and it *forces* the Discord email scope and hard-rejects accounts without a
  verified email (open login bug #13). Overkill for an ID-only gate.
- **Cloudflare Access with email-OTP only (no Discord)** — viable and simpler, but loses the
  "log in with the Discord you already use" experience the operator asked for. Kept instead as
  the **break-glass** secondary method.

## Login flow

1. Player opens the Cloudflare URL (`FOUNDRY_HOSTNAME`).
2. Cloudflare Access intercepts before Foundry and shows its login page.
3. Player picks **Discord**. Discord OAuth2 consent screen.
4. Redirect passes through the **shim Worker**, which mints an OIDC token Access understands.
5. Access reads the `id` claim (the player's numeric Discord user ID) and checks it against the
   allowlist policy.
   - **On the list:** Access sets the `CF_Authorization` cookie; Foundry loads. Player selects
     their Foundry user — no Foundry password.
   - **Not on the list:** blocked at Access; never reaches Foundry.
6. **GM** logs in the same way, then enters a **Foundry password** on the GM user. Players stay
   password-less; the GM account does not.
7. **Break-glass:** a second Access login method, **One-Time PIN** (email a code), lets the
   operator in if Discord or the Worker is down.

WebSockets: Foundry uses socket.io, same-origin with the page, so the `CF_Authorization` cookie
rides along and the socket connects through the tunnel normally.

## Components to set up

### Prerequisites (already satisfied)
- Cloudflare account, owned domain, Zero Trust enabled.
- Tunnel + named hostname route to `http://foundry:30000` — **done, untouched.**

### Discord application
- Create an app at discord.com/developers (no server-admin rights required).
- OAuth2 → **Client ID** + **Client Secret**.
- OAuth2 → **Redirect URI** = the Worker callback URL. Two-pass: fill this in after the Worker
  is deployed and its URL is known.

### Shim Worker
- Tooling: Node + Wrangler (`npm i -g wrangler`), `wrangler login`.
- Source: **Aiko-IT-Systems/cloudflare-discord-oidc-worker**, pinned to SHA
  `c7ebd1db8db61fe5a3fa924fc4fdf25548b4bea0` (current wrangler 4 / jose 6 / hono 4.12;
  supports **identity-only / no-email mode**).
- **KV namespace** (`wrangler kv namespace create ...`) — holds the OIDC signing keys.
- **Worker secrets** (never in the repo): Discord client id, Discord client secret, Cloudflare
  Access team domain. Identity-only mode: no email scope, **no bot token** (`DISCORD_TOKEN`
  omitted — the bot path only activates with a token + `serversToCheckRolesFor`, so the
  operator's lack of server admin is a non-issue).
- `wrangler deploy` → Worker URL → paste its callback back into the Discord Redirect URI.

### Cloudflare Access (dashboard)
1. Zero Trust → Settings → **Authentication** → add **Identity provider** = *Generic OIDC*,
   pointed at the Worker's OIDC endpoints. **Add `id` to the OIDC Claims field** — the Worker
   sets `id`, not the standard `sub`, so Access won't see the Discord ID otherwise.
2. Zero Trust → Access → **Applications** → **Self-hosted**, application hostname =
   `FOUNDRY_HOSTNAME`. Session duration 24h.
3. **Policy 1 — Allow (players):** rule = OIDC Claim `id` **is in** { player Discord IDs }.
   Do **not** use email rules — in no-email mode every user shares the same fallback email
   (`oauth@discord.com`), so an email rule would match everyone or no one.
4. **Policy 2 — Allow (break-glass):** method = One-Time PIN, matching the operator's
   break-glass email address.

### Foundry
- Keep the **GM Foundry user password** set.
- Optionally clear player passwords for frictionless handoff (safe because Access is the gate).

## What lands in git (and what must not)

**In the repo:**
- `DEPLOYMENT.md` — new subsection under "Remote access via Cloudflare Tunnel": the Access +
  Discord setup steps above, the `id`-claim gotcha, allowlist maintenance, the break-glass note.
- `.env.example` — a comment noting Access gates the hostname. **No new env vars** (Worker
  secrets live in Cloudflare, not `.env`).
- Optional: a short `docs/` runbook for adding/removing a player Discord ID from the policy.

**Never in the repo** (guardrail — credentials never committed):
- Discord client secret, Worker secrets, KV signing keys.
- The player Discord ID list, if the operator wants it private — it can live in the Access
  policy only.

The real `.env`, `license.json`, `cookiejar.json` are never read or edited by this work.

## Test plan

Protect the live world by proving the gate on a throwaway target first.

1. **Throwaway hostname.** Route the Worker + a test Access application to a spare
   subdomain / test tunnel — not `FOUNDRY_HOSTNAME`.
2. **Verify identity gate:**
   - Discord login succeeds and returns to the app.
   - An **allowlisted** ID gets in; a **non-allowlisted** ID is blocked at Access.
   - **Break-glass** One-Time PIN gets in independently of Discord.
3. **Verify Foundry through the gate:** Foundry page loads, the **WebSocket connects** (socket.io
   live), and the **GM password prompt** appears on the GM user.
4. **Cut over.** Only after the above passes, bind the Access application to the real
   `FOUNDRY_HOSTNAME` — **between sessions, never mid-game.**
5. **Rollback.** Disable the Access application in the dashboard: the tunnel keeps serving (back
   to the pre-Access unprotected state), instant, no redeploy. Full removal = delete the Access
   application, IdP, Worker, and Discord app.

## Open questions / follow-ups

- Session duration: 24h chosen; revisit if players complain about re-login or if a stricter
  window is wanted.
- Worker supply-chain risk: the Aiko fork is low-star, a detached copy (no shared git history
  with upstream, can't be diffed), and recent commits are automated dependency bumps —
  effectively unmaintained by humans. Pinning to the SHA is the mitigation; re-audit before any
  version bump.
- Whether to keep the player ID list in git (convenience, version history) or Cloudflare-only
  (privacy). Deferred to the operator.
