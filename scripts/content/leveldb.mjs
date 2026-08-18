// Shared diagnosis for LevelDB failures.
//
// Foundry stores compendium packs and world settings as LevelDB directories,
// and LevelDB is single-process: it takes an exclusive lock on open. A running
// Foundry holds every one of them, so any tool that reads them directly fails
// while the server is up.
//
// The errors that surface say nothing about locking. classic-level reports
// "Database is not open" (LEVEL_DATABASE_NOT_OPEN), and @foundryvtt/foundryvtt-cli
// turns the same condition into "Iterator is not open: cannot call next() after
// close()". Neither hints at the cause, which is why this exists.

/** True when an error is LevelDB refusing a second opener. */
export function isLockError(err) {
  const message = String(err?.message ?? '');
  const cause = String(err?.cause?.message ?? '');
  return (
    err?.code === 'LEVEL_DATABASE_NOT_OPEN' ||
    /already held by process/i.test(cause) ||
    /Database is not open/i.test(message) ||
    /Iterator is not open/i.test(message)
  );
}

/**
 * Turn a LevelDB failure into something actionable. Returns the original
 * message unchanged when it is not a lock, so real errors stay visible.
 */
export function explainLevelError(err, what) {
  if (!isLockError(err)) return err?.message ?? String(err);
  return (
    `Cannot read ${what}: the database is locked by another process.\n` +
    '\nLevelDB allows a single process at a time, and a running FoundryVTT holds\n' +
    'every pack and world database open. Stop it first:\n' +
    '\n  docker compose stop foundry\n' +
    '\n...run this command, then bring it back up with `docker compose up -d`.\n' +
    `\nUnderlying error: ${err?.cause?.message ?? err?.message ?? err}`
  );
}
