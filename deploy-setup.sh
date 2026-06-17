#!/bin/bash
# Quick deployment setup script
# Initializes environment and prepares for deployment

set -e

# Get environment variable value from .env
get_env_value() {
    local var_name=$1
    grep -E "^${var_name}=" .env | head -n1 | cut -d= -f2-
}

# Set or append environment variable in .env
set_env_value() {
    local var_name=$1
    local var_value=$2
    local escaped_value
    escaped_value=$(printf '%s\n' "$var_value" | sed -e 's/[\/&]/\\&/g')

    if grep -qE "^${var_name}=" .env; then
        sed -i "s/^${var_name}=.*/${var_name}=${escaped_value}/" .env
    else
        echo "${var_name}=${var_value}" >> .env
    fi
}

# Function to prompt for environment variable
prompt_env() {
    local var_name=$1
    local prompt_text=$2
    local is_secret=$3
    local default_value=${4-}

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
        set_env_value "$var_name" "$user_input"
    fi
}

normalize_foundry_root_path() {
    local path=$1
    local normalized

    normalized=${path%/}
    if [[ "$normalized" == */Backups ]]; then
        normalized=${normalized%/Backups}
    fi

    echo "$normalized"
}

ensure_foundry_auth() {
    local foundry_user
    local foundry_pass
    local release_url

    foundry_user=$(get_env_value "FOUNDRY_USERNAME")
    foundry_pass=$(get_env_value "FOUNDRY_PASSWORD")
    release_url=$(get_env_value "FOUNDRY_RELEASE_URL")

    if [ -z "$release_url" ] || [ "$release_url" = "https://your-timed-url-here" ]; then
        if [ -z "$foundry_user" ] || [ "$foundry_user" = "your_foundry_username" ] || [ -z "$foundry_pass" ] || [ "$foundry_pass" = "your_foundry_password" ]; then
            echo "⚠️  Missing Foundry download configuration"
            echo "Set either FOUNDRY_RELEASE_URL (recommended) or username/password."
            prompt_env "FOUNDRY_RELEASE_URL" "FoundryVTT Timed URL (leave blank to use credentials)" false
            release_url=$(get_env_value "FOUNDRY_RELEASE_URL")
        fi

        if [ -z "$release_url" ] || [ "$release_url" = "https://your-timed-url-here" ]; then
            if [ -z "$foundry_user" ] || [ "$foundry_user" = "your_foundry_username" ]; then
                echo "⚠️  FOUNDRY_USERNAME is missing"
                prompt_env "FOUNDRY_USERNAME" "FoundryVTT Username" false
            fi

            if [ -z "$foundry_pass" ] || [ "$foundry_pass" = "your_foundry_password" ]; then
                echo "⚠️  FOUNDRY_PASSWORD is missing"
                prompt_env "FOUNDRY_PASSWORD" "FoundryVTT Password" true
            fi
        fi
    fi
}

ensure_foundry_admin_key() {
    local admin_key

    admin_key=$(get_env_value "FOUNDRY_ADMIN_KEY")
    if [ -z "$admin_key" ] || [ "$admin_key" = "atropos" ]; then
        echo "⚠️  FOUNDRY_ADMIN_KEY is missing"
        prompt_env "FOUNDRY_ADMIN_KEY" "Foundry admin key" true
    fi
}

