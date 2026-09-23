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
 *   write/edit (Allowlist-Policy):
 *   - Erlaubt ohne Nachfrage: Schreiben in pi selbst (~/.pi) und das
 *     aktuelle Projekt (cwd, außer cwd=~). Nachfrage: alles außerhalb.
 *     Gilt auch für Schreibzugriffe per bash (Umleitung/tee/cp/mv nach
 *     ~/.pi): dieselbe Allowlist, ebenfalls ohne Nachfrage.
 *     Destruktive Befehle (bash) bleiben immer guarded.
 *   - Auch innerhalb erlaubter Wurzeln geschützt: .git-Interna
 *     (Repository-Korruption)
 *   - Außerhalb: ~/.ssh, ~/.gnupg, ~/.aws, ~/.kube,
 *     Shell-RCs (.zshrc, .bashrc, .profile, …), ~/.mnemon, ~/pi-gateway/dc-account
 *   bash (Schreibzugriffe auf sensible Pfade):
 *   - Umleitungen (>, >>, 2>, &>), tee, cp/mv/install-Ziel, die auf einen
 *     sensitiven Pfad (siehe SENSITIVE_PATHS), in .git-Interna oder auf
 *     Systempfade (/etc, /usr, /Library …, aber nicht /dev/null) schreiben
 *     Härtung wie bei write/edit: $HOME/${HOME} + Tilde werden expandiert und
 *     das Ziel realpath-aufgelöst (Symlink-Escape, z. B. Redirect über einen
 *     Link nach ~/.ssh). Nur statisch auflösbare Ziele werden geprüft;
 *     Variablen/Subshells bleiben (wie bisher) ungeprüft.
 *   (Bewusst NICHT abgedeckt: Schreibzugriffe per bash außerhalb des Projekts
 *   auf unsensible Pfade – zu viele Fehlalarme im Alltag.)
 *
 * Installation: nach ~/.pi/agent/extensions/ legen, in pi: /reload
 * Anpassung: Konstanten unten (PROTECTED_ROOT, HOME_STD, SENSITIVE_PATHS).
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/* -------------------- Tuning-Konstanten -------------------- */

/** Systemverzeichnisse auf Root-Ebene – rm -rf dort = Katastrophe */
const PROTECTED_ROOT = new Set([
	"System", "Library", "usr", "etc", "bin", "sbin", "var", "private",
	"Applications", "Volumes", "dev", "cores", "opt", "home",
]);

/** Standard-Home-Ordner – komplettes Löschen davon lohnt eine Nachfrage */
const HOME_STD = new Set([
	"Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", "Public", "Library",
]);

/** sensitive Pfade/Dateien, die edit/write nicht anfassen sollte */
const SENSITIVE_PATHS = [
	".git",
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".netrc",
	".npmrc",
	".zshrc", ".zprofile", ".zshenv",
	".bashrc", ".bash_profile", ".profile",
	// ".pi" bewusst NICHT hier: Schreiben in pi selbst (~/.pi) ist laut
	// Allowlist-Policy (write/edit UND bash-Schreibziele) ohne Nachfrage erlaubt.
	".mnemon",
	"pi-gateway/dc-account",   // Bot-Identität (DeltaChat-Zugangsdaten)
];

/* -------------------- Helpers -------------------- */

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return joinPath(homedir(), p.slice(2));
	return p;
}

/** $HOME und ${HOME} im Pfad-String expandieren (expandTilde deckt nur ~/ ab).
 *  Nicht auflösbare Konstrukte ($FOO, $(cmd), `cmd`) bleiben unangetastet und
 *  werden wie bisher nicht statisch geprüft. */
function expandHomeVars(p: string): string {
	// Boundary: $HOMEWORK & Co. dürfen nicht fehl-expandieren
	return p.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, homedir());
}

function joinPath(a: string, b: string): string {
	return a.endsWith("/") ? a + b : a + "/" + b;
}

function cwdOf(ctx: { cwd?: string }): string {
	return ctx.cwd ?? process.cwd();
}

