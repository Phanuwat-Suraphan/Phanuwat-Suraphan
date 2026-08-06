#!/usr/bin/env bash
# Daily backup: SQLite DB + uploaded PDFs. Run via cron, e.g.:
#   0 0 * * * /opt/esaraban/deploy/backup.sh >> /var/log/esaraban-backup.log 2>&1
set -euo pipefail

APP_DIR="/opt/esaraban"
BACKUP_DIR="/opt/esaraban-backups"
DATE=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/$DATE"

mkdir -p "$DEST"
sqlite3 "$APP_DIR/data/esaraban.db" ".backup '$DEST/esaraban.db'"
tar -czf "$DEST/uploads.tar.gz" -C "$APP_DIR" uploads

# keep 30 days
find "$BACKUP_DIR" -maxdepth 1 -mtime +30 -type d -exec rm -rf {} +
echo "Backup complete: $DEST"
