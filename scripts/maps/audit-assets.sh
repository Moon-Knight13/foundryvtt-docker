#!/usr/bin/env bash
# Report oversized images in the Obsidian vault, with the WebP saving each would
# give. READ-ONLY: it never rewrites the vault.
#
# Why report rather than convert: Obsidian is the source of truth and notes
# reference images by filename, so changing an extension breaks every `![[…]]`
# embed and every Foundry scene `background.src` until those are updated too.
# That is a decision for the operator, not a script.
#
# Why it matters: FoundryVTT's server does no rendering — it ships bytes. Every
# image a player loads crosses the GM's upload link, so asset weight is one of
# the few lag levers actually on this side of the wire.
#
# Usage:
#   scripts/maps/audit-assets.sh [--vault <path>] [--min-kb N] [--top N]
#     --vault    vault root (default $DND_VAULT_PATH, else ~/DnD, else ~/Documents/DnD)
#     --min-kb   only report images at least this large (default 500)
#     --top      show at most this many (default 25)
set -euo pipefail

VAULT="${DND_VAULT_PATH:-}"
MIN_KB=500
TOP=25

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault)
      VAULT="${2:?--vault requires a path}"
      shift 2
      ;;
    --min-kb)
      MIN_KB="${2:?--min-kb requires a number}"
      shift 2
      ;;
    --top)
      TOP="${2:?--top requires a number}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$VAULT" ]]; then
  for candidate in "$HOME/DnD" "$HOME/Documents/DnD"; do
    [[ -d "$candidate" ]] && VAULT="$candidate" && break
  done
fi
if [[ -z "$VAULT" || ! -d "$VAULT" ]]; then
  echo "Error: no vault found. Set DND_VAULT_PATH or pass --vault <path>." >&2
  exit 1
fi

if ! python3 -c 'import PIL' 2> /dev/null; then
  echo "Error: Pillow is required (same dependency as render_map.py)." >&2
  echo "  pip install --break-system-packages --user Pillow" >&2
  exit 1
fi

echo "Vault:   $VAULT"
echo "Report:  images >= ${MIN_KB} KB, top ${TOP}"
echo

VAULT="$VAULT" MIN_KB="$MIN_KB" TOP="$TOP" python3 << 'PY'
import os
from io import BytesIO
from PIL import Image

vault = os.environ["VAULT"]
min_bytes = int(os.environ["MIN_KB"]) * 1024
top = int(os.environ["TOP"])
EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff"}

rows, total_now, total_after, skipped, no_gain = [], 0, 0, 0, 0
for root, dirs, files in os.walk(vault):
    dirs[:] = [d for d in dirs if d not in {".obsidian", ".git", ".trash"}]
    for f in files:
        path = os.path.join(root, f)
        if os.path.splitext(f)[1].lower() not in EXTS:
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        if size < min_bytes:
            continue
        # Codec by source type, which matters more than it sounds. Flat art
        # (PNG line art, maps, screenshots) shrinks 60%+ under LOSSLESS WebP and
        # is visibly degraded by a lossy pass. Photographs stored as JPEG are
        # already lossily compressed, and re-encoding them losslessly makes them
        # dramatically BIGGER — measured on this vault, a naive lossless-only
        # audit reported a net loss.
        photographic = os.path.splitext(f)[1].lower() in {".jpg", ".jpeg"}
        opts = {"quality": 82, "method": 6} if photographic else {"lossless": True, "method": 6}
        try:
            im = Image.open(path)
            im.load()
            buf = BytesIO()
            im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB").save(
                buf, "WEBP", **opts)
            after = buf.tell()
        except Exception:
            skipped += 1
            continue
        # Only report a real win. A conversion that grows the file is not a
        # recommendation, and averaging it into the total hides the good ones.
        if after >= size:
            no_gain += 1
            continue
        rows.append((size, after, "lossy" if photographic else "lossless",
                     os.path.relpath(path, vault)))
        total_now += size
        total_after += after

rows.sort(key=lambda r: r[0] - r[1], reverse=True)
if not rows:
    print("No image above the threshold would get smaller. Lower --min-kb to see more.")
else:
    print(f"{'current':>10}  {'as webp':>10}  {'save':>6}  {'mode':<8}  file")
    for size, after, mode, rel in rows[:top]:
        pct = 100 * (size - after) / size
        print(f"{size/1024:9.0f}K  {after/1024:9.0f}K  {pct:5.0f}%  {mode:<8}  {rel}")
    if len(rows) > top:
        hidden = sum(r[0] - r[1] for r in rows[top:])
        print(f"\n... and {len(rows) - top} more worth converting "
              f"({hidden/1048576:.1f} MB between them). Raise --top to list.")
    saved = total_now - total_after
    print(f"\n{len(rows)} files worth converting: {total_now/1048576:.1f} MB -> "
          f"{total_after/1048576:.1f} MB ({saved/1048576:.1f} MB saved, "
          f"{100*saved/total_now:.0f}%)")
if no_gain:
    print(f"{no_gain} file(s) above the threshold would get BIGGER as WebP — left alone.")
if skipped:
    print(f"{skipped} file(s) could not be read and were skipped.")

print("""
Nothing was modified. To convert one file (and then fix every note that
embeds it, plus any Foundry scene background pointing at it):

  python3 -c "from PIL import Image; import sys; \\
    Image.open(sys.argv[1]).save(sys.argv[2], 'WEBP', lossless=True, method=6)" \\
    in.png out.webp
""")
PY
