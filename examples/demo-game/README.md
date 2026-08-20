# Demo game — Ashwake Hollow

**Ashwake Hollow is invented.** Nobody has run it, nobody will, and it exists for
exactly two reasons:

1. **Documentation needs a name.** Every example in `docs/CONTENT_AUTHORING.md`
   points at a module, an actor and a source path. Those used to be a real
   campaign's, which quietly made one game the implicit subject of the whole
   pipeline. Now they point here.
2. **The pipeline needs a smoke test.** These three documents are the smallest
   set that exercises the interesting paths: an **actor**, a **journal that
   cross-links to it by `@UUID`** (so link validation has something to validate),
   and a **roll table**.

This directory is *sources only* — no vault notes, no `NPCs/*.md` statblock
fences, no art. A real game keeps all of that beside its Obsidian notes; see
`docs/PROJECT.md`, "This repo is the pipeline, not the content".

## Build it

There is no default module and no default source tree, so name both:

```bash
node scripts/content/build.mjs \
  --config examples/demo-game/ashwake-hollow.config.json \
  --src    examples/demo-game/src
```

That compiles `content/dist/ashwake-hollow-oneshot/` (gitignored). If the
`@UUID` in `src/journals/hollow-primer.json` ever stops matching
`docId('actors/rook-vantle.json')`, the build fails — which is the point.

Get the current link string for any source file with:

```bash
node scripts/content/uuid.mjs \
  --config examples/demo-game/ashwake-hollow.config.json \
  actors/rook-vantle.json "Rook Vantle"
```

## Do not sync this to a live Foundry

`sync-content.sh` would happily install `ashwake-hollow-oneshot` into your data
directory. There is no reason to: it is three documents about a toll-gate that
does not exist.

## Where the real games live

In the vault, one folder each, notes and `Foundry/` sources together:

```text
<vault>/03 Oneshots/<Game>/
├── <Game>.md  Advert.md  GM Prep.md
├── NPCs/  Scenes/  Handouts/  Tables/  Maps/
├── Assets/{Maps,Tokens,Art}/
└── Foundry/<slug>.config.json + maps/ + src/{actors,items,journals,scenes,tables}/
```

`scripts/content/new-game.sh <slug>` scaffolds that whole shape. A blank starter
vault with the same taxonomy — and no game content at all — ships at
[`examples/vault-skeleton/`](../vault-skeleton/).
