# Noir Gala Heist — oneshot design spec (tbc world)

Status: **design locked, not yet implemented.** This spec is the build contract
for a dnd5e oneshot authored as Foundry content-as-code plus live MCP staging.

## Context

A one-page draft oneshot: a **gaslamp-noir heist** on **dnd5e fantasy**. A crime
family's crew works a masquerade gala to swing a civic vote and sow useful chaos
without getting caught. One PC is a secret undercover agent (the **Rat**) who
must complete a dead drop; the climax is a social "identify the Rat" scene. It
runs four light GM tracks (Heat, Voters' Drift, per-PC Suspicion, Evidence) plus
player resources (Heist Tokens, Allegiance Coupon).

Goal: turn that into **table-ready Foundry content** in the live **tbc** world,
using the `foundry-content` skill for authored content and the `foundry-mcp`
server for live staging.

Routing (per CLAUDE.md content-routing table): NPCs, journals, roll tables =
**authored as a compendium module** (versioned, survives world rebuilds, no fat
MCP JSON in context). Scenes = **reuse existing world maps live via MCP**
(`switch-scene`) — the skill does not generate art and tbc already has ~65
MAD Cartographer maps that fit a manor gala and a docks getaway.

## Design decisions (locked)

- **Module architecture — per-oneshot module.** Foundry modules are install-wide
  and enabled per world, so organize by content, not world. New module
  `noir-gala-heist`, enabled only in the tbc world. Existing
  `troubled-waters-content` (the separate harbor oneshot) is left untouched — no
  rename, no re-import.
- **Tone — gaslamp-noir over dnd5e fantasy.** Syndicate not literal mob;
  crossbows/wand-pistols not tommy guns; jazz-lounge = bard; a council seat vote,
  not a US election. Full dnd5e mechanics.
- **Gala events (Scene 3) — all four:** Ballroom Toast, Private Salon (hosts the
  dead drop), Backstage Logistics, Casino/Prize Table.
- **Third named NPC** ("something else") — **Corrupt City Watch Sergeant**, the
  Rat's real handler and a Scene-5 red herring. (Detective + femme fatale set.)
- **Heist Token model — Model A** (result upgrade: Fail→Partial→Success→+bonus).
- **Pre-gens — 5 crew PCs authored as npc-type statblocks** (players run them).
  Rat identity is assigned secretly by the GM at the table, symmetric across all
  five — no "rat tell" on any sheet; the secret lives in the GM guide + a private
  handout.
- **Heat is public; Drift / Evidence / Suspicion are hidden (GM-only).** See
  Tracking.

## World fiction

Gaslamp-noir. City = **Karrowmere** (rainy canal-city; gas lamps, clockwork,
wand-pistols).

- Syndicate = **The Ashgrave Family** (old-money crime dynasty, harbor wards).
- The vote = **Lord-Warden of the Docks**, decided by council at the gala.
- Status-quo candidate = Ashgrave's incumbent; reform candidate = **Councilor Wren**.
- Venue = **The Warden's Masquerade** at a canal-side manor.
- Rat's employer = the **Watch's Internal Bureau**; Sgt. Crell is inside handler.
- Evidence = ledger of bribes hidden in a **dead-drop reliquary** (Private Salon).

## Cast (dnd5e npc statblocks)

| NPC | Role | CR | Mechanical hook |
|---|---|---|---|
| **Don Cassius Ashgrave** | Family patriarch; Scene 1 brief + Scene 5 host/judge | ~5 | Velvet menace, high CHA/Insight; acts on the accusation vote. |
| **Inspector Vandric Thorne** | Gumshoe sniffing the heist | ~3 | Suspicion engine — PCs who slip near him +1 Suspicion; bribe/mislead = Deception vs his Insight. |
| **Lady Seraphine Vale** | Courtesan-spy, secrets broker | ~3 | Drift lever — win her Scene 2 → token/Drift; cross her → Heat. Enchanter. |
| **Sgt. Doran Crell** | Corrupt Watch + secret Bureau handler | ~2 | Scene-5 red herring; the reliquary sits on his Private-Salon patrol. |
| **Gala Guard** | House/Watch mook | ~1/2 | Chaos + combat; Heat consequences spawn them. |

Pre-gen crew (5 npc-type PCs, ~lvl 3; each has a recon-flashback seed + a
plausible-Rat hook):

| Pre-gen | Niche |
|---|---|
| **The Face** | Deception/Persuasion |
| **The Muscle** | Athletics/Intimidation |
| **The Fixer** | Stealth/Thieves' Tools |
| **The Grifter** | Performance/Insight, minor charm |
| **The Runner** | Acrobatics/Perception, escape specialist (shines Scene 4) |

## The four tracks & tracking in Foundry

| Track | Range | Visibility |
|---|---|---|
| Heat | 0–8 | **Public** gauge |
| Voters' Drift | −3…+3 | Hidden (GM) |
| Evidence | 0–3 | Hidden (GM) |
| Suspicion (per PC) | 0–5 each | Hidden (GM) |

- **Heat — PUBLIC, on-screen:** a bare 8-segment gauge titled only **"HEAT"** via
  the **Global Progress Clocks** module (one-time install in the tbc world).
  Players see pressure rising — **no numbers, labels, or threshold text.** What
  each tier does (the Heat ladder) is GM-only knowledge, never on the gauge.
- **Drift / Evidence / Suspicion — HIDDEN:** GM-only **"Live Track Sheet"** page
  in `noir-gm-run-guide.json` — Drift slider, Evidence boxes, one Suspicion row
  per PC. GM edits inline; readable/updatable live via MCP `list-journals` /
  `update-quest-journal`.

### Heat ladder (public gauge → GM-only consequences)

Guards spawn from the `gala-guard` actor as Heat crosses tiers.

| Heat | State | Effect |
|---|---|---|
| 0–1 | Calm | 2 guards roaming; NPCs relaxed |
| 2–3 | Wary | +1 patrol; guards glance over; Thorne starts circling |
| 4–5 | Alert | +2 `gala-guard` tokens; gala-goers defensive → social DCs +1 |
| 6–7 | Lockdown | exits watched; a guard shadows the party; Stealth DCs +2, NPC Perception +1 |
| 8 | RAID | Watch storms in — Scene 4 getaway triggers now / hard mode; combat likely |

The "Cold Trail" bank (Room 3) cancels the next Heat increase before it can push
a tier.

## Scene structure (3-hour target)

### Scene 1 — Briefing (~15 min)
Ashgrave lays out the job (sway the Warden vote to the Family's man, cause useful
chaos, stay clean). Set tracks (Heat 0–1, Drift 0, Suspicion ~0, Evidence 0). GM
privately assigns the Rat (one pre-gen) and hands the private Rat handout.

### Scene 2 — Planning / Recon (~35 min)
Each PC declares a recon "done earlier"; roll the fitting skill **DC 13** →
success = 1 Heist Token + a recorded **advantage phrase**. GM seeds starting
Suspicion via tells. Recon hooks tie to NPCs (charm Seraphine, tail Thorne, drink
a guard for patrol timings, bribe the coat-check).

### Scene 3 — Execution: gala rooms (~95 min; run 3–4)
Party level 3, DC 13–16. Each room ~15–20 min. A Heist Token (Model A) upgrades
one roll if tied to its recon advantage phrase.

- **Room 1 — Ballroom Toast (Drift):** Persuasion/Deception/Performance DC 14.
  Success → Drift +1 Ashgrave. Partial → Drift +1 & Heat +1. Fail → Drift +1
  Reform + speaker Suspicion +1. Nat20 → Drift +2. Nat1 → Heat +2.
- **Room 2 — Private Salon (dead drop / Evidence):** enter past Crell Stealth/
  Deception DC 15. **Dead Drop (Rat only)** SoH/Stealth/Thieves' Tools DC 15 →
  Evidence +1 (Nat20 +2); Partial → no Evidence, pick Heat +1 or nearby-PC
  Suspicion +1; Fail → Heat +1 + Rat Suspicion +1. Non-Rat PCs may distract
  (grant advantage) or snoop (risk Suspicion). **Evidence must reach 3 by end of
  Scene 3** to set the hand-off.
- **Room 3 — Backstage Logistics (bank Heat relief):** Thieves'/Arcana/SoH DC 14.
  Success → bank "Cold Trail" (cancels next Heat increase), Heat +0. Partial →
  Cold Trail + Heat +1 now. Fail → Heat +2, a Guard investigates (possible combat).
- **Room 4 — Casino / Prize Table (frame + rumor):** Deception/Insight/gambling
  contest DC 15. Success → Drift +1 Ashgrave + draw a rival-smear rumor, Heat +0.
  Partial → Drift +1 + framer Suspicion +1. Fail → Heat +1, Drift +1 Reform,
  Thorne tails framer (ongoing +1 Suspicion).

### Scene 4 — Docks Getaway (~30 min)
Escape to the canal docks; Heat sets difficulty. Quiet route (Stealth/Survival,
DC scales with Heat, low Heat gain) vs aggressive (Athletics/combat, more chaos).
The Runner shines. Heat 8 = active raid pursuit.

### Scene 5 — Identify the Rat (~30 min, social climax)
- **Step A — Spotlight:** each PC gives a one-line alibi; GM applies Noir Tells
  (+1 Suspicion each) from the trigger list; one Insight check per accuser may
  publicly expose a tell.
- **Step B — Accusation Vote (forced, secret; whispers/cards):** most votes =
  the Accused. Tie → tied PC with highest Suspicion. Still tied → if Heat ≥ 5,
  boss fingers whoever spent the most Heist Tokens; else random.
- **Step C — Defense Cost:** Accused roleplays + one check (Deception/Persuasion/
  Intimidation) at **DC = 10 + Accused's current Suspicion**; success → Suspicion
  −2, fail → +1. Each ally may spend their one **Allegiance Coupon** to aid
  (DC 13 → Accused Suspicion −1; fail → defender Suspicion +1). The Rat may
  defend but **cannot confess**.
- **Step D — Verdict:** "Rat identified" = Accused is the real Rat AND final
  Suspicion ≥ 4.

  | Evidence = 3 | Rat identified | Ending |
  |---|---|---|
  | Y | Y | Ledger buries Ashgrave; Rat faces the Family. Uneasy crew win. |
  | Y | N | Rat escapes with ledger; Ashgrave doomed later; crew played. |
  | N | Y | Crew sold out the Bureau's agent. Dark; Ashgrave survives. |
  | N | N | Status quo holds; Rat's mission failed. |

- **Epilogue overlay — Drift decides the Warden vote:** final Drift ≥ +2 →
  Ashgrave's man wins; ≤ −2 → Councilor Wren wins; middle → contested recount.

## Player resources (handout wording)

- **Heist Token:** earned Scene 2 (successful recon), tied to an advantage phrase;
  spend Scene 3 to upgrade one roll (Model A) only if connected to that phrase —
  no free wins.
- **Allegiance Coupon:** one per player, Scene 5 only; spend to defend an accused
  ally (Step C).

## Content deliverables — `content/src-noir/`

Copy templates from the `foundry-content` skill; never hand-write document
schema. Existing sources (`content/src/actors/harbormaster-vela.json`,
`journals/harbor-district-primer.json`, `tables/harbor-rumors.json`) are the
working reference shapes. One document per file; filename = kebab-case name.

### actors/ (dnd5e npc template)
NPCs: `don-cassius-ashgrave.json`, `inspector-vandric-thorne.json`,
`lady-seraphine-vale.json`, `sgt-doran-crell.json`, `gala-guard.json`.

Pre-gens (npc-type, players run as PCs; ~level-3 equivalent; each with a recon
seed + plausible-Rat hook): `pregen-the-face.json`, `pregen-the-muscle.json`,
`pregen-the-fixer.json`, `pregen-the-grifter.json`, `pregen-the-runner.json`.

### journals/ (GM-only pages use `"ownership": { "default": 0 }`)
- `noir-player-handout.json` (player-visible): Premise, Your Crew's Job, Heist
  Tokens, Allegiance Coupon, scene overview — **no Rat identity, no track internals.**
- `noir-gm-run-guide.json` (GM-only): the Four Tracks + Live Track Sheet, the Heat
  ladder, The Rat (secret assignment + private handout + dead-drop rules), Noir
  Tells trigger list, Scene 5 verdict matrix, 3-hour timing, Map/Scene cheatsheet.
- `noir-scene-playbook.json` (GM-only): Scenes 1–5 full text, the four gala-event
  blocks with exact outcomes, the Dead Drop substep, Scene 5 Steps A–D.
- `noir-cast.json` (GM-only): one page per NPC, each `@UUID`-linked to its actor
  in `noir-gala-heist.actors` (exact strings via
  `node scripts/content/uuid.mjs actors/<file>.json`).

### tables/ (Foundry v13 result shape: `"type": "text"`, `"description"`)
- `noir-complications.json` (1d8) — loud-failure consequences; each stamps Heat/Suspicion.
- `noir-suspicion-tells.json` (1d6) — a noir tell to pin +1 Suspicion on a PC.
- `noir-gala-overheard.json` (1d6) — ambient rumor + Drift hook (used by Room 4).

### scenes/ — NONE authored
Reuse existing tbc maps live via MCP. Recommended mapping (documented in the GM
guide):
- **Gala (Scenes 1–3, 5):** `31. Guildhall (Night)` (ballroom) + `51. Iron
  Mansion` (private salon / backstage).
- **Docks getaway (Scene 4):** `20. Dockside Tavern`, `24. Warehouse - Large`, or
  `53. Pirate Ship`.
Stage during play with MCP `switch-scene` / token tools.

## Tooling change — make the repo multi-module (backward compatible)

`scripts/content/build.mjs` and `scripts/content/sync-content.sh` currently key
off the single default `content/content.config.json`. Add an optional
`--config <path>` so one repo builds N oneshot modules; existing default
behaviour unchanged.

- `build.mjs`: `main()` parses `--config <path>` (default `DEFAULT_CONFIG_PATH`);
  read an optional `"srcDir"` field from the config and pass
  `srcRoot = content/<srcDir>` (default `content/src`) into the already-exported
  `buildModule({ srcRoot, configPath })`. `distRoot` stays `content/dist` (each
  module in its own `dist/<id>/` subdir).
- `sync-content.sh`: accept `--config <path>` (default unchanged); it already
  derives `MODULE_ID` from the config via `sed`.
- Tests: extend `scripts/content/build.test.mjs` for the `srcDir`/config path;
  run `cd scripts/content && node --test`. Do not bump `TOOLING_VERSION` or touch
  plugin scaffold semantics beyond this additive flag.

New config `content/noir-gala-heist.config.json`:
```json
{
  "id": "noir-gala-heist",
  "title": "Noir Gala Heist",
  "system": "dnd5e",
  "srcDir": "src-noir",
  "version": "1.0.0",
  "packLabelPrefix": "Noir Gala Heist",
  "compatibility": { "minimum": "12", "verified": "13" },
  "ownership": { "PLAYER": "OBSERVER", "ASSISTANT": "OWNER" }
}
```

## Build → sync → import → stage

1. Author the files above from templates; fill only needed fields.
2. **Build:** `node scripts/content/build.mjs --config content/noir-gala-heist.config.json`
   (exits 0 + prints counts; fails loudly on invalid fields or broken `@UUID`).
3. **Review:** run the `foundry-content-reviewer` agent over `content/src-noir/`
   (leftover REPLACE markers, GM-only ownership, v13 table shape, cross-links).
4. **Sync (USER, on host):**
   `scripts/content/sync-content.sh --config content/noir-gala-heist.config.json`
5. **Import (USER, in Foundry, tbc world):** Manage Modules → enable **Noir Gala
   Heist** → Compendium Packs → import actors, journals, tables. Also install +
   enable **Global Progress Clocks** for the public Heat gauge.
6. **Stage live (MCP):** `switch-scene` to the gala map; drop NPC/guard tokens
   from the imported compendium as the session runs.

## Verification

- **Build:** step 2 exits 0; deliberately break a `@UUID` once to confirm the
  build rejects it, then fix.
- **Tooling tests:** `cd scripts/content && node --test` green (includes the new
  `--config`/`srcDir` case).
- **Content review:** `foundry-content-reviewer` returns no blocking findings.
- **Post-import (read-only MCP):** `list-compendium-packs` shows
  `noir-gala-heist.actors/journals/tables`; `search-compendium` / `list-journals`
  find the docs; spot-check a GM-only page is not player-visible.
- **End-to-end:** MCP `switch-scene` to the chosen gala map activates it; place
  one NPC token to confirm the compendium actor is usable in the live world.

## Out of scope / follow-ups

- No new map art (reusing existing maps).
- Migrating/renaming `troubled-waters-content` — not needed under per-oneshot modules.
- Full leveled dnd5e *character*-type sheets for pre-gens (using npc statblocks
  to stay template-safe); can upgrade later.
- Deeper content not yet drafted (tracked for the build): concrete NPC statblock
  numbers, pre-gen builds, the Rat private handout text, the Scene-2 recon menu,
  actual roll-table entries, and the Noir Tells trigger list.
