# Syncthing Bidirectional Sync Setup Guide

Syncthing provides **bidirectional**, **bandwidth-efficient** synchronization between your hosting PC and secondary laptop. Only changed blocks are transferred - never full file rewrites.

## How Syncthing Works

**Bandwidth Efficiency**:
- ✅ Uses checksums to detect only changed blocks
- ✅ Only transfers modified portions of files
- ✅ Skips files that haven't changed (zero bandwidth)
- ✅ Compresses transfers on slow connections
- ✅ Excludes unnecessary files via `.stignore`

**Sync Direction**:
- ✅ Hosting PC ↔ Laptop (bidirectional)
- ✅ Changes on either device sync to both
- ✅ Conflict resolution when both edit same file

---

## Quick Start

### 1. Start Syncthing on Hosting PC

```bash
# Generate API key first
SYNCTHING_API_KEY=$(openssl rand -hex 16) && \
docker compose --profile sync up -d

# Verify it's running
docker compose logs syncthing | head -20
```

### 2. Access Syncthing Web UI

Open in browser: **http://localhost:8384**

You'll see setup wizard. Don't change default settings yet.

### 3. Get Your Device ID

In Syncthing Web UI:
1. Click **"This Device"** (top left)
2. Copy the **Device ID** (long string)
3. Save it: `SYNCTHING_DEVICE_ID=<paste-here>`

### 4. Create Syncthing Folder

1. Go to Web UI: http://localhost:8384
2. Click **"+ Create Folder"**
3. Fill in:
   - **Folder Label**: `FoundryVTT`
   - **Folder Path**: `/var/syncthing/Sync`
   - **Folder Type**: `Send & Receive`
4. Click **Save**

### 5. Add Secondary Laptop as Remote Device

On hosting PC Syncthing Web UI:
1. Click **"+ Add Remote Device"**
2. Enter the secondary laptop's **Device ID**
3. Select which folders to sync
4. Click **Save**

### 6. Add Hosting PC to Secondary Laptop

On secondary laptop (Linux/Mac):

```bash
# Install Syncthing
# macOS: brew install syncthing
# Ubuntu: sudo apt install syncthing
# Windows: Download from https://syncthing.net

# Start Syncthing
syncthing

# Access Web UI: http://localhost:8384
# Get your laptop's Device ID
# Add hosting PC's Device ID
# Share the FoundryVTT folder
```

---

## Bandwidth Optimization

### Syncthing Already Optimized By Default

```yaml
syncthing:
  environment:
    # These are pre-configured for efficiency
    - STGUIAPIKEY=${SYNCTHING_API_KEY}
    - STNORESTART=1
```

**What this means**:
- ✅ Block-level sync (not file-level)
- ✅ Only changed blocks transferred
- ✅ Unchanged files = 0 bandwidth
- ✅ Compression enabled
- ✅ .stignore excludes temp/cache files

### Files Excluded (in sync/.stignore)

These won't be synced (saves bandwidth):
```
*.tmp, *.lock          # Temporary files
node_modules/          # Package managers
__pycache__/           # Python cache
.cache/, cache/        # Caches
*.log                  # Logs
*.db-journal           # Database temp
Thumbs.db, .DS_Store   # System files
```

### Configure .stignore on Laptop

Copy the same `.stignore` patterns to your laptop:

**Linux/Mac**:
```bash
mkdir -p ~/.config/syncthing/patterns
# Add same patterns from sync/.stignore
```

---

## Testing Sync Efficiency

### Test 1: Verify Only Changed Blocks Sync

```bash
# 1. Create large test file on host
dd if=/dev/zero of=./data/test-1gb.bin bs=1M count=1000

# 2. Watch bandwidth in Web UI: http://localhost:8384
# You'll see bytes transferred as it syncs

# 3. Modify just one block
dd if=/dev/urandom of=./data/test-1gb.bin bs=1M count=1 seek=500 conv=notrunc

# 4. Watch bandwidth again
# Notice: Only ~1MB transferred, not full 1GB!
```

### Test 2: Verify Unchanged Files Don't Transfer

