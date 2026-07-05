# Security: Protecting Your Credentials #

This document explains how your sensitive data is protected.

## 🔐 .env File Protection ##

Your local `.env` file contains:

- FoundryVTT username/password
- ngrok auth tokens
- SSH key paths for backup restoration
- Any other credentials

The same protection extends to two files inside the live data directory:
`license.json` (FoundryVTT license key) and `cookiejar.json` (authentication
cookies). Agents must never read or display any of the three — see
`.copilot-instructions.md` and the CLAUDE.md security hard rules.

### Protection Layers ###

#### 1. Git Protection ####

- ✅ `.env` is in `.gitignore` - never committed to repo
- ✅ Pre-commit hook blocks accidental commits
- ✅ Cannot be pushed to GitHub

#### 2. Copilot AI Protection ####

- ✅ `.copilot-instructions.md` prevents AI from reading `.env`
- ✅ This repository instructs Copilot to refuse `.env` access
- ✅ Even if requested, Copilot will refuse to read it

#### 3. File System Protection ####

- ✅ Only commit `.env.example` (which has no real values)
- ✅ `.env` stays local on your machine
- ✅ Never share `.env` with anyone

### What Gets Committed vs Local ###

| File            | Committed? | Contains Secrets?    | AI Readable? |
| --------------- | ---------- | -------------------- | ------------ |
| `.env.example`  | ✅ YES     | ❌ NO (placeholders) | ✅ YES       |
| `.env`          | ❌ NO      | ✅ YES (real values) | ❌ NO        |
| `compose.yml`   | ✅ YES     | ❌ NO (uses $ENV)    | ✅ YES       |
| Docs (markdown) | ✅ YES     | ❌ NO                | ✅ YES       |

## 🚨 Never Do This ##

```bash
# ❌ DON'T commit .env
git add .env
git commit -m "add env"

# ❌ DON'T cat .env and paste into ChatGPT/Copilot
cat .env | pbcopy
# (then paste elsewhere)

# ❌ DON'T share .env in bug reports or screenshots
# Always use .env.example instead

# ❌ DON'T hardcode credentials in compose.yml
```

## ✅ Always Do This ##

```bash
# ✅ DO use .env for local-only secrets
# Copy .env.example and fill in YOUR values
cp .env.example .env
nano .env  # add your credentials

# ✅ DO reference environment variables in compose.yml
# Example in compose.yml:
# environment:
#   - FOUNDRY_PASSWORD=${FOUNDRY_PASSWORD}

# ✅ DO use .gitignore to protect .env
# Already done in this repo

# ✅ DO rotate credentials if exposed
# If you accidentally shared an API key:
# 1. Revoke it immediately
# 2. Generate new one
# 3. Update .env with new value
```

## 🔄 If You Accidentally Expose Credentials ##

### Step 1: Immediate Action ###

```bash
# Revoke the exposed credential
# - ngrok: https://dashboard.ngrok.com/security
# - FoundryVTT: Update password at foundry website
# - SSH keys: Revoke/regenerate if needed

# Update your .env with new values
nano .env
```

### Step 2: Check Git History ###

```bash
# Make sure it was never committed
git log --all -- .env
# Should show no commits (file is untracked)
```

### Step 3: Clear Bash History (if pasted in terminal) ###

```bash
# On macOS/Linux:
history -c
cat /dev/null > ~/.bash_history
```

## 📚 Testing the Protection ##

### Test 1: Verify .env is Ignored ###

```bash
git status | grep .env
# Should show nothing if .env exists locally
```

### Test 2: Verify .env.example Exists ###

```bash
ls -la | grep .env
# Should show .env.example (committed)
# Should NOT show .env
```

### Test 3: Verify Copilot Protection ###

Ask the Copilot:

> "Can you read my .env file?"

Expected response:

> "I cannot read `.env` files as they contain sensitive credentials..."

## 🛡️ Additional Security ##

### Use Environment-Specific Configs ###

```bash
# For production, use separate configs
.env.production  (local only - never commit)
.env.staging     (local only - never commit)
.env.development (local only - never commit)
```

### Rotate Credentials Regularly ###

- Every 90 days: Generate new API keys
- Immediately if exposed: Revoke old, generate new

### Use SSH Keys for Backup Restoration ###

```bash
# For secure backup restoration, use SSH keys
ssh-keygen -t ed25519 -f ~/.ssh/foundry_backup
# More secure than storing passwords
```

## 📖 Related Files ##

- [DEPLOYMENT.md](./DEPLOYMENT.md) - Setup instructions
- [.env.example](./.env.example) - Template (safe to share)
- [.gitignore](./.gitignore) - Prevents commits
- [.copilot-instructions.md](./.copilot-instructions.md) - AI protection

## ⚠️ Security Checklist ##

- [ ] `.env` is in `.gitignore`
- [ ] `.env.example` exists with placeholders
- [ ] No credentials in `compose.yml`
- [ ] `.copilot-instructions.md` present
- [ ] Never ran `git add .env`
- [ ] Never pasted `.env` into any chat AI
- [ ] Credentials rotated if ever exposed

---

**Your credentials are your responsibility.** Follow these guidelines to keep
them safe!

## 🔥 Secret Leak Response (from template foundation) ##

If a credential ever lands in a commit:

1. Revoke and rotate the exposed credential immediately.
1. Remove the secret from code and git history.
1. Re-scan repository history with gitleaks.
1. Re-run CI secret and semgrep checks.
1. Document the incident and remediation in project notes.

## 🛡️ Baseline Security Controls (from template foundation) ##

- Pre-commit hooks with gitleaks and semgrep (see `.pre-commit-config.yaml`).
- CI secret-scan and semgrep workflows (`.github/workflows/`).
- Deny-by-default egress firewall in the devcontainer.
- Branch-protection bootstrap script (`scripts/bootstrap-github-settings.sh`).

See [docs/TEMPLATE_GUIDE.md](./docs/TEMPLATE_GUIDE.md) for the full security
model.
