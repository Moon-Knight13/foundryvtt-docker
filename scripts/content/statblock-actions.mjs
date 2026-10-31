#!/usr/bin/env node
// Turn a statblock's prose actions into Items a GM can click.
//
// An NPC used to import carrying no Items at all. Its attacks, traits and
// reactions existed only as biography prose, so running one in Foundry meant
// reading a paragraph and rolling by hand — mid-combat, with players waiting.
//
// The text is worth parsing because it is not free-form. SRD statblocks state
// an attack in one shape, and both editions of it are regular:
//
//   Melee Weapon Attack: +5 to hit, reach 5 ft., one target.
//     Hit: 14 (2d10 + 3) slashing damage.            <- 2014
//   Melee Attack Roll: +5, reach 5 ft. Hit: 14 (2d10 + 3) Slashing damage.
//                                                    <- 2024
//
// What is NOT parsed is as important. A rider clause — "and the target is
// grappled (escape DC 12)", "taking 22 (4d10) poison damage on a failed save" —
// stays in the description rather than being modelled. Guessing at a saving
// throw activity from prose would produce an attack that rolls something
// subtly different from what the statblock says, which is worse at the table
// than prose a GM reads.
//
// The activity schema here is copied from dnd5e's own SRD pack sources
// (foundryvtt/dnd5e, MIT, packs/_source/actors24), not inferred. That matters
// because a packed document never gets one generated: dnd5e builds an Item's
// activities in `_onCreate`, and compilePack runs no document lifecycle hook,
// so an attack with no activity written here is an attack that cannot be rolled.
import { createHash } from 'node:crypto';

/** Foundry document ids are 16 hex characters, and ours are deterministic. */
function activityId(seed) {
  return createHash('sha256').update(`activity/${seed}`).digest('hex').slice(0, 16);
}

/** Damage types dnd5e knows, so an unparsed word is dropped rather than invented. */
const DAMAGE_TYPES = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

/**
 * The attack clause of an action, or null when the text is not an attack.
 *
 * Deliberately conservative: anything it cannot read cleanly returns null and
 * becomes a plain feature. A half-understood attack is worse than prose.
 */
