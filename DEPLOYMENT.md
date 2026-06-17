# FoundryVTT Docker Deployment Guide

This guide walks you through deploying FoundryVTT via Docker with support for:
- ✅ Secure credential management (no secrets in repo)
- ✅ Remote access via ngrok
- ✅ User file synchronization from secondary laptops
- ✅ GPU acceleration support

## Quick Start

### 1. Initial Setup

```bash
./deploy-setup.sh
```

This will:
- Create `.env` from `.env.example` template
- Create `./data` directory for persistent storage
- Verify Docker and Docker Compose installation

### 2. Configure Credentials

Edit `.env` and add your FoundryVTT credentials:

```bash
nano .env
```

Required variables:
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

**With file sync from secondary laptop:**
```bash
SYNC_SOURCE_DIR=<remote-user>@<remote-host>:/path/to/data docker compose --profile sync up -d
```

## Features & Configuration

### 📊 Data Persistence & Synchronization

**Important**: Understanding how your data persists across deployments.

#### Volume Binding (Single Host)
All FoundryVTT data is stored in `./data` on your host:
- **Container path**: `/data` (inside container)
- **Host path**: `./data` (bound via docker volume)
- **Persistence**: Data survives container restarts ✅
- **Location**: compose.yml lines 16-19

When you make changes in FoundryVTT UI, they're immediately written to `./data`.

#### File Sync (Multi-Host)
The current sync service uses one-way rsync (laptop → host):
- ⚠️ Changes made on the host DO NOT sync back to your laptop
- ⚠️ The `--delete` flag means host-only changes will be removed on next sync!

**Recommendation**: See [DATA_PERSISTENCE.md](./DATA_PERSISTENCE.md) for:
- 3 recommended sync strategies
- How to test persistence
- Bidirectional sync setup with Syncthing

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

### 📁 File Synchronization (Syncthing - Bidirectional)

Syncthing provides **bidirectional**, **bandwidth-efficient** synchronization. Only changed blocks transfer - unchanged files use zero bandwidth.

#### Quick Start

```bash
# Generate API key
SYNCTHING_API_KEY=$(openssl rand -hex 16)

# Start Syncthing
docker compose --profile sync up -d

# Open Web UI
# http://localhost:8384
```

#### Key Features

- ✅ **Bidirectional**: Changes sync both ways
- ✅ **Bandwidth-efficient**: Only changed blocks transfer
- ✅ **Instant**: Real-time syncing (not periodic)
- ✅ **Conflict-safe**: Both versions saved if conflict
- ✅ **Web UI**: Easy management at http://localhost:8384

#### Full Setup Guide

See **[SYNCTHING_SETUP.md](./SYNCTHING_SETUP.md)** for:
- Complete step-by-step setup
- Adding secondary laptop
- Bandwidth optimization tests
- Conflict resolution
- Troubleshooting

#### Quick Reference

```bash
# Stop sync service
docker compose --profile sync down

# View Syncthing logs
docker compose logs -f syncthing

# Restart sync
docker compose restart syncthing

# Get Syncthing status
curl -s http://localhost:8384/api/system/status | jq
```

#### SSH Key Setup (for rsync service)

For passwordless sync, set up SSH keys:

```bash
# On secondary laptop
ssh-keygen -t ed25519 -f ~/.ssh/foundry_sync

# Copy public key to hosting PC
ssh-copy-id -i ~/.ssh/foundry_sync.pub <remote-user>@<remote-host>
```

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
# Credentials
FOUNDRY_USERNAME=your_username
FOUNDRY_PASSWORD=your_password
FOUNDRY_RELEASE_URL=  # Optional: pre-signed URL

# Container
FOUNDRY_ADMIN_KEY=atropos
FOUNDRY_VERSION=14.363
FOUNDRY_TELEMETRY=true
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
- Verify credentials in `.env`
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
