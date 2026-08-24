# The pregen pool is a folder of PDFs

Design for issue #115, second pass. Supersedes the levelling design of the same
date, which was deleted along with the approach it described.

## Context

A pregen is a player character a game hands to whoever turns up. It has to work
on two surfaces: printed and handed across a table, and imported into Foundry as
a character actor. Half of these sessions are in person, so the printed surface
is not a nicety.

The first pass tried to *derive* a pregen — hold the character as an authored
YAML fence, compute everything the class tables decide, and print and pack the
result. That works at level 1 and falls apart above it, for a reason worth
recording: above about level 4 the equipment and loadout stop being
rules-derivable, and the number of player choices a level-5 character has made
is larger than any schema wants to hold.

Five official D&D Beyond exports were then added to the vault at
`01 Systems/dnd5e/Pregens/`, level 1, 2024 rules: Dwarf Cleric (Acolyte), Elf
Wizard (Sage), Goliath Barbarian (Soldier), Halfling Rogue (Criminal), Human
Fighter (Soldier). They are the root truth. Nothing in this repo regenerates
them.

That changes the problem from "compute a character" to "read one", which is a
much smaller problem and a much more reliable one.

## What was measured before deciding

### The PDFs already hold every level-1 choice

Each is a 775-field AcroForm, `PDFsharp 6.1.1`, the D&D Beyond export layout —
not the 334-field WotC blank. Read with `sheet-fields.mjs --filled`, the Human
Fighter alone carries:

- the Fighting Style taken (`Defense`) and the origin feat (`Lucky`), both as
  named entries under `=== FEATS ===`
- weapon mastery choices, inferable from the weapon rows: `Graze` on the
  Greatsword, `Vex` on the Shortbow
- equipment with quantities and weights, carried weight, encumbrance thresholds
- coins, languages, tool proficiencies, armour and weapon proficiencies
- species traits and class features with PHB-2024 page references

The Cleric carries its full spell list with school, range, components, duration,
save DC and page reference per spell.

So level 1 never needs deriving. It needs reading.

### Open5e is not a safe rules source

Audited against the 2024 rules, `srd-2024` has defects that would land on these
five characters:

| Defect | Effect |
| --- | --- |
| `srd-2024_fighter.saving_throws = ['dex','str']` | should be `str`/`con`; wrong at every level, hits the Human Fighter |
| `srd-2024_monk.saving_throws = ['dex','wis']` | should be `str`/`dex` |
| rogue Ability Score Improvement has no level-10 row | and the feature's own prose is wrong too, so there is nothing in-document to repair from |
| `srd-2024_bard_bard-subclass` has zero level rows | a bard never gains a subclass |
| monk Deflect Attacks missing; Stunning Strike rows at both 3 and 5 | |
| `SpeciesTrait` has no level field at all | Goliath Large Form at character level 5 and Elf lineage spells at 3 and 5 exist only as prose |

Root cause on the two save bugs: `saving_throws` was populated from the class's
*primary* abilities. The same document contradicts itself — the fighter's
`core-traits` description reads `|Saving Throw Proficiencies|Strength and
Constitution|`.

Two more traps that make hand-modelling rules attractive and wrong:

- 2024 **Alert** grants your *proficiency bonus* to initiative, not a flat +2.
  The Halfling Rogue prints +4 only because proficiency is +2 at level 1.
- The Dwarf Cleric's +2 Arcana and Religion is **Divine Order (Thaumaturge)**,
  whose bonus equals the Wisdom modifier, minimum +1. It prints +2 because that
  cleric has Wisdom 15.

Both would have been encoded as constants and both would silently desync at
level 5.

### Foundry cannot be asked to do the levelling

The live world (`Lure of the Lamia`, Foundry 14.364, dnd5e 5.3.3) ships the 2024
SRD as compendium packs — `dnd5e.classes24`, `origins24`, `feats24`, `spells24`,
`equipment24` — with stable ids. It is a better rules engine than open5e is a
dataset. It still cannot be used to level a pregen at build time:

- `build.mjs` packs through `compilePack`, which writes raw documents into
  LevelDB. No document lifecycle hook runs, so no advancement is applied.
- dnd5e also early-returns from its `_preCreate` backfill for compendium-sourced
  actors, so dragging the packed actor into a world does not repair it either.
- The advancement definitions are not readable from the build environment.
  Foundry is not in this container, and MCP strips `system.advancement` from
  both `get-compendium-entry-full` and `get-compendium-item`.

What a finished dnd5e character looks like is still worth copying. `Akra
(Dragonborn Cleric)` in `dnd5e.heroes` carries 47 owned Items — class, subclass,
race, background, 5 feats, 18 spells, 2 weapons, 4 equipment, 3 containers, 6
loot, 5 consumables — each granted feature a copy of a compendium Item stamped
with `flags.dnd5e.sourceId` and `advancementOrigin`. The current pipeline emits
two Items.

## Decisions

### 1. The pool is PDFs, one per character per level

`01 Systems/dnd5e/Pregens/` holds `<character>_lv<N>.pdf`. They are built in
D&D Beyond by hand and copied in. Nothing in this repo writes one.

A character at two levels is two files, not one file plus a ladder.
`dwarf_cleric_lv1.pdf` and `dwarf_cleric_lv4.pdf` are independent truths, and
neither is derived from the other.

### 2. There is no levelling code

