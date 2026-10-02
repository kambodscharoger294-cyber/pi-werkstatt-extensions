# pi-werkstatt-extensions

Fünf bewährte **Extensions für [pi](https://pi.dev)** aus der pi-Werkstatt —
Sicherheit, Meldungen, Websuche, Backup. Reine pi-Extensions, keine weiteren
Abhängigkeiten.

## Inhalt

| Extension | Was sie tut |
|---|---|
| `destructive-guard.ts` | Zwei Schichten: **(1)** Nachfrage bei seltenen, aber katastrophalen Bash-Befehlen (rm -rf auf Systempfaden/`$HOME`, Git-Härtefälle). **(2)** Schreibpfade per `write`/`edit` **und** per Bash-Umleitung/`tee`/`cp`/`mv`: ohne Nachfrage innerhalb von `~/.pi` und des aktuellen Projekts, sonst Auswahl mit **Vorauswahl „freigeben“**: einmalig ausführen, **Verzeichnis für diese Session freigeben** oder **dauerhaft freigeben** (`~/.pi/agent/write-allowlist.json`, gilt auch in künftigen Sessions; `/freigaben` listet und entfernt Einträge). `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, Shell-RCs und `.git`-Interna bleiben auch in freigegebenen Verzeichnissen geschützt. Alltags-`rm` bleibt unbehelligt. |
| `done-notify.ts` | macOS-Meldung „Fertig 🙂“ (mit Ton), wenn pi auf Eingabe wartet; Terminal-Fallback (OSC 777). Commands: `/notify-sound`, `/notify-test`. Konfiguration: `~/.pi/agent/done-notify.json` |
| `confirm-notify.ts` | macOS-Meldung „Hilfe 👋“, wenn pi auf Bestätigung wartet (blockierender Dialog) — verpasst kein „ja oder nein klicken“ mehr. |
| `web-search.ts` | Websuche über **Exa** und/oder **Parallel**. Keys liegen sicher im macOS-Schlüsselbund (`pi-exa`, `pi-parallel`) — niemals im Klartext. |
| `backup-hook.ts` | Führt nach jeder pi-Sitzung ein eigenes Backup-Skript aus (früher alle 10 Minuten höchstens, Debounce über eine Stamp-Datei). Eine generische Vorlage liegt bei `backup/backup.sh` im Repo. Ohne Skript tut die Extension nichts — sie ist optional. |

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
- `backup-hook` ist **optional** und kommt ohne eigenes Skript aus. Es ruft
  `~/pi-anpassungen/backup.sh` auf, sobald die Sitzung endet (höchstens alle 10 Minuten).
  Generische Vorlage aus diesem Repo einbauen — die liegt nach `pi install` unter
  `~/.pi/agent/git/github.com/kambodscharoger294-cyber/pi-werkstatt-extensions/backup/backup.sh`:
  ```bash
  mkdir -p ~/pi-anpassungen
  cp ~/.pi/agent/git/github.com/kambodscharoger294-cyber/pi-werkstatt-extensions/backup/backup.sh \
     ~/pi-anpassungen/backup.sh
  chmod +x ~/pi-anpassungen/backup.sh
  ```
  **Wichtig:** Das Skript muss die Stamp-Datei `~/pi-anpassungen/.last-backup` selbst
  schreiben — und zwar erst nach erfolgreichem Abschluss. Die Vorlage macht das so;
  wer sein eigenes schreibt, muss es mitmachen, sonst wiederholt der Hook das Backup
  bei jedem Sitzungswechsel. Eigene Projekte einfach als weitere `items[]`-Einträge
  in der Vorlage ergänzen.

## Herkunft

Gepflegt im pi-Werkstatt-Starter-Kit (`extensions/`), 19.09.2026 in ein eigenes
pi-Paket überführt. Einzelne Extensions lassen sich mit `pi config` gezielt
deaktivieren, ohne sie zu löschen.

## Abgrenzung zu den pi-Beispielen

pi liefert mit `confirm-destructive.ts`, `protected-paths.ts` und `notify.ts`
Beispiele mit ähnlichem Namen. Der Unterschied:

- **Schreib-Allowlist statt pauschaler Blockade** — `~/.pi` und das aktive Projekt
  dürfen ohne Nachfrage geschrieben werden. Ohne das fragt die Extension bei jedem
  eigenen Skill, Prompt oder `MEMORY.md`-Schreibvorgang nach.
- **Härtung gegen Verschleierung**: `$HOME`/`${HOME}` und `~` werden im Pfad expandiert,
  das Ziel danach `realpath`-aufgelöst — ein Redirect über einen Symlink nach `~/.ssh`
  wird also erkannt. Nicht statisch auflösbare Ziele (`$FOO`, `$(cmd)`) bleiben ungeprüft.
- **Gilt für beide Schreibwege** — dieselbe Prüfung für `write`/`edit` und für
  Bash-Umleitung, `tee`, `cp`, `mv` (inkl. Quote-Wrapping als Tarnversuch).
- **Sicheres cwd** — ist das Arbeitsverzeichnis selbst `~`, bleibt nur `~/.pi` freigegeben.
