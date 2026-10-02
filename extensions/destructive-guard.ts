/**
 * destructive-guard.ts
 *
 * Blockt bzw. verlangt Bestätigung für SELTENE, aber KATASTROPHALE Aktionen –
 * bewusst so getunt, dass Alltags-Operationen (rm -rf node_modules, rm -rf /tmp/…,
 * rm -rf <projektordner>) NICHT fragen.
 *
 * Abgedeckt:
 *   bash:
 *   - rm -rf auf Systempfaden (/, /System, /Library, /usr, /etc, /bin, /sbin, /var,
 *     /private, /Applications, /Volumes, /dev), auf $HOME selbst und auf ganzen
 *     Standard-Home-Ordnern (~/Documents, ~/Desktop, …)
 *   - rm -rf mit Root-/Home-Wildcards (/*, ~/… mit * auf oberster Ebene)
 *   - dd … of=/dev/… (Platte überschreiben)
 *   - mkfs*, diskutil erase*, shutdown/halt/reboot
 *   - chmod -R 000/777 auf / oder $HOME
 *   - Fork-Bomben
 *   - DROP DATABASE / DROP SCHEMA (SQL)
 *   - git push --force auf main/master/production
 *   - curl|wget, das direkt in sh/bash/zsh gepipt wird (Remote-Code-Ausführung)
 *   write/edit (Allowlist-Policy mit FREIGABE-STUFEN):
 *   - Erlaubt ohne Nachfrage: Schreiben in pi selbst (~/.pi) und das
 *     aktuelle Projekt (cwd, außer cwd=~). Nachfrage: alles außerhalb –
 *     ABER als Auswahl mit Vorauswahl „freigeben“ (erste Option, Enter):
 *       1. Einmal ausführen
 *       2. Verzeichnis für diese Session freigeben (bis pi-Ende)
 *       3. Verzeichnis dauerhaft freigeben (write-allowlist.json,
 *          gilt auch in künftigen pi-Sessions)
 *       4. Nein, blockieren
 *     Freigegebene Verzeichnisse werden bei späteren write/edit-Prüfungen
 *     vorab geprüft → keine Nachfrage mehr. Gilt auch für Headless-Läufe.
 *   - Harte Anker bleiben IMMER hart, auch in freigegebenen Verzeichnissen:
 *     ~/.ssh, ~/.gnupg, ~/.aws, ~/.kube, Shell-RCs, ~/.mnemon,
 *     ~/pi-gateway/dc-account und .git-Interna (Repository-Korruption).
 *     Für sie gibt es nur „Einmal ausführen“ oder „Blockieren“.
 *   - Freigabe-Granularität: das nächstliegende EXISTIERENDE Verzeichnis
 *     über der Zieldatei (realpath-kanonisch), inkl. Unterordner – so greift
 *     die Freigabe auch für noch nicht existierende Unterpfade.
 *   - Auch innerhalb erlaubter Wurzeln geschützt: .git-Interna.
 *   bash (Schreibzugriffe auf sensible Pfade):
 *   - Umleitungen (>, >>, 2>, &>), tee, cp/mv/install-Ziel, die auf einen
 *     sensitiven Pfad (siehe SENSITIVE_PATHS), in .git-Interna oder auf
 *     Systempfade (/etc, /usr, /Library …, aber nicht /dev/null) schreiben.
 *     Härtung wie bei write/edit: $HOME/${HOME} + Tilde werden expandiert und
 *     das Ziel realpath-aufgelöst (Symlink-Escape, z. B. Redirect über einen
 *     Link nach ~/.ssh). Nur statisch auflösbare Ziele werden geprüft;
 *     Variablen/Subshells bleiben (wie bisher) ungeprüft.
 *   (Bewusst NICHT abgedeckt: Schreibzugriffe per bash außerhalb des Projekts
 *   auf unsensible Pfade – zu viele Fehlalarme im Alltag.)
 *
 * Commands:
 *   /freigaben – persistente Freigaben auflisten und einzelne entfernen;
 *                zeigt auch die Session-Freigaben der laufenden Session an.
 *
 * Persistenter Speicher: ~/.pi/agent/write-allowlist.json
 *   { "grants": [ { "path": "...", "grantedAt": "...", "grantedFrom": "..." } ] }
 *
 * Installation: über das pi-Paket (pi install …), in pi: /reload
 * Anpassung: Konstanten in destructive-guard-lib.ts (PROTECTED_ROOT, HOME_STD,
 * SENSITIVE_PATHS).
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	addGrant,
	cwdOf,
	findBashDangers,
	findPathDangers,
	GRANTS_PATH,
	loadGrants,
	realpathSafe,
	removeGrant,
} from "./destructive-guard-lib.ts";

/* -------------------- Extension -------------------- */