The build never computes a level-up. A game that needs a level the pool does not
hold stops and says what to go make:

```text
Dwarf Cleric at level 4 is not in the pool.
Build it in D&D Beyond, export the PDF, and copy it to
  01 Systems/dnd5e/Pregens/dwarf_cleric_lv4.pdf
Pool holds: dwarf_cleric_lv1, elf_wizard_lv1, goliath_barbarian_lv1,
            halfling_rogue_lv1, human_fighter_lv1
```

This is the shape issue #136 argues for: a pipeline that directs rather than a
checklist that fails. `validateParty` already errors on a level mismatch, so
this is a better message rather than a new mechanism.

### 3. The note becomes a generated index of its PDF

The pool note stops being authored truth. It is regenerated from the PDF, and it
pins that PDF by SHA-256 so an edited note or a re-exported sheet cannot silently
produce a character matching neither. Same guard `sheet-templates.json` already
puts on the blank sheet.

The note is kept rather than dropped because the pool has to be readable in
Obsidian, and because `readPool`, the party draw and hook attachment all key off
notes today. Removing it means rewriting three working things for no gain.

Filenames must carry the level — `noteName()` is `${spec.name}.md` today, so one
character at two levels collides. The game's `party:` list stays level-free and
the resolver selects on the game's declared `level:`.

### 4. Pregens ride in the game's actor pack

Already true and unchanged. `compile-game.mjs` writes
`<game>/Foundry/src/actors/pregen-<slug>.json` beside the NPC actors, and
`build.mjs` packs the directory into one `actors` pack. One import gives a game
its monsters and its party.

The `pregen-` prefix stays: it keeps player characters out of the Dataview NPC
roster and out of the monster namespace in the compendium.

### 5. The actor carries what the sheet carries

`specFromSheet` extracts twelve fields and drops everything else. It has to read
the rest: equipment, weapons with their mastery properties, feats, spells,
languages, tools, proficiencies, coins, species traits.

Mapping sheet text to compendium Items is a curated table, not a fuzzy match —
the sheet says `Chain Mail`, Foundry wants `phbarmChainMail0` in
`dnd5e.equipment24`. Unmapped names are reported, never guessed. This follows the
art map, which rejected fuzzy matching for the same reason.

Because `compilePack` skips `_preCreate`, every derived field must be written by
the pipeline. Anything expected to be "automatic" in dnd5e is not, for packed
content.

### 6. Game flavour is annotated onto a copy

The pool PDF is never modified. A game's copy gets its hooks written into the
roleplay boxes the DDB form leaves empty: `Backstory`, `AdditionalNotes1`,
`AdditionalNotes2`, `AlliesOrganizations`, `PersonalityTraits`, `Ideals`,
`Bonds`, `Flaws` — all present on the form and all empty on the five exports.

Hooks keep their existing contract: they key off background, never off a
character, and a game stripped of every hook is still playable.

`CONTENT_AUTHORING.md` currently claims hooks reach the sheet's backstory box.
They do not — `sheetValues` never writes it. The doc describes an intention, not
shipped behaviour, and is wrong today.

### 7. Open5e is demoted to a checker

It stays as the source for `progression-{2014,2024}.json`, and those tables are
used to derive the arithmetic a sheet prints so the two can be compared. A
disagreement fails the build. That is what `compareToSheet` already does against
these PDFs.

It is no longer allowed to decide anything. Its six known defects are recorded
above rather than patched, because nothing now depends on them being right —
except the checks, which the sheet arbitrates.

## Risk to test before anything depends on it

Annotating a copy should avoid the print defects entirely, because it writes two
boxes rather than regenerating 334. But `pdf-lib`'s `form.updateFieldAppearances()`
regenerates every field's appearance, and that is the mechanism behind the 66-point
text measured on the first pass: the form's default appearance is `/Helv 0 Tf`
(auto-size), no field carries its own `/DA`, and short strings are scaled to fill
their box.

If that call touches D&D Beyond's 770 filled boxes it corrupts a working sheet.
This is testable in isolation and must be tested before the annotation path is
built.

## Modules

| Module | Change |
| --- | --- |
| `pool-from-sheets.mjs` | read every category the export fills, not twelve fields; per-level note names; pin the source PDF by checksum |
| `pregen.mjs` | emit the Items the sheet describes, not a bare actor with a class Item |
| `pregen-party.mjs` | select a pool entry by the game's declared level; direct the author to D&D Beyond when it is missing |
| `sheet-write.mjs` | annotate a copy of the pool PDF instead of printing onto a blank |
| `sheet-fields.mjs` | unchanged |
| `pregen-cache.mjs` | unchanged; record the open5e defects rather than repair them |
| new: item mapping table | sheet text to `dnd5e.*24` compendium ids, curated, unmapped names reported |

## Testing

The oracle is the PDF. Every pool entry is derived and compared against the sheet
it was read from, and a mismatch is refused rather than written — the existing
`compareToSheet` contract, now covering the categories added in decision 5.

The five exports in the vault are the fixtures. Vault-gated tests self-skip, so
CI without the vault silently drops the highest-value tests and still reports
green; that is a known hole, not a new one.

## Out of scope

- Levelling a character in code. Decision 2.
- Regenerating or modifying a pool PDF. Decision 1.
- Printing onto the WotC blank. Decision 6 replaces it.
- Multiclassing.
- Making open5e correct.
