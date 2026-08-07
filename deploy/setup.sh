#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# LiveChat — one-shot Ubuntu VPS deploy (Hostinger VPS, Hetzner,
# DigitalOcean, Contabo ... koi bhi Ubuntu 22.04/24.04 VPS)
#
# Pehle project VPS par le aayein (git clone ya scp), phir:
#   cd livechat
#   sudo bash deploy/setup.sh chat.aapkadomain.com
#
# Yeh script:
#   1. Node.js 22 + MariaDB + Caddy + PM2 install karta hai
#   2. Database + strong passwords banata hai
#   3. .env likhta hai, widget/dashboard build karta hai
#   4. PM2 se server chalata hai (reboot par khud start)
#   5. Caddy se HTTPS + domain wire karta hai (free SSL)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash deploy/setup.sh <domain>   (e.g. chat.example.com)"
  echo "Note: domain ka A-record pehle is VPS ke IP par point karein."
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo."; exit 1; fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> Project: $REPO_DIR"
echo "==> Domain:  https://$DOMAIN"

# ── 1. Base packages ─────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ufw ca-certificates gnupg

# Node.js 22 (NodeSource)
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node -v)"

# MariaDB
apt-get install -y mariadb-server
systemctl enable --now mariadb

# Caddy (official repo) — HTTPS + reverse proxy + websockets
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

npm install -g pm2 >/dev/null

# ── 2. Database + secrets ────────────────────────────────────
DB_PASS="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"

mysql <<SQL
CREATE DATABASE IF NOT EXISTS livechat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'livechat'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER 'livechat'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON livechat.* TO 'livechat'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "==> MariaDB ready (user: livechat)"

# ── 3. .env + install + build ────────────────────────────────
if [ ! -f "$REPO_DIR/.env" ]; then
  cat > "$REPO_DIR/.env" <<ENV
DATABASE_URL=mysql://livechat:$DB_PASS@127.0.0.1:3306/livechat
PORT=4000
PUBLIC_URL=https://$DOMAIN
JWT_SECRET=$JWT_SECRET
DB_POOL_SIZE=30
# ANTHROPIC_API_KEY=   # AI greeter ke liye
# SMTP_HOST=           # email transcripts ke liye
ENV
  echo "==> .env created"
else
  echo "==> .env already exists — leaving it as is"
fi

cd "$REPO_DIR"
npm install --no-audit --no-fund
npm run build -w apps/widget
npm run build -w apps/dashboard

# ── 4. PM2 ───────────────────────────────────────────────────
pm2 delete livechat >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

# ── 5. Caddy (HTTPS + websockets automatically) ──────────────
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:4000
}
CADDY
systemctl reload caddy

# ── 6. Firewall ──────────────────────────────────────────────
ufw allow OpenSSH >/dev/null || true
ufw allow 80,443/tcp >/dev/null || true
ufw --force enable >/dev/null || true

echo ""
echo "─────────────────────────────────────────────"
echo "✅ LIVE!  https://$DOMAIN"
echo "   Dashboard : https://$DOMAIN/app/"
echo "   Demo shop : https://$DOMAIN/demo/acme.html"
echo "   Embed     : <script src=\"https://$DOMAIN/widget.js\" data-livechat-key=\"wk_XXXX\" async></script>"
echo ""
echo "   Login     : admin@demo.com / admin123  ← pehli fursat mein password badlein!"
echo "   Logs      : pm2 logs livechat"
echo "─────────────────────────────────────────────"
