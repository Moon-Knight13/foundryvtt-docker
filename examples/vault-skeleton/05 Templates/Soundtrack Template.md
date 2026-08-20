---
type: soundtrack
system: REPLACE
artifact: [online, in-person]
tags: [REPLACE, audio]
---

# REPLACE — Soundtrack

Ambience plays **outside Foundry** — through Discord when you are online, and in
the room when you are not. Foundry serves no audio, so nothing here is streamed
to your players over the same connection carrying the game, and the same cue
sheet works at a physical table where Foundry is not running at all.

`new-game.sh` writes this file for you. This template is for games that predate
it, or for anything scaffolded by hand.

## Cue sheet (auto)

Point the `FROM` at this game's own `Scenes/` folder:

```dataview
TABLE WITHOUT ID
  file.link AS Scene,
  audio_source AS Source,
  audio_ref AS Play,
  audio_cue AS "Bring it in when"
FROM "03 Oneshots/REPLACE/Scenes"
SORT scene, act, file.name
```

## Adding a cue

The cue lives on the scene note, not in a list here, so it cannot drift from the
scene it belongs to. Add three keys to that note's frontmatter:

```yaml
audio_source: tabletopaudio   # tabletopaudio | spotify | local | none
audio_ref: https://tabletopaudio.com/...   # or a filename under 06 Assets/Audio/
audio_cue: as the boat leaves the jetty
```

A scene with no cue shows blank in the table above — that is a to-do, not an
error. Write `audio_source: none` when silence is deliberate, so you can tell the
two apart at a glance.

## What plays it

Whatever you already use — a Discord music bot, Spotify shared into voice, or a
local player. The sheet gives you the link, not a command to paste: bot syntax
changes, and a cue sheet printing the wrong command is worse than one printing a
link.

Local clips live in `06 Assets/Audio/`, shared across games the way
`06 Assets/Tokens/` is.

> [!warning] Do not build Foundry playlists from these
> The vault is mounted inside Foundry's data root, so Foundry **can** see files
> in `06 Assets/Audio/`. Resist it. Every file in a Foundry playlist is streamed
> by your server to every connected client, and it does nothing for the sessions
> you run in person.
