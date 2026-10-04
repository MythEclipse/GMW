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

# bun is installed under the invoking user's home. SSH non-interactive
# sessions do not source ~/.bashrc / ~/.zshrc, so bun is not on PATH there.
# Add it explicitly; the location is stable (bun's own installer).
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "FATAL: bun not found on PATH (looked in $HOME/.bun/bin)" >&2
  exit 1
fi

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

# Node's native ESM loader resolves `import ... from "./enums"` inside the
# generated .ts files by looking for a literal `.js` sibling (it does not
# rewrite the specifier to .ts). The Prisma generator emits extension-less
# relative imports, so we must (a) rewrite the specifiers to `./enums.js` and
# (b) compile the .ts to .js in place; the runtime then finds the .js files
# it asks for.
log "Fixing Prisma generated import specifiers"
(cd packages/db && node -e "
const fs = require('fs');
const path = require('path');
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) {
      const c = fs.readFileSync(p, 'utf8');
      const n = c.replace(/from\s+['\"]([^'\"]+)['\"]/g, (m, spec) =>
        ((spec.startsWith('./') || spec.startsWith('../')) &&
         !/\.(js|ts|json|node|mjs|cjs)$/.test(spec))
          ? 'from \"' + spec + '.js\"' : m);
      if (n !== c) fs.writeFileSync(p, n);
    }
  }
}
walk('prisma/generated');
console.log('  source specifiers rewritten');
")

log "Compiling Prisma generated client to JS"
TSC_BIN=$(find "$RELEASE_DIR/node_modules/.bun" -path '*/typescript/bin/tsc' -type f | head -1)
if [ -z "$TSC_BIN" ]; then
  echo "FATAL: typescript compiler not found in release node_modules" >&2
  exit 1
fi
(cd packages/db && "$TSC_BIN" --ignoreConfig \
  --module esnext --target es2022 --moduleResolution bundler \
  --outDir prisma/generated \
  --declaration false --sourceMap false --skipLibCheck --esModuleInterop \
  --noEmit false \
  prisma/generated/*.ts prisma/generated/internal/*.ts)

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
# `systemctl is-active` alone is NOT a health signal: with Restart=always a unit
# that exits 200ms after start reports `active` on the first poll, then flips to
# `activating (auto-restart)`. A single reading therefore passes a deploy whose
# backend has been crash-looping the whole time — which is exactly what happened
# on the first run of this script.
#
# So: require every unit to be active on CONSECUTIVE polls across a stability
# window, AND require the HTTP surfaces to actually answer. A port that is open
# because the process died a moment later proves nothing.
UNITS="gmw-backend gmw-discord-gateway gmw-discord-gateway-worker gmw-frontend gmw-proxy"
STABLE_POLLS=3
end=$((SECONDS+90))
streak=0
while [ $SECONDS -lt $end ]; do
  ok=1
  for u in $UNITS; do
    state=$(sudo systemctl is-active "$u" 2>/dev/null || echo inactive)
    if [ "$state" != "active" ]; then
      ok=0
      break
    fi
  done
  if [ $ok -eq 1 ]; then
    streak=$((streak+1))
    if [ $streak -ge $STABLE_POLLS ]; then
      break
    fi
  else
    streak=0
  fi
  sleep 2
done

if [ $streak -lt $STABLE_POLLS ]; then
  echo "::error::One or more services failed to stay active" >&2
  for u in $UNITS; do
    state=$(sudo systemctl is-active "$u" 2>/dev/null || echo inactive)
    echo "  $u -> $state"
  done
  exit 1
fi

# HTTP surfaces, not just process liveness.
check_http() {
  local label="$1" url="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
  echo "  $label ($url) -> $code"
  [ "$code" = "200" ]
}

log "Checking HTTP surfaces"
http_ok=1
check_http "backend"     "http://127.0.0.1:4001/api/health" || http_ok=0
check_http "frontend"    "http://127.0.0.1:4017/"          || http_ok=0
check_http "proxy"       "http://127.0.0.1:4009/"          || http_ok=0
check_http "proxy/api"   "http://127.0.0.1:4009/api/health" || http_ok=0

if [ $http_ok -ne 1 ]; then
  echo "::error::One or more HTTP surfaces did not answer 200" >&2
  exit 1
fi

log "All services active and answering"
log "Deployment complete: $SHORT_SHA"
