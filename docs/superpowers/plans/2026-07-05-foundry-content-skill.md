# Foundry Content Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Content-as-code pipeline — author dnd5e NPCs/items/journals/scenes as JSON in the repo, compile to a Foundry compendium module with the official CLI, sync to host data dir with a script — replacing foundry-mcp for offline bulk authoring.

**Architecture:** One JSON file per document under `content/src/<type>/`. `scripts/content/build.mjs` validates, injects deterministic `_id`/`_key`, and compiles LevelDB packs plus `module.json` into `content/dist/troubled-waters-content/`. A host-run `sync-content.sh` rsyncs the built module into `$FOUNDRY_DATA_PATH/Data/modules/`. A project skill (`.claude/skills/foundry-content/`) teaches the copy-template-edit-fields workflow.

**Tech Stack:** Node 24 (ESM, `node:test`), `@foundryvtt/foundryvtt-cli` (compilePack/extractPack), bash + rsync.

## Global Constraints

- Do NOT touch the repo root `package.json` — it belongs to the container launcher. Content tooling deps live only in `scripts/content/package.json`.
- Module id is exactly `troubled-waters-content`; system `dnd5e`; `compatibility.verified: "13"`.
- `content/dist/` is gitignored; `content/src/` and templates are committed.
- Foundry document `_id` must match `/^[a-zA-Z0-9]{16}$/`; `_key` format is `!<collection>!<id>` with collections: actors, items, journal, scenes.
- `sync-content.sh` runs on the HOST, never inside the devcontainer; it must not read `.env`.
- Commits: conventional commits, sign-off style used by repo (`git commit -m "type: subject"`), append `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Content tooling scaffold

**Files:**
- Create: `scripts/content/package.json`
- Create: `content/src/.gitkeep` (plus `actors/`, `items/`, `journals/`, `scenes/` subdirs each with `.gitkeep`)
- Modify: `.gitignore` (append `content/dist/` and `scripts/content/node_modules/`)

**Interfaces:**
- Produces: `scripts/content/package.json` with dependency `@foundryvtt/foundryvtt-cli` and `"type": "module"`; later tasks run `npm --prefix scripts/content install` output.

- [ ] **Step 1: Create `scripts/content/package.json`**

```json
{
  "name": "foundry-content-tools",
  "private": true,
  "type": "module",
  "description": "Build tooling for the troubled-waters-content compendium module.",
  "scripts": {
    "build": "node build.mjs",
    "test": "node --test"
  },
  "dependencies": {
    "@foundryvtt/foundryvtt-cli": "^1.0.3"
  }
}
```

- [ ] **Step 2: Create source dirs**

```bash
mkdir -p content/src/actors content/src/items content/src/journals content/src/scenes
touch content/src/actors/.gitkeep content/src/items/.gitkeep content/src/journals/.gitkeep content/src/scenes/.gitkeep
```

- [ ] **Step 3: Append to `.gitignore`**

```
# Foundry content module build output
content/dist/
scripts/content/node_modules/
```

- [ ] **Step 4: Install dep and verify import**

Run: `npm --prefix scripts/content install`
Then: `node -e "import('@foundryvtt/foundryvtt-cli').then(m => console.log(typeof m.compilePack, typeof m.extractPack))" --experimental-vm-modules` from `scripts/content` (or `cd scripts/content && node -e "..."`).
Expected: `function function`

- [ ] **Step 5: Commit**

```bash
git add scripts/content/package.json scripts/content/package-lock.json content/src .gitignore
git commit -m "feat(content): scaffold content-as-code tooling"
```

---

### Task 2: build.mjs — validation + deterministic IDs (pure functions, TDD)

**Files:**
- Create: `scripts/content/build.mjs`
- Test: `scripts/content/build.test.mjs`

**Interfaces:**
- Produces (exported from `build.mjs`):
  - `docId(relPath: string): string` — 16-char lowercase-hex id from sha256 of the relative path.
  - `validateDoc(doc: object, type: 'actors'|'items'|'journals'|'scenes', file: string): string[]` — returns array of error strings (empty = valid).
  - `prepareDoc(doc: object, type, relPath: string): object` — returns copy with `_id`, `_key` injected; journal pages and embedded actor items get `_id`s derived from `docId(relPath + '#' + index)`.
  - `moduleManifest(): object` — the `module.json` content.
  - `COLLECTIONS` — `{ actors: {key: 'actors', type: 'Actor'}, items: {key: 'items', type: 'Item'}, journals: {key: 'journal', type: 'JournalEntry'}, scenes: {key: 'scenes', type: 'Scene'} }`.
  - `main()` — full build (Task 3).

- [ ] **Step 1: Write failing tests**

`scripts/content/build.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docId, validateDoc, prepareDoc, moduleManifest, COLLECTIONS } from './build.mjs';

