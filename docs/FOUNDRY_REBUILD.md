# Rebuilding FoundryVTT from durable sources

FoundryVTT is treated as a **transient container**. Durable truth lives outside
its world DB:

- **Obsidian vault** (`~/Documents/DnD`, bind-mounted into Foundry at
  `/data/Data/DnD`) — prose, notes, assets, map specs, and the ```statblock
  fences that Foundry actors are compiled from.
- **Git content module(s)** — built from the vault (see `CONTENT_AUTHORING.md`).
- **D&D Beyond** — player characters.

So a world can be wiped and rebuilt. But "transient" is not the same as "free",
and the section below says exactly what a rebuild costs.

## What actually survives a wipe

Foundry has two kinds of compendium, and the difference decides what you lose.

| Kind | Lives in | Survives a world wipe? |
| --- | --- | --- |
| **Module** compendium (`dnd5e.monsters`, `<your-game>-oneshot.actors`) | the module folder on disk | **Yes** |
| **World** compendium (`world.ddb-<world>-ddb-spells`) | inside the world folder | **No** |

Note the world id baked into that second pack name. All twelve
`world.ddb-*` packs that ddb-importer creates are world-scoped, so a rebuild
costs a **full ddb-importer re-run**. That is acceptable — D&D Beyond is the
source of truth — but it is a step, not a freebie, and it used to be missing
from this page.

Genuinely transient, and fine to lose: token positions, fog of war, the combat
tracker, the active scene.

## The golden base

`foundry-base.json` pins the system and the core module set;
`scripts/content/foundry-base.mjs` acts on it. Run these on the **host** — the
devcontainer has no docker socket and does not mount the Foundry data directory.

```bash
node scripts/content/foundry-base.mjs capture <world>   # read a live world into a pinned manifest
node scripts/content/foundry-base.mjs world-capture <world>  # record a configured world as the template
node scripts/content/foundry-base.mjs promote <capture>  # fill core pins from a capture
node scripts/content/foundry-base.mjs provision         # install the pinned system + modules
node scripts/content/foundry-base.mjs update [id...]    # move pins forward, deliberately
node scripts/content/foundry-base.mjs snapshot          # full copy of the data dir, worlds included
node scripts/content/foundry-base.mjs restore --yes     # put that full copy back
node scripts/content/foundry-base.mjs snapshot --golden # the clean slate: no worlds
node scripts/content/foundry-base.mjs restore --golden --yes  # reset the instance, keep the worlds
node scripts/content/foundry-base.mjs pull-games        # build + sync every game in the manifest
node scripts/content/foundry-base.mjs verify [world]   # check the install against the pins
```

### Adjusting core

The golden base is meant to be *tuned*, not guessed at once. Run the drill, see
what breaks, add what was missing, run it again:

```bash
node scripts/content/foundry-base.mjs add <id> --from foundry-capture-<world>.json \
  --note "why this is here"
