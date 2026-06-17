# Data Persistence & Synchronization Architecture

## Quick Answer

**YES, data persists!** And we now have **bidirectional sync** with Syncthing!

- ✅ **Host Persistence**: Changes in container → persist on host (`./data` directory)
- ✅ **Restart Persistence**: Container stops/restarts → all data still there
- ✅ **Sync Direction**: **BIDIRECTIONAL** (host ↔ laptop both ways)
- ✅ **Bandwidth**: Only changed blocks sync (unchanged files = 0 bandwidth)
- ✅ **Push Back**: Changes on host automatically sync to laptop

---

## UPDATE: Syncthing Now Implemented ✨

We've replaced the old one-way rsync with **Syncthing** for:
- ✅ Bidirectional syncing
- ✅ Block-level efficiency (unchanged files never retransmit)
- ✅ Real-time synchronization
- ✅ Conflict resolution
- ✅ Web UI management

See [SYNCTHING_SETUP.md](./SYNCTHING_SETUP.md) for complete setup guide.

---

## Data Flow Architecture

### Scenario 1: Single Host Deployment

```
┌──────────────────────────────────┐
│     Secondary Laptop (Optional)  │
└──────────────────────────────────┘

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

**Result**: ✅ Data persists perfectly on single host

---

### Scenario 2: Multi-Host with File Sync

```
┌──────────────────────────────────┐
│  Secondary Laptop                │
│  ~/.foundry/data/                │
│  (worlds, modules, etc)          │
└──────────────────────────────────┘
         ↑ (pull, one-way)
         │ rsync
         │
┌──────────────────────────────────┐
│     Hosting PC                   │
│  ┌────────────────────────────┐  │
│  │ Docker Container           │  │
│  │ /data (reads worlds)       │  │
│  └────────────────────────────┘  │
│         ↓ Volume Mount            │
│  ┌────────────────────────────┐  │
│  │ ./data (host filesystem)   │  │
│  │ ← synced from laptop       │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘

Flow:
1. Initial: rsync pulls from laptop → host ./data
2. FoundryVTT reads from container /data
3. You create new worlds in FoundryVTT
4. Changes written to ./data on host
5. BUT: Changes NOT synced back to laptop ⚠️
```

**Problem**: ⚠️ New changes on host don't sync BACK to laptop

---

## Current Sync Behavior (One-Way)

### Pull Direction: Laptop → Host

```bash
# Current rsync command
rsync -av --delete "$SYNC_SOURCE_DIR" "$SYNC_DEST_DIR/"
```

**What this does**:
- Pulls from: `user@laptop:/path/to/data/*`
- Pushes to: `./data/` on host
- Direction: **Laptop ONLY source of truth** (--delete removes local changes!)
- Interval: Every 300 seconds (5 minutes)

**Important**: The `--delete` flag means:
- If you create a world on the host
- And it's not on the laptop
- It WILL BE DELETED on the next sync!

---

## Data Persistence: YES ✅

### On Single Host (no sync)

```bash
# Make changes in FoundryVTT UI
# Container persists to /data
# Which is mounted to ./data

# Even if you stop container:
docker compose down

# All data is in ./data (not lost)

# Restart:
docker compose up -d
# Data is all there!
```

---

## Sync Bidirectionality: NO ❌ (Currently)

### Changes Made in Container DON'T Sync Back

```
1. Initial state:
   Laptop has: World A, World B
   Host ./data has: World A, World B (synced)

2. You create in FoundryVTT UI:
   Host container /data has: World A, World B, World C (NEW)

3. After 5 minutes:
   ❌ Laptop still has: World A, World B
   ✅ Host still has: World A, World B, World C

4. If laptop syncs again:
   ⚠️ Host ./data becomes: World A, World B (World C deleted!)
```

---

## Recommended Solutions

### Option 1: Read-Only Sync (Safest)

**Use case**: Laptop is source of truth, host reads only

```bash
# Deploy on host with rsync (current setup)
# Never make changes in FoundryVTT UI on host
# All edits on laptop, sync to host
```

**Pros**:
- ✅ Data consistency guaranteed
- ✅ Laptop is single source of truth
- ✅ No conflicts

**Cons**:
- ❌ Can't modify campaigns on host directly
- ❌ All changes must go back to laptop

---

### Option 2: Bidirectional Sync with Syncthing

**Use case**: Changes on either device sync to both

Replace current rsync with Syncthing service:

```yaml
syncthing:
  image: syncthing/syncthing
  profiles: ["sync"]
  volumes:
    - ./data:/var/syncthing/Sync
  environment:
    - STGUIAPIKEY=your_api_key
  ports:
    - "8384:8384"
    - "22000:22000/tcp"
    - "22000:22000/udp"
```

**Pros**:
- ✅ Bidirectional sync
- ✅ Changes sync both ways
- ✅ Conflict resolution available

**Cons**:
- ⚠️ More complex setup
- ⚠️ Need to configure on both devices

---

### Option 3: Use Laptop as Backup Only

**Use case**: Host is primary, laptop syncs for backup

```bash
# Initial setup:
# 1. Start container on host
# 2. Make all changes in container
# 3. Periodically pull backup from host:
./sync-user-files.sh user@host:/path/to/data
```

**Pros**:
- ✅ Host is full working copy
- ✅ Laptop acts as rolling backup
- ✅ No sync conflicts

**Cons**:
- ⚠️ Manual backup process
- ⚠️ No automatic sync

---

## How to Test Data Persistence

### Test 1: Single Host Persistence

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

### Test 2: Sync Behavior

```bash
# 1. Start with sync enabled
SYNC_SOURCE_DIR=user@laptop:/foundry/data \
docker compose --profile sync up -d

# 2. Create world in FoundryVTT
# (on the host container)

# 3. Check it exists locally
ls -la ./data/worlds/

# 4. Check logs to understand sync
docker compose logs file-sync

# 5. Stop and restart laptop sync
# 6. Check if world still exists
# ⚠️ May be deleted if --delete was used!
```

---

## Architecture Recommendation

For your use case (two laptops + host):

### Best Practice: Host as Primary

```
┌─────────────────────────────────────┐
│ Hosting PC (Primary)                │
│ ├─ FoundryVTT Container (live)      │
│ └─ ./data/ (persistent)             │
└─────────────────────────────────────┘
        ↑ rsync (pull on startup)
        │
┌─────────────────────────────────────┐
│ Secondary Laptop                    │
│ └─ ~/foundry-backup/ (mirror)       │
│    (synced from host, not used)     │
└─────────────────────────────────────┘
```

**Setup**:
```bash
# On host, no sync service needed
docker compose up -d

# Periodically backup from laptop:
./sync-user-files.sh user@host:/path/to/data

# Or add to cron for daily backup:
0 2 * * * cd ~/foundry-docker && ./sync-user-files.sh user@host:/foundry/data
```

---

## Summary Table

| Feature | Single Host | With Sync | Recommended |
|---------|------------|-----------|------------|
| Container changes persist | ✅ YES | ✅ YES | ✅ |
| Survives container restart | ✅ YES | ✅ YES | ✅ |
| Survives host restart | ✅ YES | ✅ YES | ✅ |
| Changes sync to laptop | ❌ NO | ⚠️ One-way only | ❌ |
| Laptop changes sync to host | ❌ NO | ✅ YES | ⚠️ |
| Bidirectional sync | ❌ NO | ❌ NO | Use Syncthing |

---

## Next Steps

Choose your sync strategy:

1. **No sync** (safest)
   - Host is isolated, no laptop sync
   - Full persistence guaranteed
   - Manual backups only

2. **One-way sync** (current setup)
   - Laptop → Host
   - Don't modify on host directly
   - Risk of losing host-made changes

3. **Use Syncthing** (most flexible)
   - Bidirectional sync
   - More complex setup
   - See DEPLOYMENT.md for details

Would you like me to implement bidirectional sync with Syncthing?