export function parseAttack(desc) {
  const text = String(desc ?? '').replace(/\s+/g, ' ');

  // 2014: "Melee Weapon Attack: +5 to hit". 2024: "Melee Attack Roll: +5".
  const head =
    /(Melee|Ranged|Melee or Ranged)\s+(Weapon|Spell)?\s*Attack(?:\s+Roll)?:\s*([+-]\d+)/i.exec(
      text,
    );
  if (!head) return null;

  const [, kindWord, classWord, bonus] = head;
  const kind = /^melee or ranged$/i.test(kindWord)
    ? 'both'
    : kindWord.toLowerCase() === 'ranged'
      ? 'ranged'
      : 'melee';

  const reach = /reach\s+(\d+)\s*(?:ft|feet)/i.exec(text);
  const range = /range\s+(\d+)\s*\/\s*(\d+)\s*(?:ft|feet)/i.exec(text);

  // "Hit: 14 (2d10 + 3) slashing damage" — the average in front is ignored,
  // because the dice are what gets rolled.
  const dice = /Hit:[^.]*?\((\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\)\s*(\w+)\s+damage/i.exec(text);
  const flat = dice ? null : /Hit:\s*(\d+)\s+(\w+)\s+damage/i.exec(text);

  let damage = null;
  if (dice) {
    const type = dice[5].toLowerCase();
    damage = {
      number: Number(dice[1]),
      denomination: Number(dice[2]),
      bonus: dice[3] ? `${dice[3] === '-' ? '-' : ''}${dice[4]}` : '',
      types: DAMAGE_TYPES.has(type) ? [type] : [],
    };
  } else if (flat) {
    const type = flat[2].toLowerCase();
    damage = {
      custom: { enabled: true, formula: flat[1] },
      types: DAMAGE_TYPES.has(type) ? [type] : [],
    };
  }

  return {
    kind,
    classification: (classWord ?? 'weapon').toLowerCase() === 'spell' ? 'spell' : 'weapon',
    bonus: bonus.replace(/^\+/, ''),
    reach: reach ? Number(reach[1]) : null,
    range: range ? { value: Number(range[1]), long: Number(range[2]) } : null,
    damage,
  };
}

/**
 * The attack activity for a parsed attack.
 *
 * `flat: true` is the point: a statblock's printed `+5` is authoritative, and
 * letting dnd5e derive the bonus from abilities and proficiency would quietly
 * print a different number from the card the GM is reading.
 */
export function attackActivity(name, attack) {
  const id = activityId(name);
  const rangeValue = attack.kind === 'ranged' ? attack.range?.value : attack.reach ?? null;

  return {
    type: 'attack',
    _id: id,
    sort: 0,
    activation: { type: 'action', value: null, override: false, condition: '' },
    consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
    description: { chatFlavor: '' },
    duration: { units: 'inst', concentration: false, override: false },
    effects: [],
    range: {
      override: true,
      units: 'ft',
      special: '',
      value: rangeValue === null || rangeValue === undefined ? '' : String(rangeValue),
      ...(attack.range ? { long: String(attack.range.long) } : {}),
    },
    target: {
      template: { contiguous: false, units: 'ft', type: '' },
      affects: { choice: false, type: '' },
      override: false,
      prompt: true,
    },
    uses: { spent: 0, recovery: [], max: '' },
    attack: {
      critical: { threshold: null },
      // The printed bonus, used as-is.
      flat: true,
      type: {
        value: attack.kind === 'both' ? 'melee' : attack.kind,
        classification: attack.classification,
      },
      ability: '',
      bonus: attack.bonus,
    },
    damage: { critical: { bonus: '' }, includeBase: true, parts: [] },
    name: '',
    img: null,
    flags: {},
  };
}

/** An attack as a weapon Item, equipped and rollable. */
export function attackItem(name, attack, description) {
  const base = attack.damage
    ? attack.damage.custom
      ? {
          number: null,
          denomination: null,
          bonus: '',
          types: attack.damage.types,
          custom: attack.damage.custom,
          scaling: { number: 1 },
        }
      : {
          number: attack.damage.number,
          denomination: attack.damage.denomination,
          bonus: attack.damage.bonus,
          types: attack.damage.types,
          custom: { enabled: false, formula: '' },
          scaling: { number: 1 },
        }
    : { number: null, denomination: null, bonus: '', types: [], custom: { enabled: false } };

  return {
    _id: activityId(`item/${name}`),
    name,
    type: 'weapon',
    system: {
      type: { value: 'natural', baseItem: '' },
      activities: { [attackActivity(name, attack)._id]: attackActivity(name, attack) },
      description: { value: `<p>${escapeHtml(description)}</p>`, chat: '' },
      identifier: slugify(name),
      equipped: true,
      proficient: 1,
      damage: { base },
      range: {
        value: attack.range?.value ?? null,
        long: attack.range?.long ?? null,
        reach: attack.reach ?? null,
        units: 'ft',
      },
      properties: [],
    },
  };
}

/** A trait, a non-attack action, or a reaction — prose a GM reads and uses. */
export function featureItem(name, description, { activation = null } = {}) {
  return {
    _id: activityId(`feat/${name}`),
    name,
    type: 'feat',
    system: {
      type: { value: 'monster', subtype: '' },
      description: { value: `<p>${escapeHtml(description)}</p>`, chat: '' },
      identifier: slugify(name),
      ...(activation ? { activation: { type: activation, value: null, override: false } } : {}),
    },
  };
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Every Item a statblock fence describes.
 *
 * An action whose text reads as an attack becomes a weapon; everything else
 * becomes a feature carrying the same prose it always did. Nothing is dropped —
 * a Multiattack is not rollable and is still the first thing a GM reads.
 */
export function itemsFromStatblock(fence) {
  const items = [];
  const add = (list, kind, activation) => {
    for (const entry of list ?? []) {
      const name = String(entry?.name ?? '').trim();
      const desc = String(entry?.desc ?? '').trim();
      if (!name) continue;

      const attack = kind === 'action' || kind === 'reaction' ? parseAttack(desc) : null;
      if (attack) items.push(attackItem(name, attack, desc));
      else items.push(featureItem(name, desc, { activation }));
    }
  };

  add(fence.traits, 'trait', null);
  add(fence.actions, 'action', 'action');
  add(fence.reactions, 'reaction', 'reaction');
  add(fence.legendary_actions ?? fence.legendary, 'legendary', 'legendary');

  return items;
}
