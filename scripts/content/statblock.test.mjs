import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  abilityMod,
  profBonus,
  parseCR,
  skillProficiency,
  parseFence,
  parseFrontmatter,
  parseDisposition,
  parseSource,
  parseSpeed,
  parseSenses,
  parseLanguages,
  biographyHtml,
  toActor,
  verify,
  parseArgs,
  compileNote,
  open5eFor,
  SKILL_KEYS,
  PLACEHOLDER_IMG,
} from './statblock.mjs';

// A named NPC built on the SRD Lamia, in the shape a vault note actually uses:
// base creature stats, a display name that differs from the note title.
const LAMIA_NPC = {
  name: 'Vashti (Lamia)',
  size: 'Large',
  type: 'monstrosity',
  alignment: 'Chaotic Evil',
  ac: 13,
  hp: 97,
  hit_dice: '13d10 + 26',
  speed: '30 ft.',
  stats: [16, 13, 15, 14, 15, 16],
  skillsaves: [{ deception: 7 }, { insight: 4 }, { stealth: 3 }],
  senses: 'darkvision 60 ft., passive Perception 12',
  languages: 'Abyssal, Common',
  cr: 4,
  traits: [{ name: 'Innate Spellcasting', desc: 'DC 13.' }],
  actions: [{ name: 'Claws', desc: '+5 to hit.' }],
  source: 'SRD 5.1 (CC-BY-4.0) — Lamia',
};

test('abilityMod and profBonus follow the SRD tables', () => {
  assert.equal(abilityMod(16), 3);
  assert.equal(abilityMod(11), 0);
  assert.equal(abilityMod(8), -1);
  assert.equal(profBonus(0), 2);
  assert.equal(profBonus(4), 2);
  assert.equal(profBonus(5), 3);
  assert.equal(profBonus(8), 3);
  assert.equal(profBonus(9), 4);
  assert.equal(profBonus(17), 6);
});

test('skillProficiency distinguishes proficiency from expertise', () => {
  // The bug this exists to prevent: Deception +7 on a CHA 16 (+3) creature at
  // CR 4 (PB 2) is EXPERTISE. Storing multiplier 1 renders +5 at the table.
  assert.deepEqual(skillProficiency(7, 3, 2), { value: 2, flat: 0 });
  assert.deepEqual(skillProficiency(5, 3, 2), { value: 1, flat: 0 });
  assert.deepEqual(skillProficiency(3, 3, 2), { value: 0, flat: 0 });
});

test('skillProficiency carries an unreachable bonus flat, and says so', () => {
  const r = skillProficiency(8, 3, 2); // needs +5 from a PB of 2 — not a multiple
  assert.equal(r.value, 2);
  assert.equal(r.flat, 1);
  assert.match(r.note, /not reachable/);
});

test('parseFence pulls the statblock block out of a note', () => {
  const note = `---\ntype: npc\n---\n\n# Vashti\n\n\`\`\`statblock\nname: Vashti\nac: 13\n\`\`\`\n\n## Links\n`;
  assert.deepEqual(parseFence(note), { name: 'Vashti', ac: 13 });
  assert.equal(parseFence('# no fence here'), null);
});

test('parseSource reads the edition and the base creature', () => {
  assert.deepEqual(parseSource('SRD 5.1 (CC-BY-4.0) — Lamia'), { edition: '5.1', base: 'Lamia' });
  assert.deepEqual(parseSource('SRD 5.2 (CC-BY-4.0) — Giant Scorpion'), {
    edition: '5.2',
    base: 'Giant Scorpion',
  });
  assert.deepEqual(parseSource(undefined), {});
});

test('parseCR handles the fractions stat blocks actually use', () => {
  // Bandit's fence reads "cr: 1/8"; YAML hands that back as a string, and
  // Number("1/8") is NaN — which silently produced a null CR.
  assert.equal(parseCR('1/8'), 0.125);
  assert.equal(parseCR('1/4'), 0.25);
  assert.equal(parseCR('1/2'), 0.5);
  assert.equal(parseCR(4), 4);
  assert.equal(parseCR('4'), 4);
  assert.equal(parseCR('nonsense'), 0);
  assert.equal(profBonus('1/8'), 2, 'fractional CR still yields a sane PB');
});

