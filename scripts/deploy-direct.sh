#!/usr/bin/env bash
set -euo pipefail

# deploy-direct.sh — build GMW from source and install systemd units
# Replaces the Nix profile-based deployment (flake.nix / nix-env / nix copy).
#
# Layout:
#   /opt/gmw/releases/<sha>/   — full checkout at a given git sha (immutable)
#   /opt/gmw/current           — symlink to the active release
#   /opt/gmw/bin/*             — thin wrappers that cd into current and exec node
#   /etc/systemd/system/gmw-*.service
#   /etc/nginx/sites-available/gmw-proxy
#
# Usage:
#   bash scripts/deploy-direct.sh [branch|sha]
#
# Env:
#   REMOTE_REPO — git remote to fetch (default: https://github.com/asepharyana/GMW.git)
#   DEPLOY_REF  — branch, tag, or sha to deploy (default: main)

REMOTE_REPO="${REMOTE_REPO:-https://github.com/asepharyana/GMW.git}"
DEPLOY_REF="${1:-${DEPLOY_REF:-main}}"
INSTALL_ROOT="/opt/gmw"
RELEASES_DIR="$INSTALL_ROOT/releases"
CURRENT_LINK="$INSTALL_ROOT/current"
BIN_DIR="$INSTALL_ROOT/bin"

log() { echo "[deploy] $*"; }

# ---------------------------------------------------------------------------
# 1. Fetch source into a fresh release dir
# ---------------------------------------------------------------------------
log "Resolving $DEPLOY_REF from $REMOTE_REPO"
SHA=$(git ls-remote "$REMOTE_REPO" "$DEPLOY_REF" | awk '{print $1}')
if [ -z "$SHA" ]; then
  echo "FATAL: could not resolve $DEPLOY_REF" >&2
  exit 1
fi
SHORT_SHA="${SHA:0:8}"
RELEASE_DIR="$RELEASES_DIR/$SHORT_SHA"

if [ -d "$RELEASE_DIR" ]; then
  log "Release $SHORT_SHA already exists at $RELEASE_DIR; reusing"
else
  log "Cloning $SHORT_SHA into $RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  git clone --depth 1 --branch "$DEPLOY_REF" "$REMOTE_REPO" "$RELEASE_DIR"
fi

cd "$RELEASE_DIR"

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
log "Installing dependencies (bun install)"
export HOME="${HOME:-/var/lib/gmw}"
mkdir -p "$HOME/.bun"
bun install --frozen-lockfile

log "Generating Prisma client"
(cd packages/db && bunx prisma generate)

log "Building backend"
(cd apps/backend && bun run build)

log "Building discord-gateway"
(cd apps/discord-gateway && bun run build)

log "Building frontend"
(cd apps/frontend && bun run build)

# ---------------------------------------------------------------------------
# 3. Prune devDependencies (keep runtime node_modules lean)
# ---------------------------------------------------------------------------
log "Pruning devDependencies"
for app_dir in apps/backend apps/discord-gateway packages/db; do
  if [ -d "$app_dir/node_modules" ]; then
    find "$app_dir/node_modules" -maxdepth 2 -type d \
      \( -name 'typescript' -o -name '@biomejs' -o -name 'vitest' \
         -o -name 'drizzle-kit' -o -name 'tsx' -o -name 'esbuild' \
         -o -name '@types' \) \
      -prune -exec rm -rf {} + 2>/dev/null || true
    rm -f "$app_dir/node_modules/.bin/tsc" \
          "$app_dir/node_modules/.bin/vitest" \
          "$app_dir/node_modules/.bin/biome" \
          "$app_dir/node_modules/.bin/drizzle-kit" 2>/dev/null || true
    find "$app_dir/node_modules" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
  fi
done
find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. Fix workspace symlinks
# ---------------------------------------------------------------------------
# apps/backend imports @gmw/db; bun leaves a symlink in node_modules that
# points to the release checkout. Ensure it resolves after the switch.
if [ -L "apps/backend/node_modules/@gmw/db" ]; then
  rm -f "apps/backend/node_modules/@gmw/db"
  mkdir -p "apps/backend/node_modules/@gmw"
  ln -sfn "$RELEASE_DIR/packages/db" "apps/backend/node_modules/@gmw/db"
fi

# ---------------------------------------------------------------------------
# 5. Install wrappers
# ---------------------------------------------------------------------------
log "Installing wrappers to $BIN_DIR"
sudo mkdir -p "$BIN_DIR"
sudo chown root:root "$BIN_DIR"