node scripts/content/foundry-base.mjs remove <id>
```

`add` takes the version and manifest URL from a capture file, or from the
installed `module.json` when no `--from` is given. Either way the module tells us
about itself — ids are routinely nothing like their titles, so nothing is typed.
Adding the same module twice updates it rather than duplicating, an existing
`note` survives a re-add, and a deliberately pinned URL is never overwritten.

Adding a module that is on the `deliberatelyExcluded` list **removes it from
that list and prints the reason it just overruled**. The manifest must not say
both "pinned in core" and "kept out of core, here is why" — that is how a
rationale file rots into fiction. Refusing the add would be worse: reversing the
decision is the operator's call and they have just made it. So the tool reverses
it out loud, and says the old reason is gone, in case it still holds and belongs
in `--note`.

**`provision` does not resolve dependency chains.** It installs exactly what is
pinned, so a lean core can come up with a quality-of-life module quietly broken.
Each failure names a module to `add`, with a note saying why it earned its place.

The current core was checked against every reachable manifest and **the set is
closed** — the only declared requirements are `lib-wrapper` (by
`fvtt-perf-optim`) and `enhancedcombathud` (by `enhancedcombathud-dnd5e`), and
both are already pinned. Re-check after any `add` or `update`; a manifest's
`relationships.requires` is the authority, not memory.

Four pins are hosted on **gitlab.com**, not GitHub: `dice-so-nice`,
`_chatcommands`, `chatlog-prune` and `settings-extender`. `provision` runs on
the host and reaches them fine — but they cannot be verified from inside the
devcontainer, whose egress allowlist (`.devcontainer/init-firewall.sh`) covers
GitHub, npm, PyPI and little else. An agent reporting "fetch failed" for exactly
those four is describing the firewall, not a broken pin.

Two pins carry a URL-shaped risk that no version number shows, so both say so in
their `note`:

- **`settings-extender`** resolves through a **GitLab CI job artifact**, and
  GitLab expires job artifacts. That pin can rot with nothing here changing —
  the same class of failure as the timed `FOUNDRY_RELEASE_URL`, and it will
  surface as a `provision` failure mid-rebuild. Suspect the URL before the
  module.
- **`scene-packer`** is pinned to a **version-locked manifest URL**
  (`.../2.8.12/module.json`) rather than a `/latest/` one. That makes the pin
  admirably stable and makes `update` useless on it: the URL always answers with
  the version it names, so it will report `current` forever. Move that one by
  editing the URL and the version together.

**Stop Foundry first.** `capture` reads a world's LevelDB settings store, and
LevelDB takes an exclusive lock — a running Foundry holds it, and the raw error
(`Database is not open`) looks like corruption rather than contention:

```bash
docker compose stop foundry
node scripts/content/foundry-base.mjs capture <world>
docker compose up -d
```

The same applies to `srd-cache.mjs`, and to `snapshot`/`restore`, which must not
copy a data directory a live server is writing to.

**Never hand-write module ids.** This is not caution for its own sake: of the
eight placeholders the first draft of `foundry-base.json` carried, six were
wrong in ways no amount of care would have caught — Chat Commander is
`_chatcommands` (leading underscore), Prime Performance is `fvtt-perf-optim`,
Dice Tray is `dice-calculator`, and Argon is *two* modules
(`enhancedcombathud` plus `enhancedcombathud-dnd5e`, the second being the half
that makes it work under dnd5e).

Run `capture`, then `promote` the result:

```bash
node scripts/content/foundry-base.mjs capture <world>
node scripts/content/foundry-base.mjs promote foundry-capture-<world>.json
```

`capture` writes what a world actually has; `promote` copies those versions and
manifest URLs into `foundry-base.json`. Deciding what belongs in core stays a
human judgement — copying a version string does not, and hand-copying manifest
URLs is exactly the transcription this pipeline exists to remove.

**Start with `capture`.** Do not hand-write module ids — a wrong one fails at
rebuild time, which is the worst time. `capture` reads the world's
`core.moduleConfiguration`, which is the only complete source: listing
compendium packs shows only modules that ship packs, so every library and
behaviour module (lib-wrapper, socketlib, most quality-of-life modules) is
invisible that way.

Capture reports, rather than decides:

- modules **active in the world but not in core** — promote or ignore, but see
  them first. Dropping `monks-active-tiles` silently breaks every scene built on
  active tiles.
- modules **in core but not enabled** in that world.

**Pins do not float.** "Always latest" is the hazard this exists to prevent —
`docs/PROJECT.md` records foundry-mcp module/server drift needing a deliberate
`MCP_VERSION` bump. `update` resolves the newest version, rewrites the manifest,
and leaves it in the working tree to review and commit. It also warns when
`foundry-mcp-bridge` moves, because that pin and `MCP_VERSION` in
`scripts/setup-mcp.sh` are the same fact.

**Snapshots refuse to write inside the repo.** The data directory contains
`license.json` and the admin key; a snapshot under the repo tree is one
`git add -A` away from committing a licence key.

### Configure one world, capture it, stop reconfiguring

Almost everything you would call "how my Foundry is set up" is **not** in
`Config/options.json`. Which modules are enabled, the dice settings, the HUD
layout, the combat tracker — all of it lives in each world's own LevelDB, under
`worlds/<id>/data/settings`. Create a new world and every bit of it is gone.

So configure one world exactly as you want every future world to start — in the
UI, by hand, where that belongs — and then record it:

```bash
node scripts/content/foundry-base.mjs world-capture <world>
```

That writes `foundry-world-template.json` (gitignored) holding every settings row
worth inheriting, plus the shape of the world's `world.json`. The manifest shape
is **captured, never authored**: Foundry's `world.json` gains and loses fields
between versions, and this repo already paid for guessing at Foundry's own
vocabulary once — six of eight hand-written module ids were wrong.

Four things it deliberately does not carry:

- **Identity settings** — `core.activeScene`, `core.compendiumConfiguration`,
  `core.combatTrackerConfig`, `core.time`. These name documents a new world does
  not have, so cloning them installs a dead reference. Each one is printed as it
  is dropped, so the list is auditable rather than invisible.
- **`core.moduleConfiguration`** — held aside rather than dropped. The enabled
  module set should follow the pins in `foundry-base.json`, not one world's
  history.
- **The world's own id, title and description.**
- **Credentials.** Some modules keep secrets in world settings — ddb-importer
  stores a live D&D Beyond session cookie there. Those rows are dropped and
  their **keys** printed, so you know which logins a new world will ask for
  without the file carrying the answers. Sign in again in the new world.

  They are dropped rather than blanked: an empty credential is
  indistinguishable from a broken one, while an absent credential prompts for
  itself. The match is on the key, by word list rather than by module id, so it
  catches modules this repo has never heard of.

  Three words match **only in compounds**, and every exclusion is here because
  this is a VTT. `token` — Foundry is full of tokens that are creatures on a
  map (`core.defaultToken`, `token-action-hud`, `tokenmagic`). `auth` — a
  substring of "author". And `secret`, which is a tabletop word before it is a
  security one: the first version of this matched
  `dice-so-nice.hide3dDiceOnSecretRolls` and
  `monks-wall-enhancement.toggle-secret` in a real world — secret *rolls* and
  secret *doors*, both plain preferences, both dropped silently.

  That is the rule this list is built on: **when in doubt, do not match.** A
  credential that slips through is visible in the printed key list; a preference
  that gets eaten is not. Over-matching is the same failure a settings whitelist
  would have had — believing you are configured when you are not.

> **The template file is not safe to paste.** It is gitignored and credentials
> are stripped, but it still holds every other setting from a live world. Before
> sharing it — in a terminal, an issue, or a chat with an agent — read the keys
> rather than the file:
>
> ```bash
> node -e "const t=require('./foundry-world-template.json');console.log(t.settings.map(s=>s.key).join('\n'))"
> ```

Everything else is kept, including settings from modules this tool has never
heard of. That is a blacklist rather than a whitelist on purpose: a whitelist
silently drops settings from anything installed after it was written, and the
failure mode is believing you are configured when you are not.

Re-capture whenever you change how you like Foundry set up. It is read-only with
respect to the world — but **stop Foundry first**, like every other command that
opens a world's LevelDB.

### Backup or golden image — pick the right one

`snapshot` and `restore` do two different jobs, and reaching for the wrong one
mid-session is the failure this section exists to prevent. The default path
names the mode so the two cannot be confused on disk.

| | `snapshot` / `restore` | `snapshot --golden` / `restore --golden` |
| --- | --- | --- |
| Contains | everything, **worlds included** | system, modules, config, assets — **no worlds** |
| Default path | `<data>.backup` | `<data>.golden` |
| Reach for it | before a risky change; campaign preservation; before burning the container volumes | resetting a sick instance; starting a clean slate you will import games into |
| On restore | replaces worlds with the snapshot's | **leaves live worlds untouched** |

A golden restore protects worlds by excluding them, which stops `rsync --delete`
removing them — so it resets the instance around whatever worlds are currently
there. That is the point: the campaign you are mid-way through survives a reset
of everything else.

Both modes skip `Data/DnD`. The vault is bind-mounted there inside the data
root; on the host it is an empty mount point, but run either command anywhere
the vault is actually mounted and it would otherwise copy the entire vault into
the snapshot.

`Data/assets` — anything uploaded through Foundry's file picker rather than
resolved from the vault mount — **is** carried by the golden image, on purpose.
It is shared across worlds and small next to the vault, so the cost of keeping
it is a few files belonging to worlds you have deleted, while the cost of
dropping it is missing art in a scene you rebuilt. Orphans are cheaper than
holes. Note the asymmetry: `restore --golden` will *delete* an uploaded file
that the golden snapshot predates, because assets are not on the exclude list
that protects `worlds/`. Re-take the golden snapshot after you upload anything
you want to keep.

> The full-snapshot default used to be `<data>.golden` — if you have one from
> before this change, it is a **full backup** despite the name. Pass it
> explicitly with `--from`, or rename it to `<data>.backup`.

### Checking a rebuild instead of eyeballing one

A rebuild you cannot check is one you will not trust on game night, and the
things worth checking are all things you would otherwise squint at a screen for.

```bash
node scripts/content/foundry-base.mjs verify              # the install
node scripts/content/foundry-base.mjs verify <world>      # the install and one world
```

It **exits non-zero on failure**, so it is a gate rather than a report — put it
straight after `provision` in the drill and again once the world is up.

What it checks:

- **Every pin is installed at its pinned version.** Version comparison is exact,
  deliberately: socketlib's pin is the literal `v1.1.4`, because that is what
  its own `module.json` says. A `verify` that quietly equated `v1.1.4` with
  `1.1.4` would report ok on an install that `provision` reinstalls on every
  single run. The two commands have to mean the same thing by "installed".
- **The pinned set is closed under its own requirements.** `provision` resolves
  no dependency chains, so an unpinned requirement is a module that comes up
  quietly broken. This reads the installed `module.json` files rather than
  fetching manifests, so it needs no network — which matters, because three pins
  are on gitlab.com and the devcontainer's egress allowlist does not cover it.
- **With a world**: that the pinned modules are actually enabled in it, and that
  it runs the pinned system.

Two results are warnings rather than failures, on purpose:

- **A module enabled in the world but not in core.** Routine — a game's own
  content module belongs in its world and has no business in the golden base.
  It is still worth saying out loud, because it is exactly how you find out that
  something you rely on will not come back after a rebuild. If the module is in
  `deliberatelyExcluded`, the line quotes the reason someone wrote down instead
  of repeating the generic warning — answering a recorded decision with a
  generic nag is how a report teaches people to skim it.
- **A world whose `systemVersion` lags the pin.** `world.json` records the
  version the world last *launched* under, so it trails a fresh `provision`
  until you open the world once. Failing on something that fixes itself on
  launch is how a gate gets ignored.

What it does **not** check, so the pass is not read as more than it is: whether
your game content imported, whether art resolved, or whether a map pin opens its
journal. `pull-games` already hard-fails on blank named-NPC tokens via the
strict art gate, and the rest is step 9 of the drill — two surfaces, by eye.

## Foundry-side modules

| Module | Role |
| --- | --- |
| **SoSly Obsidian Bridge** | journals ↔ Obsidian vault, bidirectional |
| **Universal Battlemap Importer** (`dd-import`) | `.dd2vtt` → scenes with walls/lights/doors |
| **ddb-importer** | D&D Beyond characters → Foundry actors |
| **foundry-mcp-bridge** | live-world tooling for Claude Code |
| your **content compendium module(s)** | built from the vault |

## Step zero: the install source expires

`FOUNDRY_RELEASE_URL` in `.env` is a **timed** URL from
[foundryvtt.com/me/licenses](https://foundryvtt.com/me/licenses). It is the
single most likely thing to break a rebuild six months from now, and it fails in
the least helpful way: nothing about a *running* instance touches it, so it can
sit expired for months and only bite at the moment you have already wiped the
data directory. Wiping the data directory is exactly what forces the container
to install Foundry again.

So make refreshing it the first step of the drill rather than a surprise in the
middle of it. Two ways, and they are a real choice:

- **Refresh the timed URL.** Set Operating System to **Node.js** on the licence
  page, click **Timed URL**, paste it into `.env`. Nothing long-lived is stored.
- **Fall back to credentials.** Leave `FOUNDRY_RELEASE_URL` blank and set
  `FOUNDRY_USERNAME` / `FOUNDRY_PASSWORD`; the felddy image logs in and fetches
  the build itself. It does not expire, which is what makes it the better choice
  for a rebuild you might have to run in a hurry — at the price of keeping your
  Foundry account password in `.env`.

Either way, keep `FOUNDRY_VERSION` **pinned** (`.env.example` ships `14.363`).
The image tag `:release` floating is fine — that is the container's own tooling,
not Foundry. Foundry's version is not: a bump migrates world data on first
launch and downgrades are unsupported (see `DEPLOYMENT.md`), so it moves when
you decide it moves, not when a rebuild happens to run.

## Rebuild drill

Run this against the real stack — there is no second instance (see
`docs/PROJECT.md`, "Testing changes against the live stack"). The snapshot is
the undo. Do it **between sessions, not on game night**: Foundry is down while
it runs.

1. Refresh the install source, above. Do this before anything is destroyed.
2. `foundry-base.mjs snapshot` — the full one, worlds included. Confirm it
   exists before wiping anything.
3. Wipe the world, or the data directory.
4. `foundry-base.mjs provision`. It does **not** need Foundry to have started
   first: it creates what it needs under `Data/`, so it runs against a directory
   the container has never come up in. If you keep a golden snapshot,
   `restore --golden --yes` reaches the same place with no downloads at all —
   and is the faster path when what you are fixing is a sick instance rather
   than a version bump. Then `foundry-base.mjs verify` — it
   exits non-zero if a pin is missing, drifted, or has an unpinned requirement,
   which is much cheaper to learn now than at step 9.
5. Launch Foundry and create a world. Its settings start empty — see
   *Configure one world, capture it, stop reconfiguring* above. `world-capture`
   records what that configuration should be; reproducing it in a new world is
   still a manual pass through the UI until `new-world` lands. Then restore the
   game content:
   - `foundry-base.mjs pull-games` rebuilds every game listed in the
     **vault's** `foundry-games.json` (`<vault root>/foundry-games.json`,
     entries `{config, src}` with `$DND_VAULT_PATH/…` expanded from the
     environment, compose default `~/Documents/DnD`) — **check that file
     first**; without it the command restores nothing. The registry lives in
     the vault because the repo is the pipeline and a game's existence is
     content. Alternatively run `scripts/content/ship-game.sh <game-dir>`
     per game (it also restarts Foundry, which `pull-games` does not —
     restart yourself after a pull so the new packs load).
   - Either path runs the **strict art gate** between build and sync and
     hard-fails on a blank named-NPC token — fix art before continuing, do
     not bypass the gate mid-drill.
6. Enable the modules; import compendium packs with **"Keep Document IDs"**
   ticked (see `CONTENT_AUTHORING.md`, *Rules that bite* — without it, scene map
   pins render but open nothing).
7. Re-run **ddb-importer**: its packs are world-scoped and did not survive.
8. Run the SoSly bridge import to bring vault notes back as journals.
9. `foundry-base.mjs verify <world>`, then **check both surfaces** — the
   command covers the pins and the enabled module set, and nothing below it:
   - *Foundry* — scenes carry walls and lights, actors carry real art rather
     than `mystery-man.svg`, and a GM map pin opens its journal page.
   - *In person* — every NPC note still renders a Fantasy Statblocks card with a
     portrait, handouts show their art full-size, and the Player map prints.
10. On success the rebuild **is** the new state. On failure,
    `foundry-base.mjs restore --yes`.

Assets resolve through the `/data/Data/DnD` mount — nothing is copied into the
world.

## Guardrails

- **One writer at a time now spans Foundry.** Do not edit the same journal in
  Foundry and Obsidian (or on two devices) at once — the bridge plus Obsidian
  Sync can clobber. Treat Obsidian as primary; let Foundry edits sync back, then
  stop.
- **A journal is owned by one pipe** — the bridge (prose) **or** the compendium
  build (structured), never both.
- **Keep the mount path stable** (`/data/Data/DnD`). Scene and journal image
  references resolve against it; changing it breaks links on rebuild.
- **One licence, one active server.** There is no parallel test instance to fall
  back on, which is why the snapshot comes first.