test('docId is deterministic, 16 chars, alnum', () => {
  const a = docId('actors/grimtooth.json');
  assert.equal(a, docId('actors/grimtooth.json'));
  assert.match(a, /^[a-z0-9]{16}$/);
  assert.notEqual(a, docId('actors/other.json'));
});

test('validateDoc flags missing required fields', () => {
  assert.deepEqual(validateDoc({ name: 'X', type: 'npc' }, 'actors', 'f.json'), []);
  assert.ok(validateDoc({ type: 'npc' }, 'actors', 'f.json').some(e => e.includes('name')));
  assert.ok(validateDoc({ name: 'X' }, 'actors', 'f.json').some(e => e.includes('type')));
  assert.ok(validateDoc({ name: 'Q' }, 'journals', 'f.json').some(e => e.includes('pages')));
  assert.deepEqual(validateDoc({ name: 'Q', pages: [] }, 'journals', 'f.json'), []);
  assert.deepEqual(validateDoc({ name: 'S' }, 'scenes', 'f.json'), []);
});

test('prepareDoc injects _id and _key', () => {
  const out = prepareDoc({ name: 'X', type: 'npc' }, 'actors', 'actors/x.json');
  assert.match(out._id, /^[a-z0-9]{16}$/);
  assert.equal(out._key, `!actors!${out._id}`);
});

test('prepareDoc gives journal pages stable embedded ids', () => {
  const doc = { name: 'Q', pages: [{ name: 'P1', type: 'text' }] };
  const out = prepareDoc(doc, 'journals', 'journals/q.json');
  assert.equal(out._key, `!journal!${out._id}`);
  assert.match(out.pages[0]._id, /^[a-z0-9]{16}$/);
  const again = prepareDoc(doc, 'journals', 'journals/q.json');
  assert.equal(out.pages[0]._id, again.pages[0]._id);
});

test('moduleManifest shape', () => {
  const m = moduleManifest();
  assert.equal(m.id, 'troubled-waters-content');
  assert.equal(m.packs.length, 4);
  assert.ok(m.packs.every(p => p.system === 'dnd5e'));
  assert.deepEqual(m.relationships.systems[0].id, 'dnd5e');
});