export default function destructiveGuard(pi: ExtensionAPI) {
	// Session-Freigaben: Verzeichniswurzeln (realpath-kanonisch), gelten bis
	// zum Ende dieses pi-Prozesses (auch über /reload hinaus? Nein – Modul-
	// neuierung bei Reload setzt sie zurück; persistente Freigaben bleiben).
	const sessionGrants = new Set<string>();

	/** Aktuell geltende Zusatz-Wurzeln: Session + persistent (jedes Mal frisch
	 *  gelesen, damit /freigaben-Löschungen sofort wirken). */
	function extraRoots(): string[] {
		return [...sessionGrants, ...loadGrants().grants.map((g) => g.path)];
	}

	pi.on("tool_call", async (event, ctx) => {
		const cwd = cwdOf(ctx);

		if (isToolCallEventType<"bash", { command: string }>("bash", event)) {
			const dangers = findBashDangers(event.input.command, cwd);
			if (dangers.length === 0) return;

			const detail = dangers.join("\n");
			// Ohne UI (z. B. Headless/RPC) sicher blocken statt still durchlaufen lassen
			if (!ctx.hasUI) {
				return { block: true, reason: `Blockiert (destruktive Aktion, keine Bestätigung möglich):\n${detail}` };
			}
			const ok = await ctx.ui.confirm(
				"Destruktive Aktion erlaubt?",
				`${detail}\n\nTrotzdem ausführen?`,
			);
			if (!ok) {
				ctx.ui.notify("Aktion blockiert", "warning");
				return { block: true, reason: `Vom Nutzer abgelehnt:\n${detail}` };
			}
			ctx.ui.notify("Einmalig erlaubt", "info");
			return;
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: string };
			if (typeof input.path !== "string") return;

			const check = findPathDangers(input.path, cwd, extraRoots());
			if (check.dangers.length === 0) return;

			const detail = check.dangers.join("\n");
			const home = realpathSafe(homedir());

			// Headless/RPC: fail-closed, aber Freigaben wurden schon vorab geprüft
			if (!ctx.hasUI) {
				const hint = check.grantableDir
					? `\n\nHinweis: In einer interaktiven Session lässt sich "${check.grantableDir}" freigeben (Session-Freigabe) oder dauerhaft in ${GRANTS_PATH} eintragen – danach läuft dieser Pfad auch headless ohne Block.`
					: "";
				return { block: true, reason: `Blockiert (destruktive Aktion, keine Bestätigung möglich):\n${detail}${hint}` };
			}

			// Dialog: Vorauswahl = freigeben (erste Option, Enter)
			if (check.grantableDir) {
				const homeNote = check.grantableDir === home ? " (komplettes Home – bewusst?)" : "";
				const choice = await ctx.ui.select(
					`Schreibzugriff außerhalb von ~/.pi und Projekt:\n\n${detail}\n\nZiel: ${input.path}\nFreigabe-Stufe?`,
					[
						`Einmal ausführen`,
						`Verzeichnis für diese Session freigeben: ${check.grantableDir}${homeNote}`,
						`Dauerhaft freigeben (auch künftige Sessions): ${check.grantableDir}${homeNote}`,
						"Nein, blockieren",
					],
				);
				if (!choice || choice.startsWith("Nein")) {
					ctx.ui.notify("Aktion blockiert", "warning");
					return { block: true, reason: `Vom Nutzer abgelehnt:\n${detail}` };
				}
				if (choice.startsWith("Verzeichnis für diese Session")) {
					sessionGrants.add(check.grantableDir);
					ctx.ui.notify(`Session-Freigabe: ${check.grantableDir}`, "info");
					return; // freigegeben
				}
				if (choice.startsWith("Dauerhaft")) {
					const changed = addGrant({
						path: check.grantableDir,
						grantedAt: new Date().toISOString(),
						grantedFrom: cwd,
					});
					sessionGrants.add(check.grantableDir);
					ctx.ui.notify(
						changed
							? `Dauerhafte Freigabe gespeichert: ${check.grantableDir}`
							: `Freigabe existierte schon: ${check.grantableDir}`,
						"info",
					);
					return; // freigegeben
				}
				ctx.ui.notify("Einmalig erlaubt", "info");
				return;
			}

			// Harte Treffer (sensitiv/.git): nur „Einmal ausführen“ oder „Blockieren“
			const ok = await ctx.ui.confirm(
				"Sensitiver Pfad",
				`${detail}\n\nTrotzdem ausführen?`,
			);
			if (!ok) {
				ctx.ui.notify("Aktion blockiert", "warning");
				return { block: true, reason: `Vom Nutzer abgelehnt:\n${detail}` };
			}
			ctx.ui.notify("Einmalig erlaubt", "info");
		}
	});

	pi.registerCommand("freigaben", {
		description: "Persistente Schreib-Freigaben anzeigen/entfernen (write-allowlist.json)",
		handler: async (_args, ctx) => {
			const file = loadGrants();
			const sessionList = [...sessionGrants];

			if (!ctx.hasUI) {
				const lines = [
					`Persistente Freigaben (${file.grants.length}, Datei ${GRANTS_PATH}):`,
					...file.grants.map((g) => `- ${g.path}  (${g.grantedAt}, von ${g.grantedFrom})`),
					`Session-Freigaben (${sessionList.length}, bis pi-Ende):`,
					...sessionList.map((p) => `- ${p}`),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (file.grants.length === 0 && sessionList.length === 0) {
				ctx.ui.notify("Keine Freigaben vorhanden.", "info");
				return;
			}

			if (file.grants.length > 0) {
				const items = file.grants.map(
					(g) => `${g.path}  —  ${g.grantedAt.slice(0, 10)}${g.grantedFrom ? `, von ${g.grantedFrom}` : ""}`,
				);
				const picked = await ctx.ui.select(
					`Persistente Freigabe entfernen? (Esc = nichts tun)\nDatei: ${GRANTS_PATH}`,
					items,
				);
				if (picked) {
					const target = file.grants[items.indexOf(picked)]?.path;
					if (target && await ctx.ui.confirm("Freigabe entfernen?", target)) {
						removeGrant(target);
						ctx.ui.notify(`Entfernt: ${target}`, "info");
					}
				}
			}

			if (sessionList.length > 0) {
				ctx.ui.notify(
					`Session-Freigaben (bis pi-Ende, nicht entfernbar):\n${sessionList.map((p) => `- ${p}`).join("\n")}`,
					"info",
				);
			}
		},
	});
}