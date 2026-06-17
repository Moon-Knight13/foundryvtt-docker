# FoundryVTT Docker Deployment Guide

This guide walks you through deploying FoundryVTT via Docker with support for:
- ✅ Secure credential management (no secrets in repo)
- ✅ Remote access via ngrok
- ✅ Backup restoration from secondary laptops
- ✅ GPU acceleration support

## Quick Start

### 1. Initial Setup

```bash
cp .env.example .env
mkdir -p ~/.local/share/FoundryVTT
```

This will:
- Create `.env` from `.env.example` template
- Create `./data` directory for persistent storage
- Create `~/.local/share/FoundryVTT` directory for optional data mirroring

### 2. Configure Download Access

Edit `.env` and add your FoundryVTT timed URL:

```bash
nano .env
```

Required variables:
- `FOUNDRY_RELEASE_URL`: Timed URL from Foundry license page (Node.js option)

Optional fallback:
- `FOUNDRY_USERNAME`: Your Foundry VTT username
- `FOUNDRY_PASSWORD`: Your Foundry VTT password

Optional:
- `NGROK_AUTH_TOKEN`: For remote access via ngrok
- `FOUNDRY_PORT`: Port mapping (default: 30000)

### 3. Start the Container

**Basic deployment (local access only):**
```bash
docker compose up -d
```

**With ngrok (remote access):**
```bash
docker compose --profile ngrok up -d
```

**With backup restoration from secondary laptop:**
```bash
# Pull full FoundryVTT data manually from your secondary laptop
rsync -avz --progress -e "ssh -i ~/.ssh/id_rsa" user@remote-host:~/.local/share/FoundryVTT/ ~/.local/share/FoundryVTT/

# Ensure compose uses the mirrored Backups directory
# In .env, set:
# FOUNDRY_BACKUPS_PATH=~/.local/share/FoundryVTT/Backups

docker compose up -d
# Then restore via FoundryVTT UI: Setup → Manage Backups
```

## Features & Configuration

### 📊 Data Persistence

**Important**: Understanding how your data persists across deployments.

#### Volume Binding (Single Host)
All FoundryVTT data is stored in `./data` on your host:
- **Container path**: `/data` (inside container)
- **Host path**: `./data` (bound via docker volume)
- **Persistence**: Data survives container restarts ✅
- **Location**: compose.yml lines 16-19

When you make changes in FoundryVTT UI, they're immediately written to `./data`.

#### Backup Restoration (Multi-Host)
Pull full FoundryVTT data from your secondary laptop during setup:
- ✅ Idempotent rsync sync (new/changed files only)
- ✅ Changes made in container persist on host
- ✅ Restored data available via FoundryVTT UI

**Quick start**: See [DATA_PERSISTENCE.md](./DATA_PERSISTENCE.md) for:
- Data persistence explanation
- Backup restoration procedures
- Testing data persistence

### 🌐 Remote Access via ngrok

ngrok creates a public URL for secure remote access without port forwarding.

#### Prerequisites
1. Create free ngrok account: https://ngrok.com
2. Get your auth token from dashboard

#### Setup
```bash
# In .env, set:
NGROK_ENABLED=true
NGROK_AUTH_TOKEN=your_ngrok_auth_token_here
NGROK_REGION=us  # us, eu, ap, au, sa, jp, in
```

#### Start with ngrok
```bash
docker compose --profile ngrok up -d
```

#### Get your public URL
```bash
docker compose logs ngrok | grep URL
# Or visit http://localhost:4040 for the ngrok dashboard
```

### 💾 Backup Restoration from Secondary Laptop

Mirror full FoundryVTT user data from another laptop via rsync over SSH. Simple, bandwidth-efficient, and secure.

#### Quick Start

```bash
# Create local FoundryVTT data directory
mkdir -p ~/.local/share/FoundryVTT

# Mirror data from remote host
rsync -avz --progress -e "ssh -i ~/.ssh/id_rsa" user@remote-host:~/.local/share/FoundryVTT/ ~/.local/share/FoundryVTT/

# In .env, set:
# FOUNDRY_BACKUPS_PATH=~/.local/share/FoundryVTT/Backups

# Start container
docker compose up -d

# Restore in FoundryVTT UI
# Setup → Manage Backups → Restore
```

#### Key Features

- ✅ **Simple**: SSH key-based SCP pull
- ✅ **Bandwidth-efficient**: One-time transfer during setup
- ✅ **Secure**: Uses SSH authentication only
- ✅ **Flexible**: Restore multiple backups or full snapshots
- ✅ **No overhead**: No continuous sync running

