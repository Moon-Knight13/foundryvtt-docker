---
type: handout
system: agnostic
artifact: [in-person, foundry]
foundry_pack: journals
player_visible: true
created: <% tp.date.now("YYYY-MM-DD") %>
tags: [ttrpg, handout]
---

# <% tp.file.title %>

> Player-facing. Nothing secret here. Print it for the table, or show it in
> Foundry.

REPLACE — the in-fiction text, letter, notice, map key, or player brief.

## Art

Drop the image in this game's `Assets/Art/` and embed it below. The text after
`|` becomes the caption:

![[REPLACE.webp|REPLACE — a one-line caption]]

`scripts/content/handout.mjs` turns each embed into a Foundry **image page** in
a journal named `<this note> — Art`, which the GM can right-click →
**Show to Players**, and which players can reopen afterwards. One file serves
both surfaces: Obsidian renders the embed for the printed/tablet handout, and
Foundry resolves the same file through the vault mount.

Only the images are compiled. The prose above belongs to the SoSly Obsidian
Bridge — a journal is owned by one pipe, never both — which is also why the art
journal carries the ` — Art` suffix rather than colliding with the bridge's copy.

Set `player_visible: false` in the frontmatter for GM-only art; the pages are
then GM-only too.
