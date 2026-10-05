#!/bin/sh
# Noćni backup granica: baza (konzistentna kopija), zone kamera i zvanični podaci; čuva se 30 dana.
cd "$(dirname "$0")/.." || exit 1
B=${BACKUP_DIR:-$HOME/backups}; mkdir -p "$B"; D=$(date +%F)
node -e "require('better-sqlite3')('data/granice.db',{readonly:true}).backup('$B/granice-$D.db').then(()=>process.exit(0))" && gzip -f "$B/granice-$D.db"
tar czf "$B/podesavanja-$D.tgz" -C data $(cd data && ls kamere-podesavanja.json granice.json 2>/dev/null) 2>/dev/null
find "$B" -type f -mtime +30 -delete
