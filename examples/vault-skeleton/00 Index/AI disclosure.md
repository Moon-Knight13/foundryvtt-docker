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

It goes further than the rule requires, and deliberately. The prep writing is
Claude-assisted; that is outside the rule and disclosing it is optional. But a
disclosure that answers only the compulsory question invites the reader to
wonder what else was not mentioned — and the writing is the thing a player is
most likely to guess at anyway. Volunteering it is what makes the rest of the
statement worth believing.

## The pin (paste once, per server)

> **AI in my games — the short version.** A few NPC portrait tokens are
> AI-drawn. Nothing else is, no AI runs the game, and if you would rather not
> have it at your table, say so and you get plain tokens instead. No hard
> feelings, no questions asked.
>
> **What is AI.** Some named NPCs have a portrait token that was drawn by
> Claude from my own written notes on that character — the same description I
> wrote for myself about what people notice first when they meet them. The
> output is flat vector art, a few kilobytes of shapes: a coloured rim, a bust,
> the one or two details that matter. It is deliberately simple and is not
> pretending to be a painting.
>
> **It is not an image generator sampling other people's paintings.** No
> diffusion model is involved, nothing is traced or copied, and I never prompt
> for another artist's name or style. What comes out is drawn from my prose, not
> assembled out of anyone's portfolio.
>
> **It has not taken work from an artist.** These tokens only appear where the
> alternative was a blank grey placeholder — the choice was portrait or nothing,
> never portrait or commission. Where art already exists I use that first:
> creature art from the system's own licensed set, and icons from game-icons.net
> under CC-BY-3.0, with a file in the assets folder naming every artist and the
> licence. If I ever commission or buy art, that is what goes in.
>
> **The maps are not AI.** They are rendered by a script from a layout I wrote
> square by square — the same input always produces the same map. If I ever use
> a painted map that came out of an image generator, I will say so for that map.
>
> **The writing is Claude-assisted, and I would rather you heard it from me.**
> The server rule covers imagery, so this part is volunteered. I use Claude the
> way I would use a very fast editor: I outline the scene, the NPC, the handout;
> it drafts; I cut, rewrite and keep what is mine. Statblocks get built and
> balanced that way, journals and props get their first pass that way, and so did
> the recruitment post you answered. Nothing reaches you that I have not read and
> signed off on, and the adventures are my own or published one-shots I paid for
> and adapted — not a plot a model invented while I watched.
>
> **Nothing at the table is AI.** NPCs are voiced and played by me, improvisation
> is mine, dice are yours, and no model decides what happens to your character.
>
> Ask me anything about this — including which tokens, and I will show you.

The advert paste block carries a shorter version — see [[Advert Template]]. The
pin is where the detail lives.

### Why it is written this way

The objection players actually raise is not *"was a model involved"*, it is
*"was someone robbed, and is a machine going to run my game"*. A disclosure that
only answers the first question reads as a technicality. So the pin answers the
real ones — training, displaced artists, and the table itself — in that order,
and ends with an offer rather than a defence. The opt-out is genuine and cheap:
swapping a token back to system art is one line in a note.

Do not soften it into something unfalsifiable. Every claim above is one a player
could check if they asked: the tokens are in the game's `Assets/Tokens/`, the
attribution file is beside the icons, and the map spec is a JSON file I can show
them.

## What counts

| Thing | Gen-AI imagery? | Why |
| --- | --- | --- |
| Named-NPC token SVGs (`<Game>/Assets/Tokens/*.svg`) | **Yes** | A model wrote the image from a prompt. Vector code rather than diffusion, but the rule is about provenance, not file format. |
| A painted map dropped in from an image generator | **Yes** | Allowed by the pipeline; say so when it happens. |
| `scripts/maps/render_map.py` output | No | Deterministic renderer over a hand-authored JSON spec — every random flourish is seeded from the tile's own coordinates, so the same spec always renders the same map. |
| SRD token art and the curated icon map | No | Licensed system art, matched by hand. The one automated matcher was rejected for pairing *Adult Gold Dragon* with a gold bar. |
| Statblocks, journals, adverts, this note | Not *imagery* — but AI-assisted | The server rule covers imagery only, so none of this needs declaring. It is declared anyway: drafted with Claude from my outline, edited and approved by me. Saying "not AI" here would be false, and a player who worked that out on their own would be right to distrust the rest. |

## Things that are not wired up

The `foundry-mcp` bridge ships a `generate-map` tool backed by a local
**ComfyUI** install (with `check-map-status` / `cancel-map-job` alongside it).
It is diffusion image generation and would be squarely in scope — but it does
not work with the bridge as installed here, and nothing in this repo calls it.
If it is ever made to work, a generated map needs the same disclosure a
hand-generated one does, and the row above changes from *if I ever use one*
to a statement of fact.

It is also not the way to get AI art onto a map even if it did run: it returns
a picture and an empty wall list. Generated art belongs in the game's
`Assets/Maps/`, keyed by a `background` spec so the walls and lights stay ours
— see `scripts/maps/README.md`.