test('parseSpeed and parseSenses normalise prose to fields', () => {
  assert.deepEqual(parseSpeed('30 ft.'), { units: 'ft', walk: 30 });
  assert.deepEqual(parseSpeed('30 ft., fly 60 ft.'), { units: 'ft', walk: 30, fly: 60 });
  // Passive Perception is derived by the system, not stored.
  assert.deepEqual(parseSenses('darkvision 60 ft., passive Perception 12'), {
    darkvision: 60,
    units: 'ft',
  });
  // No special senses means no senses object at all, not a bare units marker.
  assert.deepEqual(parseSenses('passive Perception 12'), {});
});

test('parseLanguages separates real language keys from prose', () => {
  assert.deepEqual(parseLanguages('Abyssal, Common'), { value: ['abyssal', 'common'], custom: '' });
  // "any two languages" is not a language. Writing it into `value` invents a
  // key Foundry cannot resolve, and the entry renders blank at the table.
  assert.deepEqual(parseLanguages('any two languages'), { value: [], custom: 'any two languages' });
  assert.deepEqual(parseLanguages('Common, any one other language'), {
    value: ['common'],
    custom: 'any one other language',
  });
  assert.deepEqual(parseLanguages("Common, Thieves' Cant"), {
    value: ['common', 'cant'],
    custom: '',
  });
  assert.deepEqual(parseLanguages('—'), { value: [], custom: '' });
});

test('parseFrontmatter and parseDisposition carry note-level facts', () => {
  const note = '---\ntype: npc\ndisposition: neutral\n---\n\n# Sable\n';
  assert.equal(parseFrontmatter(note).disposition, 'neutral');
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {});
  // An NPC built on the SRD Spy may start the session as an ally — a note fact,
  // not a stat-block fact, so it cannot come from the shared SRD line.
  assert.equal(parseDisposition('neutral'), 0);
  assert.equal(parseDisposition('friendly'), 1);
  assert.equal(parseDisposition('hostile'), -1);
  assert.equal(parseDisposition(0), 0);
  assert.equal(parseDisposition(undefined), -1, 'NPCs default to hostile');
  assert.equal(parseDisposition('gibberish'), -1);
});

test('SKILL_KEYS keeps the three confusable skills apart', () => {
  assert.equal(SKILL_KEYS.perception, 'prc');
  assert.equal(SKILL_KEYS.persuasion, 'per');
  assert.equal(SKILL_KEYS.performance, 'prf');
});

test('toActor produces the dnd5e npc shape the build already consumes', () => {
  const { actor } = toActor(LAMIA_NPC, { name: 'Vashti' });
  // Actor name is the note title; the fence name is the card's display name.
  assert.equal(actor.name, 'Vashti');
  assert.equal(actor.type, 'npc');
  assert.deepEqual(actor.system.abilities.cha, { value: 16 });
  assert.deepEqual(actor.system.attributes.ac, { calc: 'flat', flat: 13 });
  assert.equal(actor.system.attributes.hp.max, 97);
  assert.equal(actor.system.attributes.hp.value, 97);
  assert.equal(actor.system.attributes.hp.formula, '13d10 + 26');
  assert.equal(actor.system.traits.size, 'lg');
  assert.equal(actor.system.details.cr, 4);
  assert.equal(actor.prototypeToken.disposition, -1);
  assert.equal(actor.prototypeToken.actorLink, false);
});

test('toActor derives expertise rather than trusting a flat multiplier', () => {
  const { actor, warnings } = toActor(LAMIA_NPC, { name: 'Vashti' });
  assert.deepEqual(actor.system.skills.dec, { value: 2 }, 'Deception +7 is expertise');
  assert.deepEqual(actor.system.skills.ins, { value: 1 });
  assert.deepEqual(actor.system.skills.ste, { value: 1 });
  // No SKILL warnings: all three bonuses are cleanly reachable. The art warning
  // is expected here and checked separately.
  assert.deepEqual(
    warnings.filter(w => w.startsWith('skill ')),
    [],
    'all three bonuses are cleanly reachable',
  );
});

