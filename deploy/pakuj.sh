#!/bin/sh
# Spakuje granice za server (bez node_modules, data/, .env, dokumentacije) u granice.zip – vidi docs/DEPLOY.md.
cd "$(dirname "$0")/.." || exit 1
for f in server/*.js deploy/osrm/*.js; do node --check "$f" || { echo "Sintaksna greška u $f – ne pakujem."; exit 1; }; done   # pokvaren serverski fajl obara sajt
rm -f granice.zip
zip -rq granice.zip . -x 'node_modules/*' 'data/*' '.env' 'granice.zip' 'docs/*' 'claude-memory/*' '*.md' '.DS_Store' '*/.DS_Store'
echo "Spakovano: $(pwd)/granice.zip ($(du -h granice.zip | cut -f1))"
