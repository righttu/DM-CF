#!/usr/bin/env bash
# Stages the daily-batch scripts plus shared engine modules and the local
# bge-small-zh-v1.5 model into container/batch/ so the image is self-contained
# and offline. Scripts are copied from the repo root; model files come from
# container/embedding/model/ or container/analysis/model/ if already staged,
# else the VM path. Both destinations are gitignored and never committed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP_DIR="$REPO_ROOT/apps/agent-demo"
MODEL_SRC="${1:-}"
if [ -z "$MODEL_SRC" ]; then
  for cand in "$APP_DIR/container/analysis/model" "$APP_DIR/container/embedding/model"; do
    if [ -d "$cand" ]; then MODEL_SRC="$cand"; break; fi
  done
fi
if [ -z "$MODEL_SRC" ]; then
  MODEL_SRC="/home/righttu/ai-finance/CloudFlare/models/bge-small-zh-v1.5/BAAI/bge-small-zh-v1___5"
fi

MODULES=(
  fetch_full_basic_data_multipthre_final.py
  chip_hunter_db_final.py
  alpha_hunter_db_final.py
  hotspot_registry_final.py
  hotspot_registry_Auditor_final.py
  hotspot_hunter_final.py
  knowledge_miner_final.py
  ai_analyst_Brain_final.py
  ai_analyst_infra_final.py
  Manual_Analyst_Engine_final.py
)

APP_DEST="$APP_DIR/container/batch/app"
MODEL_DEST="$APP_DIR/container/batch/model"

rm -rf "$APP_DEST" "$MODEL_DEST"
mkdir -p "$APP_DEST" "$MODEL_DEST/1_Pooling"

for m in "${MODULES[@]}"; do
  if [ ! -f "$REPO_ROOT/$m" ]; then
    echo "script module not found: $REPO_ROOT/$m" >&2
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

echo "batch scripts -> $APP_DEST"
echo "model -> $MODEL_DEST ($(du -sh "$MODEL_DEST" | cut -f1))"