configure_backup_restore() {
    local existing_host
    local existing_user
    local existing_ip
    local default_user
    local default_ip
    local default_path
    local default_local_path
    local default_key
    local backup_user
    local backup_ip
    local backup_path
    local backup_key
    local backup_local_path
    local expanded_key
    local expanded_local_path
    local normalized_local_path
    local key_confirm
    local install_confirm

    if ! command -v rsync &> /dev/null; then
        echo "⚠️  rsync is required for idempotent backup sync and is not installed."
        echo "Install it, then rerun backup restore setup."
        echo "  Debian/Ubuntu: sudo apt-get install -y rsync"
        echo "  Fedora/RHEL:   sudo dnf install -y rsync"
        echo "  Arch:          sudo pacman -S rsync"
        read -p "Install rsync now and continue? (y/n) [default: y]: " -r install_confirm
        install_confirm=${install_confirm:-y}
        if [[ ! $install_confirm =~ ^[Yy]$ ]]; then
            echo "⏭️  Skipping backup restore configuration."
            return 0
        fi
        if ! command -v rsync &> /dev/null; then
            echo "❌ rsync is still not available. Install it and run setup again."
            return 0
        fi
    fi

    existing_host=$(get_env_value "BACKUP_REMOTE_HOST")
    existing_user=$(get_env_value "BACKUP_REMOTE_USER")
    existing_ip=$(get_env_value "BACKUP_REMOTE_IP")

    if [ -z "$existing_user" ] && [[ "$existing_host" == *"@"* ]]; then
        existing_user=${existing_host%@*}
    fi
    if [ -z "$existing_ip" ] && [[ "$existing_host" == *"@"* ]]; then
        existing_ip=${existing_host#*@}
    fi

    default_user=${existing_user:-$USER}
    default_ip=${existing_ip:-}
    default_path=$(get_env_value "BACKUP_REMOTE_PATH")
    default_path=${default_path:-$HOME/.local/share/FoundryVTT}
    default_path=$(normalize_foundry_root_path "$default_path")
    default_local_path=$(get_env_value "BACKUP_LOCAL_PATH")
    default_local_path=${default_local_path:-$default_path}
    default_local_path=$(normalize_foundry_root_path "$default_local_path")
    default_key=$(get_env_value "BACKUP_SSH_KEY")
    default_key=${default_key:-$HOME/.ssh/witcher}

    prompt_env "BACKUP_REMOTE_USER" "Remote SSH username" false "$default_user"
    prompt_env "BACKUP_REMOTE_IP" "Remote host or IP" false "$default_ip"
    prompt_env "BACKUP_REMOTE_PATH" "Remote FoundryVTT data path" false "$default_path"
    prompt_env "BACKUP_LOCAL_PATH" "Local FoundryVTT mirror path" false "$default_local_path"

    while true; do
        prompt_env "BACKUP_SSH_KEY" "SSH key path" false "$default_key"
        backup_key=$(get_env_value "BACKUP_SSH_KEY")
        expanded_key=${backup_key/#\~/$HOME}

        if [ ! -f "$expanded_key" ]; then
            echo "⚠️  SSH key file not found: $expanded_key"
            read -p "Try a different SSH key path? (y/n) [default: y]: " -r key_confirm
            key_confirm=${key_confirm:-y}
            if [[ ! $key_confirm =~ ^[Yy]$ ]]; then
                break
            fi
            continue
        fi

        read -p "Use SSH key $expanded_key ? (y/n) [default: y]: " -r key_confirm
        key_confirm=${key_confirm:-y}
        if [[ $key_confirm =~ ^[Yy]$ ]]; then
            break
        fi
    done

    backup_user=$(get_env_value "BACKUP_REMOTE_USER")
    backup_ip=$(get_env_value "BACKUP_REMOTE_IP")
    backup_path=$(get_env_value "BACKUP_REMOTE_PATH")
    backup_path=$(normalize_foundry_root_path "$backup_path")
    backup_key=$(get_env_value "BACKUP_SSH_KEY")
    backup_local_path=$(get_env_value "BACKUP_LOCAL_PATH")
    backup_local_path=${backup_local_path:-$backup_path}
    backup_local_path=$(normalize_foundry_root_path "$backup_local_path")
    expanded_key=${backup_key/#\~/$HOME}
    expanded_local_path=${backup_local_path/#\~/$HOME}
    normalized_local_path=${expanded_local_path%/}

    set_env_value "BACKUP_REMOTE_HOST" "${backup_user}@${backup_ip}"
    set_env_value "BACKUP_REMOTE_PATH" "$backup_path"
    set_env_value "BACKUP_LOCAL_PATH" "$backup_local_path"
    set_env_value "FOUNDRY_BACKUPS_PATH" "$normalized_local_path/Backups"

    echo ""
    echo "📥 Syncing FoundryVTT data from remote host with rsync..."
    mkdir -p "$expanded_local_path"

    if rsync -avz --progress -e "ssh -i $expanded_key" "${backup_user}@${backup_ip}:$backup_path/" "$expanded_local_path/"; then
        echo "✅ FoundryVTT data synced successfully"
        echo "📁 Local data mirror path: $expanded_local_path"
        echo "📁 Container backups mount path: $normalized_local_path/Backups"
    else
        echo "⚠️  Could not sync data. Verify SSH user, host/IP, key, and path are correct."
    fi
}

echo "🚀 FoundryVTT Docker Deployment Setup"
echo "======================================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📋 Creating .env from template..."
    cp .env.example .env
    echo "✅ .env created"
    echo ""
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚡ REQUIRED Configuration"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Choose one download method: timed URL (recommended) or account credentials."
    echo ""
    
    prompt_env "FOUNDRY_RELEASE_URL" "FoundryVTT Timed URL (leave blank to use credentials)" false

    release_url=$(get_env_value "FOUNDRY_RELEASE_URL")
    if [ -z "$release_url" ] || [ "$release_url" = "https://your-timed-url-here" ]; then
        prompt_env "FOUNDRY_USERNAME" "FoundryVTT Username" false
        prompt_env "FOUNDRY_PASSWORD" "FoundryVTT Password" true
    fi

    prompt_env "FOUNDRY_ADMIN_KEY" "Foundry admin key" true
    
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
        configure_backup_restore
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

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚡ Validating required Foundry settings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ensure_foundry_auth
ensure_foundry_admin_key
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💾 Optional: Configure/Run Backup Restore"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
read -p "Do you want to configure or run remote backup restore now? (y/n) [default: n]: " -r run_backup_restore
run_backup_restore=${run_backup_restore:-n}

if [[ $run_backup_restore =~ ^[Yy]$ ]]; then
    configure_backup_restore
fi
echo ""

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
    echo "   # In the container, use FoundryVTT UI to restore from /data/Backups"
    echo ""
fi

echo "📖 For more information, see QUICKSTART.md or DEPLOYMENT.md"
echo ""
