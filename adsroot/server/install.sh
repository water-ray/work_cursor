#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

DEFAULT_NODE_HOME="/www/server/nodejs/v24.14.0"
NODE_HOME="${WATERAY_NODE_HOME:-$DEFAULT_NODE_HOME}"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [ -x "$NODE_HOME/bin/node" ] && [ -x "$NODE_HOME/bin/npm" ]; then
    export PATH="$NODE_HOME/bin:$PATH"
    echo "Using fallback Node runtime from: $NODE_HOME"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed and fallback path is unavailable: $NODE_HOME/bin/node" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed and fallback path is unavailable: $NODE_HOME/bin/npm" >&2
  exit 1
fi

if [ ! -f "package-lock.json" ]; then
  echo "Error: package-lock.json not found in $SCRIPT_DIR." >&2
  exit 1
fi

echo "Using node: $(node -v)"
echo "Using npm : $(npm -v)"

echo "Installing production dependencies..."
npm ci --omit=dev

mkdir -p data

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo "Install complete."
echo "Start server with: node main.js"