test('COLLECTIONS maps journal collection correctly', () => {
  assert.equal(COLLECTIONS.journals.key, 'journal');
  assert.equal(COLLECTIONS.journals.type, 'JournalEntry');
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd scripts/content && node --test`
Expected: FAIL — `build.mjs` not found / exports missing.

- [ ] **Step 3: Implement pure functions in `build.mjs`**

```js
#!/usr/bin/env node
/**
 * Build the troubled-waters-content compendium module from content/src.
 * Usage: node scripts/content/build.mjs
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePack } from '@foundryvtt/foundryvtt-cli';

export const MODULE_ID = 'troubled-waters-content';

export const COLLECTIONS = {
  actors:   { key: 'actors',  type: 'Actor' },
  items:    { key: 'items',   type: 'Item' },
  journals: { key: 'journal', type: 'JournalEntry' },
  scenes:   { key: 'scenes',  type: 'Scene' },
};

const REQUIRED_FIELDS = {
  actors:   ['name', 'type'],
  items:    ['name', 'type'],
  journals: ['name', 'pages'],
  scenes:   ['name'],
};

export function docId(relPath) {
  return createHash('sha256').update(relPath).digest('hex').slice(0, 16);
}

export function validateDoc(doc, type, file) {
  const errors = [];
  for (const field of REQUIRED_FIELDS[type]) {
    if (doc[field] === undefined || doc[field] === null) {
      errors.push(`${file}: missing required field "${field}"`);
    }
  }
  return errors;
}

export function prepareDoc(doc, type, relPath) {
  const out = structuredClone(doc);
  out._id = docId(relPath);
  out._key = `!${COLLECTIONS[type].key}!${out._id}`;
  const embedded = type === 'journals' ? out.pages : type === 'actors' ? out.items : null;
  if (Array.isArray(embedded)) {
    embedded.forEach((child, i) => {
      child._id ??= docId(`${relPath}#${i}`);
    });
  }
  return out;
}

export function moduleManifest() {
  const packs = Object.entries(COLLECTIONS).map(([src, c]) => ({
    name: src,
    label: `Troubled Waters ${c.type}s`,
    path: `packs/${src}`,
    type: c.type,
    system: 'dnd5e',
    ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' },
  }));
  return {
    id: MODULE_ID,
    title: 'Troubled Waters Content',
    description: 'Campaign content authored as code in the project repository.',
    version: '1.0.0',
    compatibility: { minimum: '12', verified: '13' },
    packs,
    relationships: { systems: [{ id: 'dnd5e', type: 'system', compatibility: {} }] },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd scripts/content && node --test`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/content/build.mjs scripts/content/build.test.mjs
git commit -m "feat(content): build helpers with deterministic pack ids"
```

---

### Task 3: build.mjs — main() compile pipeline + round-trip test

**Files:**
- Modify: `scripts/content/build.mjs` (append `main()`)
- Test: `scripts/content/roundtrip.test.mjs`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: `main({ srcRoot, distRoot }): Promise<{counts: Record<string, number>}>` — builds `distRoot/troubled-waters-content/` with `module.json` + `packs/<name>` LevelDB dirs. CLI entry: `node build.mjs` uses defaults `content/src` / `content/dist` resolved from repo root (two dirs up from the script).

- [ ] **Step 1: Write failing round-trip test**

`scripts/content/roundtrip.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { main, MODULE_ID } from './build.mjs';

test('build compiles packs that round-trip via extractPack', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'fvtt-content-'));
  const srcRoot = path.join(work, 'src');
  const distRoot = path.join(work, 'dist');
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'journals', 'quest.json'),
    JSON.stringify({
      name: 'The Sunken Bell',
      pages: [{ name: 'Hook', type: 'text', title: { show: true, level: 1 }, text: { content: '<p>Bell tolls beneath the harbor.</p>', format: 1 }, sort: 0 }],
    })
  );

  const { counts } = await main({ srcRoot, distRoot });
  assert.equal(counts.journals, 1);

  const moduleDir = path.join(distRoot, MODULE_ID);
  const manifest = JSON.parse(await readFile(path.join(moduleDir, 'module.json'), 'utf8'));
  assert.equal(manifest.id, MODULE_ID);

  const outDir = path.join(work, 'unpacked');
  await extractPack(path.join(moduleDir, 'packs', 'journals'), outDir, { log: false });
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const doc = JSON.parse(await readFile(path.join(outDir, files[0]), 'utf8'));
  assert.equal(doc.name, 'The Sunken Bell');
  assert.match(doc._id, /^[a-z0-9]{16}$/);
});

test('build fails loudly on invalid source', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'fvtt-content-bad-'));
  const srcRoot = path.join(work, 'src');
  await mkdir(path.join(srcRoot, 'actors'), { recursive: true });
  await writeFile(path.join(srcRoot, 'actors', 'broken.json'), JSON.stringify({ type: 'npc' }));
  await assert.rejects(() => main({ srcRoot, distRoot: path.join(work, 'dist') }), /missing required field "name"/);
});
```

- [ ] **Step 2: Run tests, verify the two new tests fail**

Run: `cd scripts/content && node --test`
Expected: Task 2 tests pass; round-trip tests FAIL (`main` not exported).

- [ ] **Step 3: Append `main()` to `build.mjs`**

```js
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export async function main({
  srcRoot = path.join(REPO_ROOT, 'content', 'src'),
  distRoot = path.join(REPO_ROOT, 'content', 'dist'),
} = {}) {
  const moduleDir = path.join(distRoot, MODULE_ID);
  await rm(moduleDir, { recursive: true, force: true });

  const errors = [];
  const staged = {}; // type -> staging dir
  const counts = {};

  for (const type of Object.keys(COLLECTIONS)) {
    const typeDir = path.join(srcRoot, type);
    counts[type] = 0;
    if (!existsSync(typeDir)) continue;
    const files = (await readdir(typeDir)).filter(f => f.endsWith('.json'));
    if (files.length === 0) continue;

    const stageDir = path.join(distRoot, '.stage', type);
    await mkdir(stageDir, { recursive: true });
    staged[type] = stageDir;

    for (const file of files) {
      const relPath = `${type}/${file}`;
      let doc;
      try {
        doc = JSON.parse(await readFile(path.join(typeDir, file), 'utf8'));
      } catch (err) {
        errors.push(`${relPath}: malformed JSON (${err.message})`);
        continue;
      }
      const docErrors = validateDoc(doc, type, relPath);
      if (docErrors.length) {
        errors.push(...docErrors);
        continue;
      }
      const prepared = prepareDoc(doc, type, relPath);
      await writeFile(path.join(stageDir, file), JSON.stringify(prepared, null, 2));
      counts[type] += 1;
    }
  }

  if (errors.length) {
    await rm(path.join(distRoot, '.stage'), { recursive: true, force: true });
    throw new Error(`Build failed:\n${errors.join('\n')}`);
  }

  for (const [type, stageDir] of Object.entries(staged)) {
    const packDir = path.join(moduleDir, 'packs', type);
    await mkdir(packDir, { recursive: true });
    await compilePack(stageDir, packDir, { log: false });
  }
  await rm(path.join(distRoot, '.stage'), { recursive: true, force: true });

  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, 'module.json'), JSON.stringify(moduleManifest(), null, 2));
  return { counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(({ counts }) => {
      console.log(`Built ${MODULE_ID}:`, counts);
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd scripts/content && node --test`
Expected: all tests PASS (8 total).

- [ ] **Step 5: Commit**

```bash
git add scripts/content/build.mjs scripts/content/roundtrip.test.mjs
git commit -m "feat(content): compile source JSON into compendium module"
```

---

### Task 4: sync-content.sh (host-run)

**Files:**
- Create: `scripts/content/sync-content.sh` (chmod +x)

**Interfaces:**
- Consumes: `content/dist/troubled-waters-content/` from Task 3.
- Produces: host command `scripts/content/sync-content.sh [--test] [--dry-run] [--data <path>]`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Sync the built content module into a Foundry data directory.
# Run this on the HOST, not inside the devcontainer.
#
# Usage: scripts/content/sync-content.sh [--test] [--dry-run] [--data <path>]
#   --test     sync to $FOUNDRY_TEST_DATA_PATH instead of $FOUNDRY_DATA_PATH
#   --data     explicit data directory (overrides env vars)
#   --dry-run  show what rsync would do
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODULE_DIR="$REPO_ROOT/content/dist/troubled-waters-content"

DATA_PATH="${FOUNDRY_DATA_PATH:-$HOME/.local/share/FoundryVTT}"
DRY_RUN=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)
      DATA_PATH="${FOUNDRY_TEST_DATA_PATH:?--test requires FOUNDRY_TEST_DATA_PATH to be set}"
      shift ;;
    --data)
      DATA_PATH="${2:?--data requires a path}"; shift 2 ;;
    --dry-run)
      DRY_RUN=(--dry-run -v); shift ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$MODULE_DIR/module.json" ]]; then
  echo "Error: $MODULE_DIR is missing or not built. Run: node scripts/content/build.mjs" >&2
  exit 1
fi

MODULES_DIR="$DATA_PATH/Data/modules"
if [[ ! -d "$MODULES_DIR" ]]; then
  echo "Error: $MODULES_DIR does not exist — is $DATA_PATH a Foundry data dir?" >&2
  exit 1
fi

rsync -a --delete "${DRY_RUN[@]}" "$MODULE_DIR/" "$MODULES_DIR/troubled-waters-content/"
echo "Synced troubled-waters-content -> $MODULES_DIR"
```

- [ ] **Step 2: Test failure modes in devcontainer**

Run:
```bash
chmod +x scripts/content/sync-content.sh
scripts/content/sync-content.sh --data /nonexistent; echo "exit=$?"
```
Expected: error about missing/unbuilt `content/dist/...` OR missing modules dir; `exit=1`.

Run happy-path dry run against a fake data dir:
```bash
mkdir -p /tmp/fake-data/Data/modules content/dist/troubled-waters-content
echo '{}' > content/dist/troubled-waters-content/module.json
scripts/content/sync-content.sh --data /tmp/fake-data --dry-run
```
Expected: rsync dry-run listing, then `Synced troubled-waters-content -> /tmp/fake-data/Data/modules`. Clean up: `rm -rf /tmp/fake-data content/dist`.

- [ ] **Step 3: Commit**

```bash
git add scripts/content/sync-content.sh
git commit -m "feat(content): host sync script for content module"
```

---

### Task 5: Templates

**Files:**
- Create: `.claude/skills/foundry-content/templates/npc.json`
- Create: `.claude/skills/foundry-content/templates/item.json`
- Create: `.claude/skills/foundry-content/templates/journal.json`
- Create: `.claude/skills/foundry-content/templates/scene.json`

**Interfaces:**
- Produces: skeletons the skill instructs Claude to copy into `content/src/<type>/`. Foundry's data model fills unspecified dnd5e fields with defaults on import, so templates stay minimal.

- [ ] **Step 1: `templates/npc.json`**

```json
{
  "name": "REPLACE Name",
  "type": "npc",
  "img": "icons/svg/mystery-man.svg",
  "system": {
    "abilities": {
      "str": { "value": 10 },
      "dex": { "value": 10 },
      "con": { "value": 10 },
      "int": { "value": 10 },
      "wis": { "value": 10 },
      "cha": { "value": 10 }
    },
    "attributes": {
      "hp": { "value": 10, "max": 10 },
      "ac": { "flat": 12, "calc": "flat" },
      "movement": { "walk": 30, "units": "ft" }
    },
    "details": {
      "cr": 1,
      "type": { "value": "humanoid" },
      "alignment": "Neutral",
      "biography": { "value": "<p>REPLACE biography and roleplay notes.</p>" }
    },
    "traits": { "size": "med", "languages": { "value": ["common"] } }
  },
  "items": [],
  "prototypeToken": {
    "name": "REPLACE Name",
    "displayName": 20,
    "disposition": 0,
    "actorLink": false
  }
}
```

- [ ] **Step 2: `templates/item.json`**

```json
{
  "name": "REPLACE Item Name",
  "type": "loot",
  "img": "icons/svg/item-bag.svg",
  "system": {
    "description": { "value": "<p>REPLACE description.</p>" },
    "quantity": 1,
    "weight": { "value": 0, "units": "lb" },
    "price": { "value": 0, "denomination": "gp" },
    "rarity": "common",
    "identified": true
  }
}
```

- [ ] **Step 3: `templates/journal.json`**

```json
{
  "name": "REPLACE Journal Title",
  "pages": [
    {
      "name": "REPLACE Page Title",
      "type": "text",
      "title": { "show": true, "level": 1 },
      "text": { "content": "<p>REPLACE content. Link documents like @UUID[Compendium.troubled-waters-content.actors.Actor.REPLACE_ID]{Display Name}.</p>", "format": 1 },
      "sort": 0
    }
  ]
}
```

- [ ] **Step 4: `templates/scene.json`**

```json
{
  "name": "REPLACE Scene Name",
  "background": { "src": "REPLACE/path/under/data, e.g. worlds/my-world/maps/harbor.webp" },
  "width": 4000,
  "height": 3000,
  "padding": 0.25,
  "grid": { "type": 1, "size": 100, "distance": 5, "units": "ft" },
  "tokenVision": true,
  "fog": { "exploration": true },
  "tokens": [],
  "walls": [],
  "lights": [],
  "notes": []
}
```

- [ ] **Step 5: Validate templates build**

```bash
mkdir -p content/src/actors content/src/items content/src/journals content/src/scenes
cp .claude/skills/foundry-content/templates/npc.json content/src/actors/_template_check.json
cp .claude/skills/foundry-content/templates/item.json content/src/items/_template_check.json
cp .claude/skills/foundry-content/templates/journal.json content/src/journals/_template_check.json
cp .claude/skills/foundry-content/templates/scene.json content/src/scenes/_template_check.json
node scripts/content/build.mjs
```
Expected: `Built troubled-waters-content: { actors: 1, items: 1, journals: 1, scenes: 1 }`
Clean up: `rm content/src/*/_template_check.json && rm -rf content/dist`

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/foundry-content/templates
git commit -m "feat(content): dnd5e document templates for content authoring"
```

---

### Task 6: SKILL.md

**Files:**
- Create: `.claude/skills/foundry-content/SKILL.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: foundry-content
description: Author FoundryVTT campaign content (dnd5e NPCs, items, quest journals, scenes) as JSON in the repo and compile it into the troubled-waters-content compendium module. Use for bulk or offline content creation — "create NPCs", "write quest journals", "bulk content", "add items/loot", "prep encounter content". Do NOT use for live-play operations (dice requests, token movement, scene activation, conditions) — those need the foundry-mcp server.
---

# Foundry Content Authoring (content-as-code)

Compile campaign content from `content/src/` into a Foundry compendium module.
Token-cheap replacement for foundry-mcp content tools: copy a template, edit
fields, build, hand off one host command.

## Workflow

1. **Copy a template — never write document JSON from scratch.**
   Templates: `.claude/skills/foundry-content/templates/{npc,item,journal,scene}.json`
   Destination: `content/src/{actors,items,journals,scenes}/<kebab-name>.json`
   Edit only the fields you need; `REPLACE` markers show the minimum. Unknown
   dnd5e fields are defaulted by Foundry on import — do not invent schema.
2. **Build:** `node scripts/content/build.mjs`
   Compiles to `content/dist/troubled-waters-content/`. Fails with file+field
   on invalid sources. Run `cd scripts/content && npm install` once if
   node_modules is missing.
3. **Sync (USER runs on HOST, not in devcontainer):**
   `scripts/content/sync-content.sh --test` — test instance first
   `scripts/content/sync-content.sh` — production data dir
   Tell the user to run this; you cannot.
4. **Import (user, in Foundry UI):** enable "Troubled Waters Content" module in
   the world, open Compendium Packs, import documents. Pack-content changes
   need a world reload; module.json changes need a Foundry restart.

## Rules

- One document per file. Filename = kebab-case document name (`grimtooth-the-fence.json`).
  IDs are derived from the path — renaming a file changes its compendium ID and
  a re-import creates a duplicate.
- Cross-links in journal text:
  `@UUID[Compendium.troubled-waters-content.actors.Actor.<id16>]{Name}` —
  get `<id16>` from build output or `docId()` (sha256 of `actors/<file>.json`,
  first 16 hex chars).
- Scenes: `background.src` must point at an image that already exists under the
  Foundry data dir (e.g. `worlds/<world>/maps/*.webp`). This skill does not
  generate or upload images.
- Tests: `cd scripts/content && node --test` after changing build.mjs.
- Never touch the repo root package.json; content deps live in scripts/content/package.json.

## When NOT to use this skill

Live session work — rolling dice, moving/updating tokens, toggling conditions,
switching scenes, checking current game state. Use the foundry-mcp tools.
Editing documents already imported into a world — compendium re-import
overwrites the compendium copy only; world copies must be updated in the UI or
via foundry-mcp.
```

- [ ] **Step 2: Verify skill discovery**

Run: `ls .claude/skills/foundry-content/`
Expected: `SKILL.md  templates`
(New skills load on next session start; note this for the user.)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/foundry-content/SKILL.md
git commit -m "feat(content): foundry-content authoring skill"
```

---

### Task 7: End-to-end verify + sample content

**Files:**
- Create: `content/src/journals/skill-smoke-test.json` (temporary — deleted before commit)

**Interfaces:**
- Consumes: full pipeline.

- [ ] **Step 1: Full pipeline dry run**

```bash
cp .claude/skills/foundry-content/templates/journal.json content/src/journals/skill-smoke-test.json
node scripts/content/build.mjs
ls content/dist/troubled-waters-content/packs/journals
mkdir -p /tmp/fake-data/Data/modules
scripts/content/sync-content.sh --data /tmp/fake-data
ls /tmp/fake-data/Data/modules/troubled-waters-content
```
Expected: build count `journals: 1`; LevelDB files (`*.ldb`/`MANIFEST-*`/`CURRENT`) in the pack dir; sync copies module with `module.json` + `packs/`.

- [ ] **Step 2: Clean up**

```bash
rm content/src/journals/skill-smoke-test.json
rm -rf content/dist /tmp/fake-data
cd scripts/content && node --test
```
Expected: all tests pass.

- [ ] **Step 3: Final commit (leftovers, if any) and report**

```bash
git status --short
```
Expected: clean except intentionally-untracked dirs. Report to user: skill built; real import verification needs host sync + Foundry UI check on the test instance.
