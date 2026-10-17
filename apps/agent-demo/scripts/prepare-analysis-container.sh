#!/usr/bin/env bash
# Stages the manual-analysis engine sources and the local bge-small-zh-v1.5
# model into container/analysis/ so the image is self-contained and offline.
# Engine modules are copied from the repo root; model files come from the VM
# path (arg 1) or reuse container/embedding/model/ if already staged.
# Both destinations are gitignored and never committed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP_DIR="$REPO_ROOT/apps/agent-demo"
MODEL_SRC="${1:-$APP_DIR/container/embedding/model}"
if [ ! -d "$MODEL_SRC" ]; then
  MODEL_SRC="/home/righttu/ai-finance/CloudFlare/models/bge-small-zh-v1.5/BAAI/bge-small-zh-v1___5"
fi

MODULES=(
  Manual_Analyst_Engine_final.py
  chip_hunter_db_final.py
  knowledge_miner_final.py
  ai_analyst_infra_final.py
  ai_analyst_Brain_final.py
)

APP_DEST="$APP_DIR/container/analysis/app"
MODEL_DEST="$APP_DIR/container/analysis/model"

rm -rf "$APP_DEST" "$MODEL_DEST"
mkdir -p "$APP_DEST" "$MODEL_DEST/1_Pooling"

for m in "${MODULES[@]}"; do
  if [ ! -f "$REPO_ROOT/$m" ]; then
    echo "engine module not found: $REPO_ROOT/$m" >&2
    exit 1
  fi
  cp "$REPO_ROOT/$m" "$APP_DEST/"
done

if [ ! -d "$MODEL_SRC" ]; then
  echo "model source not found: $MODEL_SRC" >&2
  exit 1
fi

FILES=(
  config.json config_sentence_transformers.json modules.json sentence_bert_config.json
  model.safetensors tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt
  1_Pooling/config.json
)
for f in "${FILES[@]}"; do
  if [ ! -f "$MODEL_SRC/$f" ]; then
    echo "model file missing: $MODEL_SRC/$f" >&2
    exit 1
  fi
  cp "$MODEL_SRC/$f" "$MODEL_DEST/$f"
done

echo "engine modules -> $APP_DEST"
echo "model -> $MODEL_DEST ($(du -sh "$MODEL_DEST" | cut -f1))"
