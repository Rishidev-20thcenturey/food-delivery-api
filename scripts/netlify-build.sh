#!/usr/bin/env bash
set -euo pipefail

# First deploy can unpack the source bundle; later commits use native frontend files.
if [[ ! -d frontend ]]; then
  if [[ ! -f frontend-source.tar.gz ]]; then
    echo "Missing frontend/ and frontend-source.tar.gz." >&2
    exit 1
  fi
  tar -xzf frontend-source.tar.gz -C .
fi

cd frontend
npm install --no-audit --no-fund
npm run build
