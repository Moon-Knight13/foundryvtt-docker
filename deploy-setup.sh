#!/bin/bash
# Quick deployment setup script
# Initializes environment and prepares for deployment

set -e

echo "🚀 FoundryVTT Docker Deployment Setup"
echo "======================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📋 Creating .env from template..."
    cp .env.example .env
    echo "✅ .env created"
    echo ""
    
    # Function to prompt for environment variable
    prompt_env() {
        local var_name=$1
        local prompt_text=$2
        local is_secret=$3
        local default_value=$4
        
        echo -n "📝 $prompt_text"
        if [ -n "$default_value" ]; then
            echo -n " [default: $default_value]"
        fi
        echo -n ": "
        
        if [ "$is_secret" = "true" ]; then
            read -rs user_input
            echo ""
        else
            read -r user_input
        fi
        
        # Use default if input is empty
        if [ -z "$user_input" ] && [ -n "$default_value" ]; then
            user_input="$default_value"
        fi
        
        # Update .env file if input provided
        if [ -n "$user_input" ]; then
            # Escape special characters for sed
            escaped_value=$(printf '%s\n' "$user_input" | sed -e 's/[\/&]/\\&/g')
            sed -i "s/^$var_name=.*/$var_name=$escaped_value/" .env
        fi
    }
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚡ REQUIRED Configuration"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    prompt_env "FOUNDRY_USERNAME" "FoundryVTT Username" false
    prompt_env "FOUNDRY_PASSWORD" "FoundryVTT Password" true
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🌐 Optional: Remote Access (ngrok)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "For remote access, you'll need an ngrok account:"
    echo "1. Sign up: https://ngrok.com"
    echo "2. Get your auth token from dashboard"
    echo ""
    
    read -p "Do you want to enable ngrok? (y/n) [default: n]: " -r enable_ngrok
    enable_ngrok=${enable_ngrok:-n}
    
    if [[ $enable_ngrok =~ ^[Yy]$ ]]; then
        prompt_env "NGROK_AUTH_TOKEN" "ngrok Auth Token" true
        prompt_env "NGROK_REGION" "ngrok Region (us/eu/ap/au/sa/jp/in)" false "us"
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "💾 Optional: Restore from Remote Backups"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Restore FoundryVTT backups from another laptop via SCP"
    echo "Requires SSH key-based authentication setup"
    echo ""
    
    read -p "Do you want to restore backups from a remote host? (y/n) [default: n]: " -r enable_backup_restore
    enable_backup_restore=${enable_backup_restore:-n}
    
    if [[ $enable_backup_restore =~ ^[Yy]$ ]]; then
        prompt_env "BACKUP_REMOTE_HOST" "Remote host (<user>@<host>)" false
        prompt_env "BACKUP_REMOTE_PATH" "Remote backup path (default: ~/.local/share/FoundryVTT/Backups)" false "$HOME/.local/share/FoundryVTT/Backups"
        prompt_env "BACKUP_SSH_KEY" "SSH key path (default: ~/.ssh/id_rsa)" false "$HOME/.ssh/id_rsa"
        echo ""
        echo "📥 Pulling backups from remote host..."
        backup_host=$(grep "^BACKUP_REMOTE_HOST=" .env | cut -d= -f2)
        backup_path=$(grep "^BACKUP_REMOTE_PATH=" .env | cut -d= -f2)
        backup_key=$(grep "^BACKUP_SSH_KEY=" .env | cut -d= -f2)
        
        mkdir -p data/Backups
        
        if scp -i "$backup_key" -r "$backup_host:$backup_path/" data/Backups/ 2>/dev/null; then
            echo "✅ Backups downloaded successfully"
        else
            echo "⚠️  Could not download backups. Verify SSH key and host are configured."
        fi
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🎮 Optional: GPU Support"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Enable NVIDIA GPU acceleration (requires NVIDIA runtime)"
    echo ""
    
    read -p "Do you want to enable GPU support? (y/n) [default: n]: " -r enable_gpu
    enable_gpu=${enable_gpu:-n}
    
    if [[ $enable_gpu =~ ^[Yy]$ ]]; then
        echo "⚠️  Make sure NVIDIA Docker runtime is installed:"
        echo "   https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
        sed -i "s/^GPU_ENABLED=.*/GPU_ENABLED=true/" .env
    fi
    
    echo ""
else
    echo "✅ .env already exists"
    echo ""
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

echo "✅ Docker is installed"

# Check Docker Compose
if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

echo "✅ Docker Compose is installed"

# Create data directory
if [ ! -d data ]; then
    echo "📁 Creating data directory..."
    mkdir -p data
else
    echo "✅ Data directory exists"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🚀 Next steps:"
echo ""
echo "1. Start the container:"
echo "   docker compose up -d"
echo ""
echo "   Then access at: http://localhost:30000"
echo ""

if grep -q "NGROK_AUTH_TOKEN=" .env && ! grep -q "^NGROK_AUTH_TOKEN=$" .env; then
    echo "2. View ngrok public URL:"
    echo "   docker compose --profile ngrok up -d"
    echo "   docker compose logs ngrok | grep URL"
    echo ""
fi

if grep -q "BACKUP_REMOTE_HOST=" .env && ! grep -q "^BACKUP_REMOTE_HOST=$" .env; then
    echo "2. Restore backups inside container:"
    echo "   docker compose up -d"
    echo "   docker compose exec foundry /bin/bash"
    echo "   # In the container, use FoundryVTT UI to restore from ~/data/Backups"
    echo ""
fi

echo "📖 For more information, see QUICKSTART.md or DEPLOYMENT.md"
echo ""
