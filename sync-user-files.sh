#!/bin/bash
# Script to sync user files from a secondary laptop
# Usage: ./sync-user-files.sh [remote-user@remote-host:/path/to/data]

REMOTE_SOURCE="${1}"

if [ -z "$REMOTE_SOURCE" ]; then
    echo "Usage: $0 <remote-user>@<remote-host>:/path/to/foundry/data"
    echo ""
    echo "Example:"
    echo "  $0 user@host.local:/home/user/foundry-data"
    exit 1
fi

DATA_DIR="./data"

# Create data directory if it doesn't exist
mkdir -p "$DATA_DIR"

echo "🔄 Syncing FoundryVTT data from: $REMOTE_SOURCE"
echo "📁 To local directory: $DATA_DIR"
echo ""

# Use rsync to sync files
# -av: archive mode, verbose
# -z: compress during transfer
# --delete: delete files on destination not present on source
# -e ssh: use SSH as transport
rsync -avz --delete -e ssh "$REMOTE_SOURCE/" "$DATA_DIR/"

echo ""
echo "✅ Sync complete!"
echo ""
echo "To keep syncing automatically, set these in .env:"
echo "  SYNC_ENABLED=true"
echo "  SYNC_METHOD=rsync"
echo "  SYNC_SOURCE_DIR=$REMOTE_SOURCE"
echo ""
echo "Then start with: docker compose --profile sync up -d"
