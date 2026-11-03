#!/bin/bash
# ============================================================
#   House of Business — Deploy Script
#   הרץ על השרת: bash deploy.sh [--init-ssl]
# ============================================================

set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
COMPOSE="docker compose"

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Checks ───────────────────────────────────────────────────
[ ! -f ".env" ] && error ".env file not found. Copy .env.production → .env and fill in all values."
[ ! -f "docker-compose.yml" ] && error "docker-compose.yml not found. Run from project root."

# ── Validate critical secrets before deploy ──────────────────
JWT_SECRET_VAL=$(grep '^JWT_SECRET=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
JWT_LEN=${#JWT_SECRET_VAL}
[ -z "$JWT_SECRET_VAL" ] && error "JWT_SECRET is missing from .env. Generate one: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
[ "$JWT_LEN" -lt 64 ] && error "JWT_SECRET too short ($JWT_LEN chars). Production requires 64+. Generate: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
[ "$JWT_SECRET_VAL" = "hob-secret" ] && error "JWT_SECRET is the insecure default. Change it before deploying."

DB_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -z "$DB_URL" ] && error "DATABASE_URL is missing from .env."

ANTHROPIC_KEY=$(grep '^ANTHROPIC_API_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -z "$ANTHROPIC_KEY" ] && error "ANTHROPIC_API_KEY is missing from .env."
[[ "$ANTHROPIC_KEY" != sk-ant-* ]] && error "ANTHROPIC_API_KEY does not look valid (expected sk-ant-... prefix)."

ALLOWED_ORIGINS=$(grep '^ALLOWED_ORIGINS=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -z "$ALLOWED_ORIGINS" ] && error "ALLOWED_ORIGINS is missing from .env. Example: https://yourdomain.com"

APP_URL=$(grep '^APP_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -z "$APP_URL" ] && error "APP_URL is missing from .env. Example: https://yourdomain.com"

BACKEND_URL=$(grep '^BACKEND_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -z "$BACKEND_URL" ] && error "BACKEND_URL is missing from .env. Example: http://backend:3000"

# SMTP — warn only (app degrades gracefully without email)
SMTP_HOST=$(grep '^SMTP_HOST=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" 2>/dev/null || true)
[ -z "$SMTP_HOST" ] && warn "SMTP_HOST not set — email features (password reset, invites) will be disabled."

info "Pre-deploy secret validation passed ✓"

# Pull latest code
info "Pulling latest code..."
git pull origin "$(git rev-parse --abbrev-ref HEAD)"

# ── SSL Init (first deploy only) ────────────────────────────
if [[ "${1:-}" == "--init-ssl" ]]; then
  [ -z "$DOMAIN" ] && read -rp "Enter your domain (e.g. app.example.com): " DOMAIN
  [ -z "$EMAIL"  ] && read -rp "Enter your email for Let's Encrypt: " EMAIL

  if grep -q "YOUR_DOMAIN" nginx/nginx.conf 2>/dev/null; then
    info "Writing $DOMAIN into nginx/nginx.conf..."
    sed -i "s/YOUR_DOMAIN/$DOMAIN/g" nginx/nginx.conf
  fi

  info "Starting nginx without SSL for ACME challenge..."
  # Temporarily serve HTTP only so certbot can verify domain
  $COMPOSE up -d nginx

  info "Requesting Let's Encrypt certificate for $DOMAIN..."
  $COMPOSE run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    -d "$DOMAIN"

  info "SSL certificate obtained. Reloading nginx..."
  $COMPOSE exec -T nginx nginx -s reload || $COMPOSE restart nginx
fi

# ── Build & Deploy ───────────────────────────────────────────
info "Building images..."
$COMPOSE build --pull

info "Starting services..."
$COMPOSE up -d --remove-orphans

# ── Database Migrations ──────────────────────────────────────
info "Waiting for postgres to be healthy..."
for i in $(seq 1 30); do
  if $COMPOSE exec -T postgres pg_isready -U "${DB_USER:-hob_user}" -q 2>/dev/null; then
    break
  fi
  [ "$i" -eq 30 ] && error "Postgres did not become healthy in time."
  sleep 2
done

info "Running database migrations..."
$COMPOSE exec -T backend node db/migrate.js

# ── Health Check ─────────────────────────────────────────────
info "Checking service health..."
sleep 3

BACKEND_HEALTH=$($COMPOSE exec -T backend wget -qO- http://localhost:3000/health 2>/dev/null || echo "unreachable")
if echo "$BACKEND_HEALTH" | grep -q "ok\|healthy\|status"; then
  info "Backend: healthy"
else
  warn "Backend health check inconclusive — check logs: docker compose logs backend"
fi

# ── Print Status ─────────────────────────────────────────────
echo ""
info "Deployment complete!"
$COMPOSE ps
echo ""
echo -e "${GREEN}Useful commands:${NC}"
echo "  docker compose logs -f backend   # backend logs"
echo "  docker compose logs -f nginx     # nginx logs"
echo "  docker compose ps                # service status"
echo "  docker compose down              # stop all"
