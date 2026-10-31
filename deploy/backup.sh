#!/bin/sh
set -eu
# Run from repository root. BACKUP_DIR may point to a mounted NAS directory.
: "${BACKUP_DIR:?Set BACKUP_DIR to an independent backup destination}"
umask 077
mkdir -p "$BACKUP_DIR"
backup="$BACKUP_DIR/wms-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f deploy/compose.lan.yml --env-file .env exec -T postgres pg_dump -U wms_owner -d wms -Fc > "$backup.partial"
test -s "$backup.partial"
mv "$backup.partial" "$backup"
sha256sum "$backup" > "$backup.sha256"
printf '%s\n' "$backup"