/** Top-Level-Segment eines absoluten Pfads relativ zu "/" */
function topSegment(abs: string): string {
	const rel = relative("/", abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return "";
	return rel.split(sep)[0] ?? "";
}

/** rm-Ziel: katastrophal? (Systempfade, HOME selbst, ganze Home-Ordner, Root-Wildcards) */
function isDangerousRmTarget(rawTarget: string, cwd: string): boolean {
	const t = rawTarget.trim();
	if (!t || t.startsWith("-")) return false;

	// Root-/Home-Wildcards wie /* oder ~/*
	if (t.includes("*")) {
		const base = t.replace(/\*(\/\*)*$/, "").replace(/\/+$/, "") || "/";
		if (base === "/" || expandTilde(base) === homedir()) return true;
	}

	// Relative Ziele gegen das Projektverzeichnis auflösen (nicht process.cwd())
	const abs = resolve(cwd, expandTilde(t));
	if (abs === "/") return true;
	if (PROTECTED_ROOT.has(topSegment(abs))) return true;

	const home = homedir();
	if (abs === home) return true;
	const relHome = relative(home, abs);
	if (relHome && !relHome.startsWith("..") && !isAbsolute(relHome)) {
		if (HOME_STD.has(relHome.split(sep)[0])) return true;
	}
	if (abs === "/dev" || abs.startsWith("/dev/")) return true;
	if (abs === "/Volumes" || abs.startsWith("/Volumes/")) return true;
	return false;
}

interface RmCheck { dangerous: boolean; targets: string[] }

/** rm-Aufruf in einem Command-Segment prüfen */
function checkRm(segment: string, cwd: string): RmCheck {
	const args = segment.trim().split(/\s+/);
	// sudo/env vor rm erlauben
	let i = 0;
	while (i < args.length && ["sudo", "env", "command"].includes(args[i])) i++;
	if (args[i] !== "rm") return { dangerous: false, targets: [] };
	i++;

	let recursive = false;
	const targets: string[] = [];
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === "--") continue;
		if (a.startsWith("-") && !a.startsWith("--")) {
			if (/[rR]/.test(a.slice(1))) recursive = true;
			continue;
		}
		if (a.startsWith("--")) continue; // --preserve-root etc.
		targets.push(a);
	}

	if (!recursive) return { dangerous: false, targets: [] }; // rm -f einzelne Datei: ok
	const bad = targets.filter((t) => isDangerousRmTarget(t, cwd));
	return { dangerous: bad.length > 0, targets: bad };
}

/** Sensible Pfade treffen diesen absoluten Pfad? (für write/edit UND bash) */
function sensitiveHits(abs: string): string[] {
	const hits: string[] = [];
	for (const s of SENSITIVE_PATHS) {
		if (abs === resolve(homedir(), s) || abs.startsWith(resolve(homedir(), s) + "/")) {
			hits.push(`~/${s}`);
			break;
		}
	}
	if (inGitInternals(abs)) {
		hits.push(".git-Interna (Gefahr: Repository-Korruption)");
	}
	return hits;
}

/** Schreibende bash-Ziele im Segment: Umleitungen, tee, cp/mv/install-Ziel */
function bashWriteTargets(segment: string): string[] {
	const targets: string[] = [];
	// Umleitungen: >, >>, 2>, 2>>, &>, &>> (Ziel bis zum nächsten Separator)
	for (const m of segment.matchAll(/(?:\d|&)?>>?\s*([^\s;&|<>]+)/g)) {
		if (m[1]) targets.push(m[1]);
	}
	// tee: alle Datei-Argumente (Optionen wegfiltern)
	const tee = segment.match(/\btee\b[^;|&]*/g);
	if (tee) {
		for (const t of tee) {
			const args = t.split(/\s+/).filter((a) => a && !a.startsWith("-") && a !== "tee");
			for (const a of args) targets.push(a);
		}
	}
	// cp/mv/install: letztes Argument ist das Ziel
	if (/\b(?:cp|mv|install)\b/.test(segment)) {
		const args = segment.trim().split(/\s+/);
		const last = args[args.length - 1];
		if (last && !last.startsWith("-")) targets.push(last);
	}
	return targets;
}

/** Bash-Schreibziel mit derselben Härtung wie write/edit auflösen:
 *  $HOME/${HOME} + Tilde expandieren, dann realpath (Symlink-Escape).
 *  Liefert realpathSafe den Fallback (nicht existent/unauflösbar), gilt der
 *  lexikalische Pfad wie bisher. */
