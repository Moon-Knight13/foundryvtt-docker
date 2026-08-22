---
title: AI disclosure
tags: [ttrpg, process, reference, policy]
---

# AI disclosure

What in this prep is generative AI, what is not, and what players get told.
Written against the Discord server rule:

> Usage of AI — Players and DMs can use Gen-AI for imagery as long as both
> parties are made aware of this. DMs, please be explicitly clear on what is
> AI if you are using it.

The rule covers **imagery**. The threshold is met, so the disclosure is a
standing line rather than a per-game judgement call.

## The pin (paste once, per server)

> Some NPC token art in my games is AI-generated — flat-vector portraits drawn
> by Claude from my own written notes on the character, saved into the game's
> assets. Painted battlemaps, if I ever use one, come from a map builder or an
> image generator and I will say which. Everything else is not AI imagery:
> maps are rendered by a script from a layout spec I wrote, and creature art
> is licensed SRD/system art matched by hand.
>
> No AI plays the game. NPCs are voiced and run by me, dice are yours, and
> nothing at the table is decided by a model.

The advert paste block carries a short version of the first paragraph — see
[[Advert Template]]. The pin is where the detail lives.

## What counts

| Thing | Gen-AI imagery? | Why |
| --- | --- | --- |
| Named-NPC token SVGs (`<Game>/Assets/Tokens/*.svg`) | **Yes** | A model wrote the image from a prompt. Vector code rather than diffusion, but the rule is about provenance, not file format. |
| A painted map dropped in from an image generator | **Yes** | Allowed by the pipeline; say so when it happens. |
| `scripts/maps/render_map.py` output | No | Deterministic renderer over a hand-authored JSON spec — every random flourish is seeded from the tile's own coordinates, so the same spec always renders the same map. |
| SRD token art and the curated icon map | No | Licensed system art, matched by hand. The one automated matcher was rejected for pairing *Adult Gold Dragon* with a gold bar. |
| Statblocks, journals, adverts, this note | No | Text. The server rule covers imagery. |

## Things that are not wired up

The `foundry-mcp` bridge ships a `generate-map` tool backed by a local
**ComfyUI** install (with `check-map-status` / `cancel-map-job` alongside it).
It is diffusion image generation and would be squarely in scope — but it does
not work with the bridge as installed here, and nothing in this repo calls it.
If it is ever made to work, a generated map needs the same disclosure a
hand-generated one does, and the row above changes from *if I ever use one*
to a statement of fact.