# backend
sudo tee "$BIN_DIR/gmw-backend" > /dev/null <<WRAPPER
#!/usr/bin/env bash
cd $CURRENT_LINK/apps/backend
exec /usr/bin/node dist/index.js
WRAPPER
sudo chmod +x "$BIN_DIR/gmw-backend"

# discord-gateway
sudo tee "$BIN_DIR/gmw-discord-gateway" > /dev/null <<WRAPPER
#!/usr/bin/env bash
cd $CURRENT_LINK/apps/discord-gateway
exec /usr/bin/node dist/index.js
WRAPPER
sudo chmod +x "$BIN_DIR/gmw-discord-gateway"

# discord-gateway-worker
sudo tee "$BIN_DIR/gmw-discord-gateway-worker" > /dev/null <<WRAPPER
#!/usr/bin/env bash
cd $CURRENT_LINK/apps/discord-gateway
exec /usr/bin/node dist/moderation-worker.js
WRAPPER
sudo chmod +x "$BIN_DIR/gmw-discord-gateway-worker"

# frontend
sudo tee "$BIN_DIR/gmw-frontend" > /dev/null <<WRAPPER
#!/usr/bin/env bash
cd $CURRENT_LINK/apps/frontend
exec /usr/bin/node serve.mjs
WRAPPER
sudo chmod +x "$BIN_DIR/gmw-frontend"

# proxy (nginx)
sudo tee "$BIN_DIR/gmw-proxy" > /dev/null <<WRAPPER
#!/usr/bin/env bash
exec /usr/sbin/nginx -c /etc/nginx/sites-available/gmw-proxy \\
  -p /var/lib/gmw-proxy \\
  -g "error_log /var/lib/gmw-proxy/nginx-error.log; daemon off;"
WRAPPER
sudo chmod +x "$BIN_DIR/gmw-proxy"

# ---------------------------------------------------------------------------
# 6. Install systemd units + nginx config
# ---------------------------------------------------------------------------
log "Installing systemd units"
for unit in gmw-backend gmw-discord-gateway gmw-discord-gateway-worker gmw-frontend gmw-proxy; do
  sudo cp "$RELEASE_DIR/infra/systemd/$unit.service" "/etc/systemd/system/$unit.service"
done
sudo systemctl daemon-reload

log "Installing nginx config"
sudo cp "$RELEASE_DIR/infra/nginx/nginx.conf" /etc/nginx/sites-available/gmw-proxy
sudo ln -sfn /etc/nginx/sites-available/gmw-proxy /etc/nginx/sites-enabled/gmw-proxy
sudo mkdir -p /var/lib/gmw-proxy
sudo chown gmw:gmw /var/lib/gmw-proxy

# Validate nginx config before switching
sudo /usr/sbin/nginx -t -c /etc/nginx/sites-available/gmw-proxy

# ---------------------------------------------------------------------------
# 7. Switch current symlink
# ---------------------------------------------------------------------------
log "Switching $CURRENT_LINK -> $RELEASE_DIR"
sudo ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
sudo chown -R gmw:gmw "$RELEASE_DIR"
sudo chown -h gmw:gmw "$CURRENT_LINK"

# ---------------------------------------------------------------------------
# 8. Enable + restart services
# ---------------------------------------------------------------------------
log "Enabling and restarting services"
sudo systemctl enable gmw-backend gmw-discord-gateway gmw-discord-gateway-worker gmw-frontend gmw-proxy
sudo systemctl restart gmw-backend gmw-discord-gateway gmw-discord-gateway-worker gmw-frontend gmw-proxy

# ---------------------------------------------------------------------------
# 9. Health check
# ---------------------------------------------------------------------------
log "Waiting for services to become active"
end=$((SECONDS+60))
healthy=0
while [ $SECONDS -lt $end ]; do
  ok=1
  for u in gmw-backend gmw-discord-gateway gmw-discord-gateway-worker gmw-frontend gmw-proxy; do
    state=$(sudo systemctl is-active "$u" 2>/dev/null || echo inactive)
    if [ "$state" != "active" ]; then
      ok=0
      break
    fi
  done
  if [ $ok -eq 1 ]; then
    healthy=1
    break
  fi
  sleep 2
done

if [ $healthy -eq 0 ]; then
  echo "::error::One or more services failed to start" >&2
  for u in gmw-backend gmw-discord-gateway gmw-discord-gateway-worker gmw-frontend gmw-proxy; do
    state=$(sudo systemctl is-active "$u" 2>/dev/null || echo inactive)
    echo "  $u -> $state"
  done
  exit 1
fi

log "All services active"
log "Deployment complete: $SHORT_SHA"
