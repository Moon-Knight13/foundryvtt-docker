// Resolve a statblock fence to token art through the curated art map
// (content/reference/art-map.json). Pure — no I/O — so the chain is testable
// the way validateDoc and validateLinks are.
//
// The chain, and why it stops where it does:
//
//   explicit   image: in the fence, used verbatim
//   raster     a per-creature raster source — present but DISABLED until the
//              firewall rebuild lets its hit rate be measured
//   exact      the curated byName map: only matches whose icon subject IS the
//              creature, never fuzzy name-matching (measured: fuzzy pairs
//              Adult Gold Dragon with gold-bar.svg)
//   type       one silhouette per SRD creature type — for MOOKS only
//   none       the gate's business, not this module's
//
// What makes a mook is the note's TITLE matching its base creature, not the
// mere presence of source:. Measured on a real module: every named NPC there
// was built on an SRD base (two different characters both sat on the Spy),
// and a source:-presence rule dressed both in the same spy icon — two named
// characters, identical tokens, and a green gate. "Bandit.md" built on Bandit
// is a bandit; "Rook Vantle.md" built on Spy is a person someone authored,
// and that art gap must stay visible.
//
// art_required overrides the inference in either direction: true refuses the
// silhouette even for an exact-title mook, false unlocks the base creature's
// icon and the silhouette for a named NPC.

// Where art-fetch.mjs lands the icons, as Foundry sees it through the vault
// mount (compose.yml maps $DND_VAULT_PATH to /data/Data/DnD).
export const GENERIC_ART_DIR = 'DnD/06 Assets/Tokens/generic';

// Prefixes Foundry resolves on its own: its Data-root trees and plain URLs.
// Anything else in an image: is a vault-relative path the author wrote so the
// note ALSO renders in Obsidian, and gains the DnD/ mount prefix here.
const FOUNDRY_NATIVE = /^(DnD\/|icons\/|systems\/|modules\/|https?:\/\/)/;

/** Vault-relative image path to Foundry Data path; Foundry-native paths pass. */
export function normalizeArtPath(src) {
  if (!src) return src;
  return FOUNDRY_NATIVE.test(src) ? src : `DnD/${src}`;
}

/** Same words = same creature: forgiving about case and punctuation only. */
function sameCreature(a, b) {
  const norm = s =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return norm(a) !== '' && norm(a) === norm(b);
}

function iconEntry(entry, tier) {
  return { src: `${GENERIC_ART_DIR}/${entry.icon}`, tier, artist: entry.artist };
}

/**
 * @param {object} fence  { name, base?, type?, image?, art_required? }
 *                        `name` is the note title (the actor's identity);
 *                        `base` is the SRD creature the fence was built on.
 * @param {object} map    parsed art-map.json ({ byName, byType, raster? })
 * @returns {{ src: string|null, tier: string, artist?: string }}
 */
export function resolveArt(fence, map) {
  if (fence.image) return { src: normalizeArtPath(fence.image), tier: 'explicit' };

  if (map.raster?.enabled) {
    const hit = map.raster.byName?.[fence.base ?? fence.name];
    if (hit) return { src: hit.src, tier: 'raster' };
  }

  // The actor's OWN name in the curated map is always its art — a note titled
  // "Wolf" is a wolf whether or not it cites a source.
  const own = map.byName?.[fence.name];
  if (own) return iconEntry(own, 'exact');

  const isMook = sameCreature(fence.name, fence.base);
  const standInOk = fence.art_required === undefined ? isMook : !fence.art_required;
  if (standInOk) {
    // art_required: false reaches here with name ≠ base, so the base
    // creature's icon is a distinct (and better) tier than the silhouette.
    const viaBase = fence.base && map.byName?.[fence.base];
    if (viaBase) return iconEntry(viaBase, 'exact');
    const typed = map.byType?.[fence.type];
    if (typed) return iconEntry(typed, 'type');
  }

  return { src: null, tier: 'none' };
}
