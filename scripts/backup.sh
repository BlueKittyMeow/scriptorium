#!/usr/bin/env bash
# Shared engine and hardened unit: learning-platform/deploy/household-backup/.
# Install that package first. Run through scriptorium-backup.service as bluekitty.
set -euo pipefail
exec /usr/bin/python3 /usr/local/lib/household-backup/backup.py scriptorium
