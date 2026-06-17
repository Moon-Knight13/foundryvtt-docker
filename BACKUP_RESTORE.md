# Backup Restoration Guide

This guide explains how to restore FoundryVTT backups from another laptop into this Docker deployment.

## Overview

FoundryVTT stores backups in your User Data folder at:
```
~/.local/share/FoundryVTT/Backups/
```

Backups consist of:
- **.bak files**: The actual backed-up data
- **.json files**: Metadata manifests describing each backup
- **Snapshot.json files**: References multiple `.bak` files to restore entire snapshots

This deployment maps the Backups folder into the container, allowing you to restore backups through the FoundryVTT UI.

## Setup: Configure SSH Access

Before pulling backups from a remote host, ensure SSH key-based authentication is configured.

### On Remote Host (Source Laptop)

1. Allow SSH access and verify FoundryVTT backups exist:
```bash
ls -la ~/.local/share/FoundryVTT/Backups/
```

### On Deploy Host

1. Generate SSH key (if you don't have one):
```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ""
```

2. Copy public key to remote host:
```bash
ssh-copy-id -i ~/.ssh/id_rsa user@remote-host
```

3. Test the connection:
```bash
ssh -i ~/.ssh/id_rsa user@remote-host "ls ~/.local/share/FoundryVTT/Backups/"
```

## Method 1: Interactive Setup (Recommended)

Run the automated setup script:

```bash
./deploy-setup.sh
```

When prompted:
1. Answer yes to backup restoration
2. Enter remote host as `user@hostname`
3. Enter remote backup path (default: `~/.local/share/FoundryVTT`)
4. Enter SSH key path (default: `~/.ssh/id_rsa`)
5. The script automatically syncs data to `~/.local/share/FoundryVTT/`

## Method 2: Manual Pull

If backups weren't pulled during setup, manually pull them:

```bash
# Create local FoundryVTT data directory
mkdir -p ~/.local/share/FoundryVTT

# Sync from remote host via rsync over SSH
rsync -avz --progress -e "ssh -i ~/.ssh/id_rsa" user@remote-host:~/.local/share/FoundryVTT/ ~/.local/share/FoundryVTT/

# In .env, set:
# FOUNDRY_BACKUPS_PATH=~/.local/share/FoundryVTT/Backups

# Or, if using deploy-setup variables:
source .env
rsync -avz --progress -e "ssh -i $BACKUP_SSH_KEY" "$BACKUP_REMOTE_HOST:$BACKUP_REMOTE_PATH/" "$BACKUP_LOCAL_PATH/"
```

## Restoring Backups Inside Container

### 1. Start the container:
```bash
docker compose up -d
```

### 2. Access FoundryVTT Setup Screen

1. Navigate to: `http://localhost:30000`
2. Log in with your credentials
3. Go to **Setup** menu → **Manage Backups**

### 3. Restore a Backup

**For Individual World/System/Module Backups:**
1. Navigate to the **Setup** screen
2. Find the backup you want to restore
3. Right-click and select **Restore Latest**
4. Or use **Manage Backups** for more options

**For Snapshots:**
1. Click **Manage Backups**
2. Select the **Snapshots** tab
3. Find your snapshot and click **Restore**

> **Note:** Depending on backup size, restoration may take several minutes.

## File Locations

- **Container backup location**: `/data/Backups/`
- **Host backup location**: `~/.local/share/FoundryVTT/Backups/`
- **Remote data source**: `~/.local/share/FoundryVTT/` (on source laptop)

All backup files are automatically available to the container, and any restored data persists on the host.

## Backup Structure

```
~/.local/share/FoundryVTT/Backups/
├── worlds
│   └── world-name
│       ├── world-name.bak          # Actual backup data
│       └── world-name.json         # Backup metadata
├── systems
│   └── system-name
│       ├── system-name.bak
│       └── system-name.json
├── modules
│   └── module-name
│       ├── module-name.bak
│       └── module-name.json
└── snapshots
    └── Snapshot_2024_01_15.json    # Contains references to .bak files
```

## Important Notes

⚠️ **Do NOT manually edit or delete backup files!**

- Snapshots reference individual `.bak` files
- Deleting a referenced `.bak` file will break the entire snapshot
- Always use FoundryVTT's **Manage Backups** UI to delete backups

✅ **Best Practices:**

1. Keep SSH keys secure and use key-based auth only
2. Test SCP pull before deploying to production
3. Verify backup integrity after restore
4. Keep recent backups on both source and deploy hosts
5. Document your backup naming convention

## Troubleshooting

### SSH Connection Fails
```bash
# Debug SSH connection
ssh -i ~/.ssh/id_rsa -v user@remote-host

# Check if backups exist
ssh -i ~/.ssh/id_rsa user@remote-host "ls -lah ~/.local/share/FoundryVTT/Backups/"
```

### rsync Pull Fails
```bash
# Verify path formatting
rsync -avz --progress -e "ssh -i ~/.ssh/id_rsa" user@remote-host:~/.local/share/FoundryVTT/ ~/.local/share/FoundryVTT/
```

### Restore Fails in FoundryVTT UI
1. Check file permissions: `ls -la ~/.local/share/FoundryVTT/Backups/`
2. Verify `.bak` and `.json` files both exist
3. Check container logs: `docker compose logs foundry | tail -50`
4. Ensure snapshot `.json` files reference valid `.bak` files

### View Container Backup Path
```bash
# Shell into container
docker compose exec foundry /bin/bash

# Inside container, check backup location
ls -la /data/Backups/
```

## Further Reading

- [FoundryVTT Backup Documentation](https://foundryvtt.com/article/backups/)
- [FoundryVTT Manual Backup & Restore](https://foundryvtt.com/article/user-data-backup/)
- [FoundryVTT Asset Management](https://foundryvtt.com/article/asset-management/)
