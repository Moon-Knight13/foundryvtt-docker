---
type: soundtrack
system: REPLACE
artifact: [online, in-person]
tags: [REPLACE, audio]
audio_bot: flavibot
audio_command: "/play {ref}"
soundtrack_playlist: REPLACE
---

# REPLACE — Soundtrack

Ambience plays **outside Foundry** — through Discord when you are online, and in
the room when you are not. Foundry serves no audio, so nothing here is streamed
to your players over the same connection carrying the game, and the same cue
sheet works at a physical table where Foundry is not running at all.

`new-game.sh` writes this file for you. This template is for games that predate
it, or for anything scaffolded by hand.

## Session start

Paste this once, when the bot joins:

`=replace(this.audio_command, "{ref}", this.soundtrack_playlist)`

After that, most scene changes are the skip button on the bot's control panel.

## Cue sheet (auto)

Point the `FROM` at this game's own `Scenes/` folder:

```dataview
TABLE WITHOUT ID
  file.link AS Scene,
  audio_cue AS "Bring it in when",
  audio_source AS Source,
  replace(this.audio_command, "{ref}", default(audio_ref, this.soundtrack_playlist)) AS Paste
FROM "03 Oneshots/REPLACE/Scenes"
SORT scene, act, file.name
```

## Adding a cue

The cue lives on the scene note, not in a list here, so it cannot drift from the
scene it belongs to. Add three keys to that note's frontmatter:

```yaml
audio_source: tabletopaudio   # tabletopaudio | spotify | local | none
audio_ref: https://tabletopaudio.com/...   # or a saved-playlist name, or a
                                           # filename under 06 Assets/Audio/
audio_cue: as the boat leaves the jetty
```

A scene with no cue shows blank in the table above — that is a to-do, not an
error. Write `audio_source: none` when silence is deliberate, so you can tell the
two apart at a glance.

**`audio_ref` is optional.** Leave it off and the scene falls back to
`soundtrack_playlist` above — right for a game you run start to finish, where
one ordered playlist plus the skip button is the whole interface. Set it per
scene when the game jumps around and "next" means nothing.

## What plays it

The bot is named once, in this file's frontmatter, and the sheet builds each
paste-ready command from it. That is a deliberate change of mind: this sheet
used to print a link and never a command, on the grounds that bot syntax drifts
and a wrong command is worse than a link. Keeping the syntax in **one** place per
game answers that — switching bots is a one-line edit here, not a sweep through
every scene note — and printing the command removes the step you skip when you
are mid-sentence and the party has already walked into the next room.

Local clips live in `06 Assets/Audio/`, shared across games the way
`06 Assets/Tokens/` is.

## Not remembering it at all

`compile-game.mjs` copies each scene's cue onto the Foundry scene it belongs
to, and the **Cue reminder** macro in this game's compendium whispers it to you
every time a scene loads. Run that macro once at the start of an online session
and the reminder arrives on its own. It does nothing at an in-person table —
that is what this sheet is for.

> [!warning] Do not build Foundry playlists from these
> The vault is mounted inside Foundry's data root, so Foundry **can** see files
> in `06 Assets/Audio/`. Resist it. Every file in a Foundry playlist is streamed
> by your server to every connected client, and it does nothing for the sessions
> you run in person.
