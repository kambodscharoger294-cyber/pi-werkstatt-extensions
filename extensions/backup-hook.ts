/**
 * backup-hook.ts
 *
 * Sichert automatisch alle pi-Anpassungen (Extensions, Themes, Prompts, Skills,
 * Settings, mnemon-Daten) jedes Mal, wenn eine pi-Sitzung endet – per
 * ~/pi-anpassungen/backup.sh.
 *
 * Damit häufiges Beenden/Neuladen nicht den Backup-Ordner flutet, läuft das
 * Backup höchstens alle 10 Minuten (Merkmal in ~/pi-anpassungen/.last-backup).
 *
 * Stamp-Logik (seit 15.09. abends): backup.sh schreibt den Stamp SELBST, und
 * nur nach erfolgreichem Abschluss (set -e bricht vorher ab). Das Hook-Script
 * markiert nichts vorab – damit überlebt ein Fehlschlag auch den Fall, dass pi
 * sich beendet, bevor das detached-Kind fertig ist (kein Race mehr).
 *
 * Einfach ausstellen? Diese Datei in .ts.off umbenennen und /reload.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BACKUP_SCRIPT = join(homedir(), "pi-anpassungen", "backup.sh");
const STAMP_FILE = join(homedir(), "pi-anpassungen", ".last-backup");
const MIN_MINUTES = 10;

function backupDue(): boolean {
	if (!existsSync(STAMP_FILE)) return true;
	const last = statSync(STAMP_FILE).mtimeMs;
	return Date.now() - last >= MIN_MINUTES * 60 * 1000;
}

export default function backupHook(pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		if (!existsSync(BACKUP_SCRIPT)) return;
		if (!backupDue()) return;
		// detached: pi kann sich beenden, ohne aufs Backup zu warten.
		// Erfolg-Quittung (.last-backup) schreibt backup.sh selbst am Ende;
		// schlägt es fehl, fehlt der Stamp → nächster Sitzungswechsel wiederholt.
		const child = spawn("bash", [BACKUP_SCRIPT], { detached: true, stdio: "ignore" });
		child.unref();
	});
}
