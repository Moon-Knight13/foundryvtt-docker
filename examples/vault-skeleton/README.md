# Obsidian Starter Vault (skeleton)

A ready-to-copy **Obsidian vault skeleton** for tabletop RPG prep — the same
system-agnostic "cards → artifacts" structure this repo pairs with FoundryVTT,
with all personal campaign content stripped out. It ships the folder tree,
reusable Templater/Dataview templates, and generic guide notes so you can stand
up your own GM vault in seconds.

## What's inside

```text
00 Index/       4 guide notes: Home, How this vault works, Notes to the table, Running a new game
01 Systems/     rules refs & PDFs (cairn, dnd5e)
02 Campaigns/   ongoing games — one folder each
03 Oneshots/    self-contained games — one folder each
04 Bestiary/    reusable creature statblocks
05 Templates/   12 card templates (NPC, Location, Faction, Item, Quest, Session,
                Handout, Encounter, Roll Table, Map Brief, New Game Brief, Plugins Setup)
06 Assets/      handouts / maps / tokens (also Foundry's file picker)
99 Inbox/       quick capture
```

Empty folders carry a `.gitkeep` so the tree survives in git; those are safe to
delete once you drop real notes in.

## Use it

Copy the skeleton to wherever you keep your vault, then open that folder as a
vault in Obsidian:

```bash
cp -r examples/vault-skeleton "$DND_VAULT_PATH"
```

(Set `DND_VAULT_PATH` to your own vault location, or just give `cp` any target
path you like.) Then **Obsidian → Open folder as vault** → point it at the copy.

## Enable these Obsidian community plugins

Turn off Restricted Mode (Settings → Community plugins), then install and enable:

- **Templater** — scaffolds cards and auto-fills `<% tp.* %>` fields. Set
  **Template folder = `05 Templates`** and **trigger on new file creation = ON**
  (see `05 Templates/_Plugins Setup.md`).
- **Dataview** — powers the auto-index tables in `Home` and per-game indexes.
- **Fantasy Statblocks** — renders the ```` ```statblock ```` blocks in NPC
  cards as printable stat cards.
- **Initiative Tracker** — combat tracker that reads Fantasy Statblocks creatures.
- **Leaflet** — interactive image maps with pins and measuring.
- **Buttons** — one-click "new card" buttons wired to Templater.

Full per-plugin settings live in **`05 Templates/_Plugins Setup.md`**.

## Note on links

A fresh vault has **dangling `[[wikilinks]]`** — the guide notes and templates
link to cards you haven't created yet (NPCs, locations, campaigns). That's
expected; Obsidian tolerates unresolved links and they light up as you add
notes. Start from **`00 Index/Home.md`** and follow **`Running a new game`** to
build your first game.
