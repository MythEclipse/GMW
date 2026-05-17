#!/bin/bash

# Configuration for CLI deployment
VPS_HOST="45.127.35.244"
VPS_USER="root"
# Find first available private key in ~/.ssh or use specific one if you want to hardcode
SSH_KEY_PATH=$(find ~/.ssh -name "id_rsa" -o -name "id_ed25519" | head -n 1)

echo "🚀 Starting CLI deployment to $VPS_USER@$VPS_HOST..."

if [ -z "$SSH_KEY_PATH" ]; then
  echo "⚠️ No SSH key found in ~/.ssh. Falling back to default SSH behavior."
  SSH_CMD="ssh -o StrictHostKeyChecking=no $VPS_USER@$VPS_HOST"
  RSYNC_CMD="rsync -avz --exclude-from='.dockerignore' -e 'ssh -o StrictHostKeyChecking=no'"
else
  echo "🔑 Using SSH key: $SSH_KEY_PATH"
  SSH_CMD="ssh -i $SSH_KEY_PATH -o StrictHostKeyChecking=no $VPS_USER@$VPS_HOST"
  RSYNC_CMD="rsync -avz --exclude-from='.dockerignore' -e 'ssh -i $SSH_KEY_PATH -o StrictHostKeyChecking=no'"
fi

# Directory on the VPS where the app will be deployed
REMOTE_DIR="/opt/imphenbot"

echo "📦 Syncing files to VPS..."
$SSH_CMD "mkdir -p $REMOTE_DIR"
eval "$RSYNC_CMD ./ $VPS_USER@$VPS_HOST:$REMOTE_DIR"

echo "🔄 Rebuilding and restarting Docker containers..."
$SSH_CMD << EOF
  cd $REMOTE_DIR
  docker-compose up -d --build
EOF

echo "✅ Deployment complete!"
