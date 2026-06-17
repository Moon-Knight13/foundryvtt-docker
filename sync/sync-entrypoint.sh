#!/bin/sh
# rsync-based file synchronization service
# Syncs files from remote source to container's /data directory

set -e

SYNC_INTERVAL=${SYNC_INTERVAL:-300}  # Default 5 minutes
SYNC_SOURCE_DIR=${SYNC_SOURCE_DIR}
SYNC_DEST_DIR=${SYNC_DEST_DIR:-/data}

if [ -z "$SYNC_SOURCE_DIR" ]; then
    echo "Error: SYNC_SOURCE_DIR not set"
    exit 1
fi

echo "Starting rsync sync service..."
echo "Source: $SYNC_SOURCE_DIR"
echo "Destination: $SYNC_DEST_DIR"
echo "Interval: ${SYNC_INTERVAL}s"

# Perform initial sync
# NOTE: --delete removes files on destination not present on source
# This means changes made on host will be lost on next sync!
# Consider using Syncthing for bidirectional sync instead.
sync_files() {
    echo "[$(date)] Syncing files..."
    # Using --delete to keep host in sync with source
    # WARNING: Any changes made on host will be overwritten!
    rsync -av --delete "$SYNC_SOURCE_DIR" "$SYNC_DEST_DIR/" || echo "Sync attempt failed, will retry..."
}

# Initial sync
sync_files

# Continuous sync loop
while true; do
    sleep "$SYNC_INTERVAL"
    sync_files
done
