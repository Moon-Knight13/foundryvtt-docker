# Quick Start Guide - Secure, Deployable FoundryVTT Docker Setup

## 📋 What's New

This fork adds critical production-ready features to the FoundryVTT Docker deployment:

✅ **No sensitive credentials in repo** - Uses `.env` file (excluded from git)
✅ **Remote hosting via ngrok** - Public URL for players anywhere
✅ **File sync from secondary laptops** - Sync worlds and user data
✅ **GPU acceleration support** - Efficient resource utilization

## 🚀 Quick Start (2 minutes)

### 1. Clone & Setup

```bash
git clone https://github.com/Moon-Knight13/foundryvtt-docker.git
cd foundryvtt-docker
./deploy-setup.sh
```

### 2. Add Your Credentials

```bash
# Edit .env with your FoundryVTT login
nano .env
```

Set these required values:
- `FOUNDRY_USERNAME`
- `FOUNDRY_PASSWORD`

### 3. Start Container

```bash
docker compose up -d
```

Access at: `http://localhost:30000`

---

## 🌐 Enable Remote Access (ngrok)

### Prerequisites
1. Create free account: https://ngrok.com
2. Get auth token from dashboard

### Setup
```bash
# Edit .env
NGROK_AUTH_TOKEN=your_token_here

# Start with ngrok
docker compose --profile ngrok up -d

# Get public URL
docker compose logs ngrok | grep URL
```

**Players can now access from anywhere!**

---

## 📁 Sync Files from Secondary Laptop

### Quick One-Time Sync

```bash
./sync-user-files.sh <remote-user>@<remote-host>:/path/to/foundry/data
```

### Continuous Auto-Sync

```bash
# In .env, set your remote:
SYNC_SOURCE_DIR=<remote-user>@<remote-host>:/path/to/foundry/data

# Start with sync service:
docker compose --profile sync up -d
```

**Your worlds sync automatically every 5 minutes!**

---

## 🎮 Enable GPU Acceleration

### Install NVIDIA Runtime

```bash
# Ubuntu/Debian
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-docker.list
sudo apt-get update && sudo apt-get install -y nvidia-docker2
sudo systemctl restart docker
```

### Enable GPU in compose.yml

Uncomment in `compose.yml`:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

Or set in `.env`:
```bash
GPU_ENABLED=true
```

Restart: `docker compose down && docker compose up -d`

---

## 📚 Full Documentation

See [DEPLOYMENT.md](./DEPLOYMENT.md) for:
- Advanced configuration options
- Troubleshooting guide
- Production deployment checklist
- Security best practices
- All environment variables reference

## 🛠️ Common Commands

```bash
# View logs
docker compose logs -f foundry

# Stop everything
docker compose down

# Restart
docker compose restart

# Check status
docker compose ps

# View ngrok dashboard
# Open: http://localhost:4040
```

## 🔒 Security Notes

- ✅ Credentials never committed (`.env` in `.gitignore`)
- ✅ SSH keys isolated in volume mount
- ✅ ngrok provides encrypted tunnel
- ⚠️ Rotate ngrok token if exposed
- ⚠️ Use firewall to restrict access

## 📖 Resources

- [Full Deployment Guide](./DEPLOYMENT.md)
- [FoundryVTT Docs](https://foundryvtt.com/)
- [Original Container Image](https://github.com/felddy/foundryvtt-docker)
- [ngrok Documentation](https://ngrok.com/docs)

---

**Questions?** Check [DEPLOYMENT.md](./DEPLOYMENT.md) or submit an issue!
