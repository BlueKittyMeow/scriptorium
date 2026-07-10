#!/usr/bin/env bash
#
# scriptorium backup
# -------------------
# Preservation-first backup for a deployed Scriptorium instance.
#
# Env-driven (all overridable):
#   DATA_ROOT      dir holding scriptorium.db + per-novel content/snapshot files
#                  (default: /mnt/media/scriptorium/data)
#   BACKUP_DIR     destination root for local backups
#                  (default: /mnt/media/scriptorium/backups)
#   RCLONE_REMOTE  optional rclone target (e.g. "uponmidnight-gdrive:Scriptorium Backups").
#                  If set AND rclone is installed, an off-site sync runs. Otherwise skipped.
#
# What it does:
#   (a) VACUUM INTO a dated, consistent copy of the SQLite DB (safe under WAL while
#       the app is running -- it takes its own read transaction and writes a clean file).
#   (b) rsync -a --delete a full mirror of DATA_ROOT (content + snapshot files).
#   (c) prune dated DB copies older than 14 days.
#   (d) optional off-site rclone sync of the whole BACKUP_DIR.
#
# Safe to re-run same-day: the dated DB copy is OVERWRITTEN (VACUUM INTO refuses to
# write to an existing file, so we remove it first). Chosen over skip-if-exists so a
# re-run always captures the latest state.

set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/mnt/media/scriptorium/data}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/media/scriptorium/backups}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

log() {
	printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

log "scriptorium-backup starting"
log "DATA_ROOT=$DATA_ROOT"
log "BACKUP_DIR=$BACKUP_DIR"
log "RCLONE_REMOTE=${RCLONE_REMOTE:-<unset>}"

# --- preflight -------------------------------------------------------------
if [ ! -f "$DATA_ROOT/scriptorium.db" ]; then
	log "ERROR: $DATA_ROOT/scriptorium.db not found"
	exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
	log "ERROR: sqlite3 not installed"
	exit 1
fi

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/data-mirror"

# --- (a) consistent DB snapshot via VACUUM INTO ----------------------------
DB_COPY="$BACKUP_DIR/db/scriptorium-$(date +%F).db"
if [ -f "$DB_COPY" ]; then
	log "removing existing same-day DB copy (will overwrite): $DB_COPY"
	rm -f "$DB_COPY"
fi
log "VACUUM INTO $DB_COPY"
sqlite3 "$DATA_ROOT/scriptorium.db" "VACUUM INTO '$DB_COPY'"
DB_BYTES=$(stat -c %s "$DB_COPY")
log "DB copy written: $DB_BYTES bytes"

# --- (b) full data mirror (content + snapshots) ----------------------------
log "rsync mirror of DATA_ROOT -> $BACKUP_DIR/data-mirror/"
rsync -a --delete "$DATA_ROOT/" "$BACKUP_DIR/data-mirror/"
log "mirror complete"

# --- (c) prune dated DB copies older than 14 days --------------------------
log "pruning DB copies older than 14 days"
find "$BACKUP_DIR/db" -maxdepth 1 -type f -name 'scriptorium-*.db' -mtime +14 -print -delete | while read -r p; do
	log "pruned $p"
done

# --- (d) optional off-site sync --------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
	if command -v rclone >/dev/null 2>&1; then
		log "rclone sync $BACKUP_DIR -> $RCLONE_REMOTE"
		rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE" --transfers 4
		log "off-site sync complete"
	else
		log "WARNING: RCLONE_REMOTE set but rclone not installed -- skipping off-site sync"
	fi
else
	log "RCLONE_REMOTE unset -- skipping off-site sync"
fi

log "scriptorium-backup finished OK"
