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

FILES=(
  config.json config_sentence_transformers.json modules.json sentence_bert_config.json
  model.safetensors tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt
  1_Pooling/config.json
)

rm -rf "$DEST"
mkdir -p "$DEST/1_Pooling"
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DEST/$f"
done
echo "model copied to $DEST ($(du -sh "$DEST" | cut -f1))"
