# Backup Restoration

This directory is reserved for future sync/backup service configurations.

## Current Backup Approach: SCP-based Restore

We use a simple, bandwidth-efficient backup restore approach:

- ✅ **Simple**: SSH key-based SCP pull
- ✅ **Bandwidth efficient**: Only copy once during setup
- ✅ **Secure**: No continuous network sync overhead
- ✅ **Flexible**: Restore multiple backups or snapshots

### Quick Start

```bash
# Run interactive setup
./deploy-setup.sh

# Follow prompts to configure backup source
# Backups are automatically pulled to ./data/Backups/

# Start container
docker compose up -d

# Restore in FoundryVTT UI
# Setup → Manage Backups → Restore
```

### Full Setup Guide

See [../BACKUP_RESTORE.md](../BACKUP_RESTORE.md) for complete documentation:
- SSH key configuration
- Backup structure explanation
- Restoration procedures
- Troubleshooting

### Architecture

```
Remote Laptop                Host PC (Docker)
├─ ~/.local/share/          ├─ FoundryVTT Container
│  FoundryVTT/Backups/       ├─ ./data/Backups/
└─ (via SSH)                 └─ (via SCP pull)
   ←─── One-time pull
```

**Key**: SCP pull only transfers backup files once. Use FoundryVTT UI to restore.

## Configuration

See `.env.example` for backup settings:
```bash
BACKUP_REMOTE_HOST=user@hostname
BACKUP_REMOTE_PATH=~/.local/share/FoundryVTT/Backups
BACKUP_SSH_KEY=~/.ssh/id_rsa
FOUNDRY_BACKUPS_PATH=./data/Backups
```

## Files in This Directory

- `README.md` - This file (sync/backup overview)

## Support

For setup help and troubleshooting, see [../BACKUP_RESTORE.md](../BACKUP_RESTORE.md)
