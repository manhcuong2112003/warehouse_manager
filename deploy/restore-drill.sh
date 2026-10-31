#!/bin/sh
set -eu
# Isolated drill only: never restores into the live database.
: "${BACKUP_FILE:?Set BACKUP_FILE to a pg_dump custom-format archive}"
test -f "$BACKUP_FILE"
drill="wms_restore_$(date -u +%Y%m%d%H%M%S)_test"
case "$drill" in wms_restore_*_test) ;; *) exit 1;; esac
docker compose -f deploy/compose.lan.yml --env-file .env exec -T postgres createdb -U wms_owner "$drill"
docker compose -f deploy/compose.lan.yml --env-file .env exec -T postgres pg_restore -U wms_owner -d "$drill" --exit-on-error < "$BACKUP_FILE"
docker compose -f deploy/compose.lan.yml --env-file .env exec -T postgres psql -U wms_owner -d "$drill" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS mismatched_packs FROM stock_pack_balances b LEFT JOIN (SELECT pack_balance_id,sum(quantity_delta) AS quantity FROM stock_movements GROUP BY pack_balance_id) m ON m.pack_balance_id=b.id WHERE b.on_hand<>COALESCE(m.quantity,0);'
printf 'Restore drill database retained for inspection: %s\n' "$drill"
