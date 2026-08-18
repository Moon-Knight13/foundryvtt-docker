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
//   type       one silhouette per SRD creature type — acceptable for a mook
//              inherited via source:, never for a bespoke named NPC, so this
//              tier is skipped when the fence has no source:
//   none       the gate's business, not this module's
//
// art_required overrides the mook/named-NPC inference in either direction:
// true makes a mook as strict as a named NPC, false lets a bespoke NPC accept
// the silhouette.

// Where art-fetch.mjs lands the icons, as Foundry sees it through the vault
// mount (compose.yml maps $DND_VAULT_PATH to /data/Data/DnD).
export const GENERIC_ART_DIR = 'DnD/06 Assets/Tokens/generic';

/**
 * @param {object} fence  { name, type, image?, source?, art_required? }
 * @param {object} map    parsed art-map.json ({ byName, byType, raster? })
 * @returns {{ src: string|null, tier: string, artist?: string }}
 */
export function resolveArt(fence, map) {
  if (fence.image) return { src: fence.image, tier: 'explicit' };

  if (map.raster?.enabled) {
    const hit = map.raster.byName?.[fence.name];
    if (hit) return { src: hit.src, tier: 'raster' };
  }

  const named = map.byName?.[fence.name];
  if (named) {
    return { src: `${GENERIC_ART_DIR}/${named.icon}`, tier: 'exact', artist: named.artist };
  }

  // A silhouette is a stand-in, so it is only offered where a stand-in is
  // acceptable: a source:-inherited mook, or an explicit art_required: false.
  const silhouetteOk =
    fence.art_required === undefined ? Boolean(fence.source) : !fence.art_required;
  if (silhouetteOk) {
    const typed = map.byType?.[fence.type];
    if (typed) {
      return { src: `${GENERIC_ART_DIR}/${typed.icon}`, tier: 'type', artist: typed.artist };
    }
  }

  return { src: null, tier: 'none' };
}