function resolveBashWriteTarget(t: string, cwd: string): string {
	// Umgebende Quotes strippen (z. B. "> \"$HOME/.ssh/x\"" via $HOME-Escapes),
	// damit Quote-Wrapping nicht als Tarnung vor der Expansion schützt
	const raw = t.replace(/^["']+|["']+$/g, "");
	return realpathSafe(resolve(cwd, expandTilde(expandHomeVars(raw))));
}

/** Alle gefährlichen Muster in einem Bash-Command finden */
function findBashDangers(command: string, cwd: string): string[] {
	const dangers: string[] = [];
	// Segmente: &&, ||, ;, |, Zeilenumbrüche
	const segments = command.split(/&&|\|\||;|\||\r?\n/);

	for (const seg of segments) {
		const s = seg.trim();
		if (!s) continue;

		const rm = checkRm(s, cwd);
		if (rm.dangerous) {
			dangers.push(`rm -rf auf: ${rm.targets.join(", ")}`);
			continue;
		}

		const low = s.toLowerCase();

		// dd in Gerät schreiben
		if (/\bdd\b/.test(low) && /of=\/dev\//.test(low)) dangers.push("dd schreibt auf ein Gerät (/dev/…)");

		// Dateisystem löschen / Reboot
		if (/^mkfs/.test(low) || /\bdiskutil\b/.test(low) && /\berase/.test(low))
			dangers.push("Dateisystem/Volume formatieren");
		if (/^(sudo\s+)?(shutdown|halt|reboot)\b/.test(low)) dangers.push("System herunterfahren/neustarten");

		// chmod -R 000/777 auf Root oder Home
		if (/chmod\b/.test(low) && /-R\b|--recursive\b/.test(low) && /\b(000|777)\b/.test(low)) {
			const abs = resolve(cwd, expandTilde(s.split(/\s+/).filter((a) => !a.startsWith("-")).pop() ?? ""));
			if (abs === "/" || abs === homedir()) dangers.push(`chmod -R rekursiv auf ${abs}`);
		}

		// Fork-Bombe
		if (/:\s*\(\s*\)\s*\{/.test(s)) dangers.push("Fork-Bombe erkannt");

		// SQL: DROP DATABASE / DROP SCHEMA
		if (/\bdrop\s+(database|schema)\b/.test(low)) dangers.push("DROP DATABASE/SCHEMA");

		// git force-push auf geschützte Branches
		if (/\bgit\b.*\bpush\b/.test(low) && /(--force|--force-with-lease|\s-f\s)/.test(low) && /\b(main|master|production|release)\b/.test(low))
			dangers.push("git push --force auf geschützten Branch");

		// curl/wget | sh – beliebigen Remote-Code ausführen
		if (/\b(curl|wget)\b/.test(low) && /\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(s))
			dangers.push("curl/wget wird direkt in eine Shell gepipt (Remote-Code-Ausführung)");

		// bash-Schreibzugriffe (Umleitung, tee, cp/mv) auf sensible/Systempfade
		// (Härtung identisch zu write/edit: $HOME/Tilde-Expansion + realpath)
		for (const t of bashWriteTargets(s)) {
			const abs = resolveBashWriteTarget(t, cwd);
			for (const hit of sensitiveHits(abs)) dangers.push(`bash-Schreibzugriff auf ${hit}`);
			if (abs !== "/dev/null" && PROTECTED_ROOT.has(topSegment(abs))) {
				dangers.push(`Schreibzugriff auf Systempfad (${abs})`);
			}
		}
	}
	return dangers;
}

/** Liegt abs innerhalb von root (inkl. root selbst)? */
function isInside(root: string, abs: string): boolean {
	const rel = relative(root, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Pfad realpath-aufgelöst; existiert er (noch) nicht, den nächsten
 *  existierenden Vorfahren auflösen, sonst lexikalischer Fallback. */
function realpathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		try {
			return joinPath(realpathSync(dirname(p)), basename(p));
		} catch {
			return resolve(p);
		}
	}
}

/** ~/.pi, realpath-aufgelöst (falls Symlink) */
function piRoot(): string {
	return realpathSafe(joinPath(homedir(), ".pi"));
}

function inGitInternals(abs: string): boolean {
	return abs.includes(`${sep}.git${sep}`) || /(^|\/)\.git$/.test(abs);
}

/** write/edit-Pfad: braucht Bestätigung? (Allowlist-Policy, siehe Docstring) */
function findPathDangers(rawPath: string, cwd: string): string[] {
	const dangers: string[] = [];
	// Symlink-Härtung: Schreibziel UND cwd vor dem Wurzel-Vergleich
	// realpath-auflösen (sonst Symlink-Escape aus dem Projekt bzw. cwd
	// in anderer Schreibweise).
	const abs = realpathSafe(resolve(cwd, expandTilde(rawPath)));
	const cwdReal = realpathSafe(resolve(cwd));

	// Erlaubte Wurzeln: pi selbst (~/.pi) und das aktuelle Projekt (cwd).
	// Ist cwd das Home-Verzeichnis selbst, bleibt nur ~/.pi erlaubt
	// (sonst wäre das komplette Home freigegeben).
	const allowedRoots = [piRoot()];
	if (cwdReal !== realpathSafe(homedir())) allowedRoots.push(cwdReal);

	if (allowedRoots.some((root) => isInside(root, abs))) {
		// .git-Interna bleiben auch innerhalb erlaubter Wurzeln geschützt
		if (inGitInternals(abs)) dangers.push(".git-Interna (Gefahr: Repository-Korruption)");
		return dangers;
	}

	dangers.push("Pfad liegt außerhalb von ~/.pi und dem Projektverzeichnis");
	dangers.push(...sensitiveHits(abs).map((h) => (h.startsWith(".git") ? h : `sensitiver Pfad (${h})`)));
	return dangers;
}

/* -------------------- Extension -------------------- */

export default function destructiveGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		let dangers: string[] = [];

		if (isToolCallEventType<"bash", { command: string }>("bash", event)) {
			dangers = findBashDangers(event.input.command, cwdOf(ctx));
		} else if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: string };
			if (typeof input.path === "string") {
				dangers = findPathDangers(input.path, cwdOf(ctx));
			}
		}

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
	});
}