test('toActor records saves as ability proficiency', () => {
  const { actor } = toActor({ ...LAMIA_NPC, saves: [{ wisdom: 4 }] }, { name: 'S' });
  // WIS 15 (+2) at PB 2: +4 is proficiency.
  assert.equal(actor.system.abilities.wis.proficient, 1);
});

test('toActor warns instead of silently dropping an unknown skill', () => {
  const { actor, warnings } = toActor(
    { ...LAMIA_NPC, skillsaves: [{ basketweaving: 3 }] },
    { name: 'S' },
  );
  assert.ok(!actor.system.skills, 'no skills survive');
  assert.match(warnings[0], /unknown skill "basketweaving"/);
});

test('toActor wires art into both the portrait and the token', () => {
  const { actor } = toActor(LAMIA_NPC, {
    name: 'Vashti',
    img: 'DnD/06 Assets/Tokens/srd/Lamia.webp',
  });
  assert.equal(actor.img, 'DnD/06 Assets/Tokens/srd/Lamia.webp');
  assert.equal(actor.prototypeToken.texture.src, 'DnD/06 Assets/Tokens/srd/Lamia.webp');
});

test('biographyHtml renders traits and actions into the prose the actors use', () => {
  const html = biographyHtml(LAMIA_NPC, '<p>Intro.</p>');
  assert.ok(html.startsWith('<p>Intro.</p>'));
  assert.ok(html.includes('<h3>Traits</h3>'));
  assert.ok(html.includes('<strong>Innate Spellcasting.</strong>'));
  assert.ok(html.includes('<h3>Actions</h3>'));
  assert.ok(!html.includes('Reactions'), 'empty sections are omitted');
});

const SRD_LAMIA = {
  name: 'Lamia',
  ac: 13,
  hp: 97,
  cr: 4,
  size: 'lg',
  type: 'monstrosity',
  abilities: { str: 16, dex: 13, con: 15, int: 14, wis: 15, cha: 16 },
};

test('verify reports nothing when the fence matches its SRD base', () => {
  assert.deepEqual(verify(LAMIA_NPC, SRD_LAMIA), []);
});

test('verify reports a delta rather than failing', () => {
  const deltas = verify({ ...LAMIA_NPC, hp: 120 }, SRD_LAMIA);
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0], { field: 'hp', authored: 120, srd: 97 });
});

test('deviations silences an intentional change, keeping it visible in review', () => {
  assert.deepEqual(verify({ ...LAMIA_NPC, hp: 120, deviations: ['hp'] }, SRD_LAMIA), []);
});

test('verify skips fields the SRD cache cannot supply', () => {
  // Armour-wearing monsters have no stored AC; that must read as "not
  // checkable", never as a mismatch against 0.
  const armoured = { ...SRD_LAMIA, ac: undefined };
  assert.deepEqual(verify(LAMIA_NPC, armoured), []);
  assert.deepEqual(verify(LAMIA_NPC, null), []);
});

test('verify catches a wrong ability score', () => {
  const deltas = verify({ ...LAMIA_NPC, stats: [16, 13, 15, 14, 15, 10] }, SRD_LAMIA);
  assert.deepEqual(deltas, [{ field: 'cha', authored: 10, srd: 16 }]);
});

test('parseArgs requires a note and rejects junk', () => {
  assert.throws(() => parseArgs([]), /Missing <note.md>/);
  assert.throws(() => parseArgs(['n.md', '--nope']), /Unknown argument/);
  const o = parseArgs(['n.md', '--out', 'a.json', '--srd', 's.json']);
  assert.equal(o.note, 'n.md');
  assert.equal(o.out, 'a.json');
  assert.equal(o.srd, 's.json');
});

