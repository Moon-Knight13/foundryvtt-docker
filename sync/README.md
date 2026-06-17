# File Synchronization

This directory contains sync service configurations for FoundryVTT data.

## Current Implementation: Syncthing (Recommended)

Syncthing provides **bidirectional**, **bandwidth-efficient** file synchronization.

### Key Benefits

- ✅ **Bidirectional**: Changes sync both ways (host ↔ laptop)
- ✅ **Block-level sync**: Only changed blocks transfer
- ✅ **Bandwidth efficient**: Unchanged files = 0 bytes transferred
- ✅ **Real-time**: Instant sync on file changes
- ✅ **Conflict resolution**: Both versions saved if conflict
- ✅ **Web UI**: Easy management at http://localhost:8384

### Quick Start

```bash
# Generate API key
SYNCTHING_API_KEY=$(openssl rand -hex 16)

# Start Syncthing service
docker compose --profile sync up -d

# Access Web UI
# http://localhost:8384
```

### Full Setup

See [../SYNCTHING_SETUP.md](../SYNCTHING_SETUP.md) for complete guide:
- Step-by-step setup
- Adding secondary laptop
- Bandwidth optimization tests
- Troubleshooting
- Conflict resolution

## Legacy: rsync (Deprecated)

The old `Dockerfile.rsync` and sync scripts are deprecated. Use Syncthing instead for better performance and bidirectional sync.

If you need one-way sync for specific use cases:
```bash
./sync-user-files.sh <remote-user>@<remote-host>:/path/to/data
```

## Architecture

```
Host PC                    Secondary Laptop
├─ FoundryVTT             ├─ Syncthing
├─ ./data                 ├─ ~/foundry-data
└─ Syncthing              └─ Syncing...
   ↔────────────────────────↔
```

**Key**: Only changed blocks transfer. Unchanged files never retransmit!

## Configuration

See `.env.example` for Syncthing settings:
```bash
SYNC_METHOD=syncthing
SYNCTHING_API_KEY=<generated-key>
```

## Files in This Directory

- `README.md` - This file
- `.stignore` - Files excluded from sync (temp, cache, logs)
- `Dockerfile.rsync` - Legacy rsync service (deprecated)
- `sync-entrypoint.sh` - Legacy rsync script (deprecated)

## Support

For issues or setup help, see [../SYNCTHING_SETUP.md](../SYNCTHING_SETUP.md)
