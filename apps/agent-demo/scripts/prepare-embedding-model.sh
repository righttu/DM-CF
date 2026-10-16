#!/usr/bin/env bash
# Copies the local bge-small-zh-v1.5 SentenceTransformer model into
# container/embedding/model/ so the Docker image can run fully offline
# (HF_HUB_OFFLINE=1). Model files are gitignored and never committed.
set -euo pipefail

SRC="${1:-/home/righttu/ai-finance/CloudFlare/models/bge-small-zh-v1.5/BAAI/bge-small-zh-v1___5}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/container/embedding/model"

if [ ! -d "$SRC" ]; then
  echo "model source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/
echo "model copied to $DEST"