test('compileNote reads a note end to end and names the actor from the file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'statblock-'));
  const note = path.join(dir, 'Vashti.md');
  const fence = Object.entries(LAMIA_NPC)
    .filter(([k]) => !['traits', 'actions', 'stats', 'skillsaves'].includes(k))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n');
  await writeFile(
    note,
    `---\ntype: npc\n---\n\n\`\`\`statblock\n${fence}\nstats: [16, 13, 15, 14, 15, 16]\n\`\`\`\n`,
  );

  const { actor, base, edition, deltas } = await compileNote(note);
  assert.equal(actor.name, 'Vashti', 'named from the filename, not the fence');
  assert.equal(base, 'Lamia');
  assert.equal(edition, '5.1');
  assert.deepEqual(deltas, [], 'no SRD index supplied, so nothing to diff');
  assert.equal(actor.system.attributes.ac.flat, 13);
});

test('compileNote takes disposition from the note frontmatter', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'statblock-'));
  const note = path.join(dir, 'Sable Vance.md');
  await writeFile(
    note,
    '---\ntype: npc\ndisposition: neutral\n---\n\n```statblock\nname: Vashti\nac: 12\nhp: 27\ncr: 1\nstats: [10, 15, 10, 12, 14, 16]\n```\n',
  );
  const { actor } = await compileNote(note);
  assert.equal(actor.name, 'Sable Vance');
  assert.equal(actor.prototypeToken.disposition, 0, 'neutral, not hostile');
});

test('compileNote fails loudly on a note with no statblock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'statblock-'));
  const note = path.join(dir, 'Empty.md');
  await writeFile(note, '# Just prose\n');
  await assert.rejects(() => compileNote(note), /no ```statblock fence found/);
});

test('open5eFor routes to the index matching the cited edition', () => {
  // Load-bearing: the 2024 rules restat creatures. The SRD Lamia is a
  // monstrosity with Stealth +3 in 5.1 and a fiend with Stealth +5 in 5.2, and
  // the SRD Spy is Medium in 5.1 but Small in 5.2. Checking a 5.1 note against
  // the 2024 index invents deltas that are not errors.
  assert.match(open5eFor('5.1', '/ref'), /open5e-2014\.json$/);
  assert.match(open5eFor('5.2', '/ref'), /open5e-2024\.json$/);
  assert.equal(open5eFor(undefined, '/ref'), null, 'no edition cited, no index');
  assert.equal(open5eFor('9.9', '/ref'), null);
});

// Open5e supplies STATED skill bonuses; the dnd5e compendium does not.
const OPEN5E_LAMIA = {
  name: 'Lamia',
  ac: 13,
  hp: 97,
  cr: 4,
  size: 'lg',
  type: 'monstrosity',
  abilities: { str: 16, dex: 13, con: 15, int: 14, wis: 15, cha: 16 },
  skills: { dec: 7, ins: 4, ste: 3 },
};

test('verify compares stated skill bonuses when the reference has them', () => {
  assert.deepEqual(verify(LAMIA_NPC, OPEN5E_LAMIA), [], 'the vault fence matches SRD 5.1');

  const wrong = { ...LAMIA_NPC, skillsaves: [{ deception: 4 }] };
  assert.deepEqual(verify(wrong, OPEN5E_LAMIA), [
    { field: 'skill.deception', authored: 4, srd: 7 },
  ]);
});

test('verify skips skills when the reference cannot supply them', () => {
  // The dnd5e compendium stores a proficiency multiplier, not a bonus, so its
  // records carry no `skills` — that must read as "not checkable".
  const compendiumStyle = { ...OPEN5E_LAMIA, skills: undefined };
  assert.deepEqual(verify({ ...LAMIA_NPC, skillsaves: [{ deception: 99 }] }, compendiumStyle), []);
});

test('toActor warns rather than silently shipping a blank silhouette', () => {
  const { actor, warnings } = toActor(LAMIA_NPC, { name: 'Vashti' });
  assert.equal(actor.img, PLACEHOLDER_IMG);
  assert.ok(
    warnings.some(w => w.includes(PLACEHOLDER_IMG)),
    'falling back to placeholder art must be reported',
  );
  // With art, no warning.
  const withArt = toActor(LAMIA_NPC, { name: 'Vashti', img: 'DnD/x/Lamia.webp' });
  assert.ok(!withArt.warnings.some(w => w.includes(PLACEHOLDER_IMG)));
});