#### Full Setup Guide

See **[BACKUP_RESTORE.md](./BACKUP_RESTORE.md)** for:
- SSH key configuration
- Manual backup pulling
- Step-by-step restoration
- Backup structure explanation
- Troubleshooting

#### Manual Backup Pull

If backups weren't pulled during setup:

```bash
# Create local FoundryVTT data directory
mkdir -p ~/.local/share/FoundryVTT

# Sync full FoundryVTT data via rsync
rsync -avz --progress -e "ssh -i ~/.ssh/id_rsa" user@remote-host:~/.local/share/FoundryVTT/ ~/.local/share/FoundryVTT/

# In .env, set:
# FOUNDRY_BACKUPS_PATH=~/.local/share/FoundryVTT/Backups
```

#### Backup Restoration Steps

1. Backups are available at `/data/Backups` in the container
2. Use FoundryVTT **Setup** → **Manage Backups** to restore
3. Select backup type (World, System, Module, or Snapshot)
4. Click **Restore Latest** or select a specific backup to restore
5. Wait for restoration to complete (may take several minutes)

### 🎮 GPU Support

Enable NVIDIA GPU acceleration for better performance.

#### Prerequisites
- NVIDIA GPU installed
- NVIDIA Docker runtime: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/

#### Installation (Ubuntu/Debian)
```bash
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update && sudo apt-get install -y nvidia-docker2
sudo systemctl restart docker
```

#### Enable GPU in compose.yml

Uncomment the GPU section in `compose.yml`:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

Or use environment variable:
```bash
GPU_ENABLED=true
```

#### Verify GPU
```bash
docker compose exec foundry nvidia-smi
```

## Environment Variables Reference

```bash
# Preferred download method
FOUNDRY_RELEASE_URL=https://your-timed-url-here

# Optional fallback credentials
FOUNDRY_USERNAME=
FOUNDRY_PASSWORD=

# Container
FOUNDRY_ADMIN_KEY=atropos
FOUNDRY_VERSION=14.363
FOUNDRY_TELEMETRY=false
FOUNDRY_PORT=30000

# ngrok
NGROK_AUTH_TOKEN=your_token
NGROK_REGION=us

# File Sync
SYNC_SOURCE_DIR=user@host:/path
SYNC_INTERVAL=300

# GPU
GPU_ENABLED=false

# Performance
CONTAINER_CACHE=/data/container_cache
CONTAINER_VERBOSE=false
```

## Common Commands

```bash
# View logs
docker compose logs -f foundry

# Stop container
docker compose down

# Restart
docker compose restart

# Check status
docker compose ps

# View ngrok stats
curl http://localhost:4040/api/tunnels

# Manual sync trigger
docker compose exec file-sync /root/entrypoint.sh
```

## Troubleshooting

### FoundryVTT won't start
- Check logs: `docker compose logs foundry`
- Verify `FOUNDRY_RELEASE_URL` in `.env` (or valid fallback credentials)
- Ensure port 30000 is not in use

### ngrok not connecting
- Verify NGROK_AUTH_TOKEN in `.env`
- Check ngrok dashboard for errors: http://localhost:4040
- Try different NGROK_REGION

### File sync not working
- Check SSH key permissions: `chmod 600 ~/.ssh/foundry_sync`
- Test rsync manually: `rsync -avz <remote-user>@<remote-host>:/path ./data/`
- Check logs: `docker compose logs file-sync`

### GPU not detected
- Run: `docker run --rm --gpus all nvidia/cuda:11.0-runtime nvidia-smi`
- Check NVIDIA runtime: `docker info | grep nvidia`

## Security Considerations

1. **Never commit `.env`** - It's already in `.gitignore`
2. **SSH keys** - Use `~/.ssh` mount with read-only permissions
3. **ngrok token** - Rotate if accidentally exposed
4. **Firewall** - Restrict access to port 30000 if not using ngrok
5. **SSL/TLS** - Configure `FOUNDRY_SSL_CERT` and `FOUNDRY_SSL_KEY` for production

## Production Deployment

For production, consider:

1. Use managed secrets (Docker Secrets, HashiCorp Vault)
2. Enable SSL/TLS with valid certificates
3. Use Watchtower for automatic updates
4. Set up regular backups of `/data` directory
5. Configure resource limits in compose.yml
6. Use health checks (already configured)

## Support & Resources

- FoundryVTT Docs: https://foundryvtt.com/
- Container Image: https://ghcr.io/felddy/foundryvtt
- Original Repository: https://github.com/felddy/foundryvtt-docker
- ngrok Docs: https://ngrok.com/docs