```bash
# 1. Initial sync completed (all files on both devices)

# 2. Create new worlds in FoundryVTT on host
# Modify campaigns, add NPCs, etc.

# 3. Check Syncthing Web UI
# Only the changed world files show in "Syncing"
# Other files: unchanged = 0 bytes transferred

# 4. Stop and restart Syncthing
docker compose restart syncthing

# 5. Check again - no files re-sync
# Already present with same checksum = skipped
```

---

## Handling Conflicts

If both devices edit the same file simultaneously:

1. Syncthing detects conflict
2. Keeps original as `.sync-conflict-<timestamp>`
3. Creates newest version as active file
4. Manually merge if needed

**To prevent conflicts**:
- Use `FOUNDRY_LOCAL_HOSTNAME` for specific edits
- Establish convention: Host for gameplay, Laptop for prep
- Check Syncthing dashboard before editing

---

## Web UI Dashboard

Access: **http://localhost:8384**

Key metrics:
- **Folder Status**: What's syncing
- **Remote Devices**: Connected laptops
- **Recent Changes**: Last files synced
- **Bandwidth Graph**: Current transfer rate

### Commands

```bash
# View Syncthing logs
docker compose logs -f syncthing

# Get Syncthing stats
docker compose exec syncthing curl -s http://localhost:8384/api/system/status

# Restart Syncthing
docker compose restart syncthing

# Stop sync service
docker compose --profile sync down
```

---

## Comparison: Syncthing vs rsync

| Feature | rsync | Syncthing |
|---------|-------|-----------|
| Direction | One-way only | Bidirectional ✅ |
| Block-level sync | ❌ | ✅ Efficient |
| Unchanged files | Checks all files | Skips (0 bandwidth) ✅ |
| Conflicts | Overwrites ❌ | Saves both versions ✅ |
| Web UI | ❌ | ✅ Easy management |
| Setup | Simple | Medium |
| Bandwidth | Moderate | Minimal ✅ |
| Real-time | Every 5 mins (rsync) | Instant ✅ |

---

## Troubleshooting

### Syncthing Not Connecting

```bash
# 1. Check it's running
docker compose ps syncthing

# 2. View logs
docker compose logs syncthing

# 3. Restart
docker compose restart syncthing

# 4. Verify device ID shared correctly
# Make sure Device ID format is correct
```

### High Bandwidth Usage

1. Check `.stignore` has temp files listed
2. Verify no large backups in data dir
3. Check "Recent Changes" in Web UI
4. Reduce `maxfolderConcurrency` if saturating connection

### Syncing Too Slow

1. Syncthing limits per-connection speed (safety)
2. Add more remote devices to parallelize
3. Use wired connection (more stable)
4. Check network latency

### File Permissions Issues

```bash
# Syncthing runs as specific user
# If files created as different user, permission mismatch

# Solution: Run as same user
docker compose exec syncthing chown -R syncthing:syncthing /var/syncthing/Sync
```

---

## Production Checklist

- [ ] Syncthing running on host
- [ ] Device ID backed up
- [ ] Secondary laptop added as device
- [ ] FoundryVTT folder shared
- [ ] Laptop syncing initial data
- [ ] Tested conflict resolution
- [ ] Bandwidth monitoring enabled
- [ ] Backups configured (optional)

---

## Advanced: Full Config Example

```bash
# .env configuration for Syncthing

# Syncthing Settings
SYNCTHING_API_KEY=abc1234def5678ghi9012jkl3456

# Optional: Device IDs
SYNCTHING_DEVICE_ID_LAPTOP1=<laptop1-device-id>
SYNCTHING_DEVICE_ID_LAPTOP2=<laptop2-device-id>

# Sync enabled
SYNC_METHOD=syncthing
SYNC_ENABLED=true

# Access Web UI
# http://localhost:8384
```

---

## See Also

- [DATA_PERSISTENCE.md](./DATA_PERSISTENCE.md) - Architecture explained
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Full deployment guide
- [Syncthing Docs](https://docs.syncthing.net/)
- [Syncthing FAQ](https://docs.syncthing.net/users/faq.html)

---

## Next Steps

1. Start Syncthing: `docker compose --profile sync up -d`
2. Open Web UI: http://localhost:8384
3. Add secondary laptop as device
4. Create FoundryVTT folder (Send & Receive)
5. Verify initial sync completes
6. Test bidirectional changes
7. Monitor bandwidth efficiency

**You now have zero-bandwidth sync for unchanged files!** 🚀
