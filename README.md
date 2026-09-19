# pi-werkstatt-extensions

Fünf bewährte **Extensions für [pi](https://pi.dev)** aus der pi-Werkstatt —
Sicherheit, Meldungen, Websuche, Backup. Reine pi-Extensions, keine weiteren
Abhängigkeiten.

## Inhalt

| Extension | Was sie tut |
|---|---|
| `destructive-guard.ts` | Verlangt Bestätigung für seltene, aber katastrophale Befehle (rm -rf auf Systempfaden, $HOME, Git-Härtefälle, Schreibzugriffe via Umleitung/tee/cp/mv auf sensible Pfade). Alltags-rm bleibt unbehelligt. |
| `done-notify.ts` | macOS-Meldung „Fertig 🙂“ (mit Ton), wenn pi auf Eingabe wartet; Terminal-Fallback (OSC 777). Commands: `/notify-sound`, `/notify-test`. Konfiguration: `~/.pi/agent/done-notify.json` |
| `confirm-notify.ts` | macOS-Meldung „Hilfe 👋“, wenn pi auf Bestätigung wartet (blockierender Dialog) — verpasst kein „ja oder nein klicken“ mehr. |
| `web-search.ts` | Websuche über **Exa** und/oder **Parallel**. Keys liegen sicher im macOS-Schlüsselbund (`pi-exa`, `pi-parallel`) — niemals im Klartext. |
| `backup-hook.ts` | Sichert nach jeder pi-Sitzung die Anpassungen (Extensions, Themes, Prompts, Skills, Settings, mnemon) — höchstens alle 10 Minuten. Erwartet ein `~/pi-anpassungen/backup.sh` (generische Vorlage im Starter-Kit: `install.sh --with-backup`). |

## Installieren

```bash
pi install https://github.com/kambodscharoger294-cyber/pi-werkstatt-extensions
```

Ein-/ausschalten pro Extension: `pi config` (Tab schaltet global/projekt).

## Voraussetzungen

- macOS (Notifications via `osascript`); done-notify fällt auf Terminal-OSC zurück
- Für web-search: zwei Schlüsselbund-Einträge —
  ```bash
  security add-generic-password -s pi-exa -a "$USER" -w
  security add-generic-password -s pi-parallel -a "$USER" -w
  ```
- backup-hook ist **optional**: nur nützlich, wenn ein `~/pi-anpassungen/backup.sh`
  existiert (Starter-Kit legt eine generische Vorlage an)

## Herkunft

Gepflegt im pi-Werkstatt-Starter-Kit (`extensions/`), 19.09.2026 in ein eigenes
pi-Paket überführt. Einzelne Extensions lassen sich mit `pi config` gezielt
deaktivieren, ohne sie zu löschen.
