// Carry each scene's ambience cue from the vault note that owns it onto the
// Foundry scene that is about to be built, so the cue reaches the GM at the one
// moment it matters — the scene change — without anyone maintaining a second
// copy of it.
//
// This is NOT a step towards Foundry playlists. Nothing here streams: the flag
// carries three strings and a paste-ready command. Audio still plays outside
// Foundry (see docs/CONTENT_AUTHORING.md, "Ambience stays out of Foundry"),
// which is what keeps an in-person session working at all.
//
// The cue lives on the scene note's frontmatter:
//
//   audio_source: spotify        # tabletopaudio | spotify | local | none
//   audio_ref: https://...       # or a saved-playlist name, or a filename
//   audio_cue: as the boat leaves the jetty
//
// and the bot syntax lives once per game, in Soundtrack.md's frontmatter, so
// switching bots is one line rather than a sweep through every scene.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseFrontmatter } from './handout.mjs';

/** Flag scope on the built Scene. Fixed, so a macro can read it generically. */
export const CUE_FLAG_SCOPE = 'foundry-cue';

/** Written when the author means silence, rather than has not chosen yet. */
export const SILENT = 'none';

/**
 * Substitute `{ref}` in a bot command template. Returns null when there is no
 * template or nothing to play — a half-built command is worse than none, since
 * the whole point is that it can be pasted without being read first.
 */
export function resolveCommand(template, ref) {
  if (!template || !ref) return null;
  if (!template.includes('{ref}')) return template;
  return template.replaceAll('{ref}', ref);
}

/**
 * Read a game's Soundtrack.md for the bot syntax and the game-level playlist.
 * A game with no Soundtrack.md is not an error — its scenes simply carry no
 * command, only cue text.
 */
export async function readGameAudio(gameDir) {
  try {
    const markdown = await readFile(path.join(gameDir, 'Soundtrack.md'), 'utf8');
    const fm = parseFrontmatter(markdown);
    return {
      bot: fm.audio_bot ?? null,
      command: fm.audio_command ?? null,
      playlist: fm.soundtrack_playlist ?? null,
    };
  } catch {
    return { bot: null, command: null, playlist: null };
  }
}

/**
 * Build the cue payload for one scene note. Returns null when there is nothing
 * to say: no cue keys at all (a to-do), or `audio_source: none` (a choice).
 *
 * A scene's own `audio_ref` wins over the game playlist. That is the whole
 * two-tier model: games that run start-to-finish set one playlist and skip
 * through it, games that jump around name a ref per scene.
 */
export function resolveCue(frontmatter = {}, game = {}) {
  const source = frontmatter.audio_source ?? null;
  const cue = frontmatter.audio_cue ?? null;
  if (source === SILENT) return null;
  if (!source && !cue && !frontmatter.audio_ref) return null;

  const ref = frontmatter.audio_ref ?? game.playlist ?? null;
  return {
    source,
    ref,
    cue,
    command: resolveCommand(game.command, ref),
    bot: game.bot ?? null,
  };
}

/**
 * Write the cue onto a scene document under our flag scope. Returns the scene
 * and whether anything actually changed, so a re-run over an unedited game
 * rewrites nothing.
 */
export function stampCue(scene, audio) {
  const before = JSON.stringify(scene.flags?.[CUE_FLAG_SCOPE]?.audio ?? null);
  const after = JSON.stringify(audio);
  if (before === after) return { scene, changed: false };
  const flags = { ...(scene.flags ?? {}) };
  flags[CUE_FLAG_SCOPE] = { ...(flags[CUE_FLAG_SCOPE] ?? {}), audio };
  return { scene: { ...scene, flags }, changed: true };
}
