#!/bin/bash
# Quick deployment setup script
# Initializes environment and prepares for deployment

set -e

# Get environment variable value from .env (shared helper)
# shellcheck source=scripts/lib/env-file.sh disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/scripts/lib/env-file.sh"

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
  echo "🌐 Optional: Remote Access (Cloudflare Tunnel)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "For remote access with no inbound ports, you'll need a Cloudflare"
  echo "account and a domain on Cloudflare:"
  echo "1. Zero Trust dashboard -> Networks -> Tunnels -> Create a tunnel"
  echo "2. Copy the tunnel token; route your hostname (e.g. vtt.example.com)"
  echo "   to the tunnel with service http://foundry:30000"
  echo ""

  read -p "Do you want to enable a Cloudflare Tunnel? (y/n) [default: n]: " -r enable_cf
  enable_cf=${enable_cf:-n}

  if [[ $enable_cf =~ ^[Yy]$ ]]; then
    prompt_env "CF_TUNNEL_TOKEN" "Cloudflare Tunnel Token" true
    prompt_env "FOUNDRY_HOSTNAME" "Public tunnel hostname (e.g. vtt.example.com)" false
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

if grep -q "CF_TUNNEL_TOKEN=" .env && ! grep -q "^CF_TUNNEL_TOKEN=$" .env; then
  echo "2. Start with the Cloudflare Tunnel:"
  echo "   docker compose -f compose.yml -f compose.cloudflare.yml up -d"
  echo "   Then access at your configured hostname over HTTPS."
  echo ""
fi

echo "📖 For more information, see README.md or DEPLOYMENT.md"
echo ""
