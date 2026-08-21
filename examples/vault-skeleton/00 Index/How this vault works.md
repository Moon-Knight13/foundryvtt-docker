---
title: How this vault works
tags: [ttrpg, moc, reference]
---

# How this vault works

This vault is the **system-agnostic backbone** for tabletop prep. The same notes
serve **in-person**, **online**, and **FoundryVTT-hybrid** play, synced across
your devices with Obsidian Sync (host-side).

## Cards → artifacts

Every prep note is a **card** with typed frontmatter (`type`, `system`,
`artifact`). A card can emit up to two **artifacts**:

- **In-person artifact** — the card itself, rendered/printed: a Fantasy
  Statblocks stat card, a Dataview index, a player handout.
- **Foundry artifact** — the same prep compiled into FoundryVTT compendium JSON.

`artifact: [in-person, foundry]` in the frontmatter says which outputs a card
supports. A mood note is `in-person` only; a statted NPC is `both`.

| Card `type` | In-person | Foundry (`<Game>/Foundry/src/…`) |
|---|---|---|
| npc / creature | Fantasy Statblocks card | `actors/*.json` |
| location | note + Leaflet map | `scenes/*.json` |
| faction | note | `journals/*.json` |
| item | note | `items/*.json` |
| quest | printable handout | `journals/*.json` |
| table | note | `tables/*.json` |
| handout | printable md/PDF | journal page |

## Foundry pipeline

The vault holds the content; the repo (git-versioned) is only the pipeline that
compiles it. Every game gets its **own** module, and every command names it:

1. Hand Claude a card. Claude authors versioned JSON beside the game's notes, in
   `<Game>/Foundry/src/<type>/<name>.json`, from the `foundry-content` skill templates.
2. `node scripts/content/build.mjs --config <Game>/Foundry/<slug>.config.json --src <Game>/Foundry/src`
   → `content/dist/<module>/`. There is no default module — a build with no
   `--config` refuses to guess.
3. On the host: `scripts/content/sync-content.sh --config <same config>` → Foundry `Data/modules/`.
4. Enable the module + import packs in Foundry. Vault images/handouts already
   appear in Foundry's file picker via the shared vault mount.
5. During play, MCP stages it live (scenes, tokens, dice).

Foundry itself is rebuildable on the same principle: the repo pins the system and
module set in `foundry-base.json`, so a wiped install comes back with one command
and is checked with another. See
[[Notes to the table#Rebuild Foundry from scratch (drilled, not theoretical)]].

## Recommended plugins

Templater (scaffold + auto-file cards), Dataview (auto-indexes), Fantasy
Statblocks (creature cards + the NPC→Foundry interchange), Initiative Tracker
(combat), Leaflet (maps), Buttons (trigger templates).

## Fresh device setup

Getting a new device (laptop, tablet, phone) onto this vault:

1. **Get the vault.** Install Obsidian → sign in to **Obsidian Sync** → connect
   this remote vault. Let the **first sync finish** before touching anything.
2. **Allow plugins.** Settings → **Community plugins** → turn **off Restricted
   Mode**.
3. **Get the plugins.**
   - *If Sync carries them* (recommended — see below): they install
     automatically after a sync. Just **enable** each if they arrive disabled.
   - *Otherwise install manually:* Templater, Dataview, Fantasy Statblocks,
     Initiative Tracker, Leaflet, Buttons.
4. **Set Templater** (the only config that isn't automatic): Settings →
   Templater → **Template folder = `05 Templates`**, **trigger on new file
   creation = ON**, and optionally the **Folder Templates** table. Full
   per-plugin settings: **[[_Plugins Setup]]**.
5. **Verify.** Open **[[Home]]** — the Dataview tables should populate. Open an
   NPC card — the Fantasy Statblocks block should render.

> [!tip] Make future devices one-step
> In **Obsidian Sync settings**, enable syncing of **Installed community
> plugins** and **Community plugin settings**. Then plugins *and* their config
> (including the Templater folder above) travel with the vault — new devices just
> sign in and sync.

## Source of truth & sync
- **Obsidian is the source of truth.** Sync is host-side across your devices.
- **One writer at a time** — don't edit the same note on two devices (or in
  Foundry via the shared vault mount) at once; last write wins on sync.

Back to [[Home]].
