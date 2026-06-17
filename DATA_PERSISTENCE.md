# Data Persistence & Backup Restoration

## Quick Answer

**YES, data persists!** And you can easily restore backups from other laptops!

- ✅ **Host Persistence**: Changes in container → persist on host (`./data` directory)
- ✅ **Restart Persistence**: Container stops/restarts → all data still there
- ✅ **Backup Restoration**: One-time SCP pull from secondary laptop during setup
- ✅ **No Sync Overhead**: Backups pulled once, not continuously synced

---

## Data Persistence: How It Works

### Single Host Deployment

```
┌──────────────────────────────────┐
│     Hosting PC                   │
│  ┌────────────────────────────┐  │
│  │ Docker Container (FoundryVTT)  │
│  │   /data (container path)   │  │
│  └────────────────────────────┘  │
│         ↓ Volume Mount            │
│  ┌────────────────────────────┐  │
│  │ ./data (host filesystem)   │  │
│  │ (persists across restarts) │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘

Flow:
1. You make changes in FoundryVTT web UI
2. Changes written to /data inside container
3. Volume mount syncs to ./data on host
4. Data persists even if container stops
5. Next restart: container reads from ./data
```

**Result**: ✅ Data persists perfectly!

---

## Backup Restoration: How It Works

### With Remote Backups

```
┌──────────────────────────────────┐
│  Secondary Laptop                │
│  ~/.local/share/FoundryVTT/      │
│  └─ Backups/                     │
│     ├─ world-name.bak           │
│     ├─ world-name.json          │
│     └─ Snapshot_2024_01.json    │
└──────────────────────────────────┘
         ↑ SCP pull (one-time)
         │ during setup
         │
┌──────────────────────────────────┐
│     Hosting PC                   │
│  ┌────────────────────────────┐  │
│  │ Docker Container           │  │
│  │ /data/Backups (available)  │  │
│  └────────────────────────────┘  │
│         ↓ Volume Mount            │
│  ┌────────────────────────────┐  │
│  │ ./data/Backups             │  │
│  │ ← pulled from laptop       │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘

Flow:
1. Setup: SCP pulls backups from laptop → host ./data/Backups/
2. Container starts with /data/Backups/ available
3. Use FoundryVTT UI: Setup → Manage Backups
4. Select and restore backup (1-10 min depending on size)
5. Restored data now in /data (persists on host)
```

**Result**: ✅ Easy one-time restore with no ongoing sync overhead!

---

## Data Persistence: YES ✅

### Testing Single Host

```bash
# 1. Start container
docker compose up -d

# 2. Create a test world in FoundryVTT UI
# (via http://localhost:30000)

# 3. Check it's on disk
ls -la ./data/worlds/

# 4. Stop container
docker compose down

# 5. Start again
docker compose up -d

# 6. Check world still exists
ls -la ./data/worlds/
# ✅ Should be there!
```

### Testing Backup Restore

```bash
# 1. Setup pulled backups from remote
./deploy-setup.sh

# 2. Start container
docker compose up -d

# 3. Check backups are available
docker compose exec foundry ls -la /data/Backups/

# 4. Restore via FoundryVTT UI:
#    Setup → Manage Backups → Select backup → Restore

# 5. Check restored data persists
docker compose down
docker compose up -d
# ✅ Restored data still there!
```

---

## Architecture

### Single Host (No Backups)

Use case: Fresh deployment, create new campaigns directly

```bash
docker compose up -d
# Add campaigns in FoundryVTT UI
# Changes persist in ./data/
```

✅ **Best for**: New deployments, test servers

---

### With Remote Backups

Use case: Migrate from laptop to hosting PC

```bash
# Setup: Interactive script pulls backups
./deploy-setup.sh

# Start container
docker compose up -d

# Restore backups via FoundryVTT UI
```

✅ **Best for**: Migration, multi-device setups

---

## File Locations

### On Hosting PC

- **Container data**: `/data` (inside container)
- **Host data**: `./data/` (on filesystem)
- **Backups**: `./data/Backups/` (from SCP pull)

### On Secondary Laptop

- **Data**: `~/.local/share/FoundryVTT/` (standard FoundryVTT location)
- **Backups**: `~/.local/share/FoundryVTT/Backups/`

---

## Backup Structure

Backups consist of:

```
./data/Backups/
├── worlds/
│   └── world-name/
│       ├── world-name.bak           # Actual backup data
│       └── world-name.json          # Metadata manifest
├── systems/
│   └── system-name/
│       ├── system-name.bak
│       └── system-name.json
├── modules/
│   └── module-name/
│       ├── module-name.bak
│       └── module-name.json
└── snapshots/
    └── Snapshot_2024_01_15.json     # References multiple .bak files
```

⚠️ **Important**: Never manually edit or delete `.bak` files!
- Snapshots reference specific `.bak` files
- Deleting referenced files breaks the entire snapshot
- Always use FoundryVTT's **Manage Backups** UI to delete

---

## Data Persistence: Summary

| Scenario | Container Changes Persist | Survives Restart | Survives Host Restart |
|----------|---------------------------|------------------|----------------------|
| Single Host | ✅ YES | ✅ YES | ✅ YES |
| With Backups | ✅ YES | ✅ YES | ✅ YES |
| After Restore | ✅ YES | ✅ YES | ✅ YES |

---

## Next Steps

1. **Single host setup** (no backups needed):
   ```bash
   ./deploy-setup.sh
   docker compose up -d
   ```

2. **Restore from backups**:
   ```bash
   ./deploy-setup.sh  # Choose yes for backup restore
   docker compose up -d
   # Restore via FoundryVTT UI
   ```

3. **Make changes in FoundryVTT UI**:
   - All changes automatically persist in `./data/`
   - Data survives container/host restarts

For detailed setup instructions, see **[BACKUP_RESTORE.md](./BACKUP_RESTORE.md)**.

