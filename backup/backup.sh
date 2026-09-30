#!/usr/bin/env bash
# Generische Backup-Vorlage für pi-Anpassungen — von backup-hook.ts aufgerufen.
#
# Einbau:
#   mkdir -p ~/pi-anpassungen
#   cp backup/backup.sh ~/pi-anpassungen/backup.sh   # aus dem Paket-Repo
#   chmod +x ~/pi-anpassungen/backup.sh
#
# Zwei Dinge MUSS das Skript selbst erledigen (backup-hook.ts erwartet das):
#   1. Am ENDE, nur bei Erfolg, "$HOME/pi-anpassungen/.last-backup" schreiben.
#      Der Hook nutzt die Datei als Debounce (höchstens ein Backup / 10 min).
#      Fehlt der Stamp, wiederholt der Hook beim nächsten Sitzungswechsel.
#   2. Mit Exitcode abbrechen, wenn nichts gesichert wurde.
#
# Eigene Projekte, Datenbanken oder Wikis einfach als weitere items[]-Einträge
# ergänzen — vorhandene Pfade, die es nicht gibt, werden übersprungen.

set -euo pipefail

DEST_ROOT="$HOME/pi-anpassungen/backup"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$DEST_ROOT/$STAMP"
KEEP="${PI_BACKUP_KEEP:-20}"     # wie viele Backups aufheben

mkdir -p "$DEST"

# "quelle:ziel" — Verzeichnisse werden rekursiv kopiert, Dateien einzeln.
items=(
  "$HOME/.pi/agent/extensions:extensions"
  "$HOME/.pi/agent/prompts:prompts"
  "$HOME/.pi/agent/skills:skills"
  "$HOME/.pi/agent/agents:agents"
  "$HOME/.pi/agent/plans:plans"
  "$HOME/.pi/agent/themes:themes"
  "$HOME/.pi/agent/settings.json:settings.json"
)

copied=0
for item in "${items[@]}"; do
  src="${item%%:*}"
  dst="${item##*:}"
  [ -e "$src" ] || continue
  mkdir -p "$DEST/$(dirname "$dst")"
  if [ -d "$src" ]; then
    cp -R "$src/." "$DEST/$dst/"
  else
    cp "$src" "$DEST/$dst"
  fi
  copied=1
done

if [ "$copied" -eq 0 ]; then
  echo "Nichts zu sichern gefunden — überspringe Backup (kein Stamp)." >&2
  exit 1
fi

# Alte Backups ausdünnen
ls -1dt "$DEST_ROOT"/*/ 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs rm -rf 2>/dev/null || true

# Stamp NUR nach erfolgreichem Abschluss (set -e bricht vorher ab).
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$HOME/pi-anpassungen/.last-backup"

echo "Backup erstellt: $DEST"
