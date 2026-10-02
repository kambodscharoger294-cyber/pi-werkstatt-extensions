/**
 * destructive-guard-lib.ts
 *
 * Reine Prüfling-Logik für destructive-guard.ts – bewusst OHNE Importe aus
 * @earendil-works/pi-coding-agent, damit die bun-Tests (tests/allowlist.test.ts)
 * die Datei direkt importieren können, ohne das pi-Paket auflösen zu müssen.
 *
 * Inhalt:
 *   - Bash-Gefahrenprüfung (Katastrophen-Muster, sensible Schreibziele)
 *   - write/edit-Prüfung mit Allowlist-Policy und FREIGABE-STUFEN:
 *       Standard erlaubt: ~/.pi und cwd (cwd=~ → nur ~/.pi)
 *       extraRoots: zusätzlich freigegebene Wurzeln (Session + persistent)
 *       Ergebnis: { dangers, grantableDir }
 *         dangers      – harte Treffer (sensitiv, .git-Interna, „außerhalb“)
 *         grantableDir – Verzeichnis, dessen Freigabe künftige Nachfragen für
 *                        diesen Pfad wegfallen lässt (nur wenn KEINE harten
 *                        Treffer vorliegen)
 *   - Persistenter Freigaben-Speicher (write-allowlist.json)
 *
 * Harte Anker bleiben IMMER hart: Freigaben locken niemals SENSITIVE_PATHS
 * (~/.ssh, ~/.gnupg, …) oder .git-Interna, auch nicht bei Freigabe von $HOME.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/* -------------------- Tuning-Konstanten -------------------- */

/** Systemverzeichnisse auf Root-Ebene – rm -rf dort = Katastrophe */
export const PROTECTED_ROOT = new Set([
	"System", "Library", "usr", "etc", "bin", "sbin", "var", "private",
	"Applications", "Volumes", "dev", "cores", "opt", "home",
]);

/** Standard-Home-Ordner – komplettes Löschen davon lohnt eine Nachfrage */
export const HOME_STD = new Set([
	"Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", "Public", "Library",
]);

/** Sensible Pfade/Dateien, die write/edit NICHT anfassen darf – auch nicht
 *  in freigegebenen Verzeichnissen. */
export const SENSITIVE_PATHS = [
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

/** Persistenter Freigaben-Speicher (analog confirm-notify.json) */
export const GRANTS_PATH = resolve(homedir(), ".pi/agent/write-allowlist.json");

export interface Grant {
	/** realpath-kanonischer Verzeichnispfad */
	path: string;
	/** ISO-Zeitstempel der Freigabe */
	grantedAt: string;
	/** cwd, aus dem heraus freigegeben wurde (nur Info) */
	grantedFrom: string;
}

export interface GrantsFile {
	grants: Grant[];
}

export interface PathCheck {
	/** Harte Treffer – Nachfrage (oder Headless-Block), nicht freigebbar */
	dangers: string[];
	/** Freigebbares Verzeichnis (null = nur „Einmal ausführen“/„Blockieren“) */
	grantableDir: string | null;
}

/* -------------------- Pfad-Helfer -------------------- */

export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return joinPath(homedir(), p.slice(2));
	return p;
}

/** $HOME und ${HOME} im Pfad-String expandieren (expandTilde deckt nur ~/ ab).
 *  Nicht auflösbare Konstrukte ($FOO, $(cmd), `cmd`) bleiben unangetastet und
 *  werden wie bisher nicht statisch geprüft. */
export function expandHomeVars(p: string): string {
	// Boundary: $HOMEWORK & Co. dürfen nicht fehl-expandieren
	return p.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, homedir());
}

export function joinPath(a: string, b: string): string {
	return a.endsWith("/") ? a + b : a + "/" + b;
}

export function cwdOf(ctx: { cwd?: string }): string {
	return ctx.cwd ?? process.cwd();
}

/** Top-Level-Segment eines absoluten Pfads relativ zu "/" */
export function topSegment(abs: string): string {
	const rel = relative("/", abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return "";
	return rel.split(sep)[0] ?? "";
}

/** Liegt abs innerhalb von root (inkl. root selbst)? */
export function isInside(root: string, abs: string): boolean {
	const rel = relative(root, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Pfad realpath-aufgelöst; existiert er (noch) nicht, den nächsten
 *  existierenden Vorfahren auflösen, sonst lexikalischer Fallback. */
export function realpathSafe(p: string): string {
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

/** Nächstliegendes existierendes Verzeichnis über p hinaus (aufwärts laufen,
 *  bis realpathSync klappt). Basis für die Freigabe-Granularität: Freigaben
 *  gelten pro Verzeichnis, auch wenn die Zieldatei/Unterordner noch nicht
 *  existieren. */
export function nearestExistingDir(p: string): string {
	let cur = resolve(p);
	for (;;) {
		try {
			return realpathSync(cur);
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return cur;
			cur = parent;
		}
	}
}

/** ~/.pi, realpath-aufgelöst (falls Symlink) */
export function piRoot(): string {
	return realpathSafe(joinPath(homedir(), ".pi"));
}

export function inGitInternals(abs: string): boolean {
	return abs.includes(`${sep}.git${sep}`) || /(^|\/)\.git$/.test(abs);
}

/* -------------------- Freigaben-Speicher -------------------- */

export function loadGrants(path: string = GRANTS_PATH): GrantsFile {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GrantsFile>;
		const grants = Array.isArray(raw.grants) ? raw.grants : [];
		return {
			grants: grants
				.filter((g): g is Grant => typeof g?.path === "string" && g.path !== "")
				.map((g) => ({ path: g.path, grantedAt: String(g.grantedAt ?? ""), grantedFrom: String(g.grantedFrom ?? "") })),
		};
	} catch {
		return { grants: [] };
	}
}

export function saveGrants(file: GrantsFile, path: string = GRANTS_PATH): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

/** Freigabe anhängen (idempotent – Pfad nur einmal). Liefert true bei Änderung. */
export function addGrant(grant: Grant, file?: GrantsFile, path: string = GRANTS_PATH): boolean {
	const f = file ?? loadGrants(path);
	if (f.grants.some((g) => g.path === grant.path)) return false;
	f.grants.push(grant);
	if (!file) saveGrants(f, path);
	return true;
}

/** Persistenten Pfad entfernen. Liefert true, wenn entfernt wurde. */
export function removeGrant(path: string, file?: GrantsFile, grantsPath: string = GRANTS_PATH): boolean {
	const f = file ?? loadGrants(grantsPath);
	const before = f.grants.length;
	f.grants = f.grants.filter((g) => g.path !== path);
	if (!file && f.grants.length !== before) saveGrants(f, grantsPath);
	return f.grants.length !== before;
}

/* -------------------- rm / bash-Gefahren -------------------- */

/** rm-Ziel: katastrophal? (Systempfade, HOME selbst, ganze Home-Ordner, Root-Wildcards) */
export function isDangerousRmTarget(rawTarget: string, cwd: string): boolean {
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

export interface RmCheck { dangerous: boolean; targets: string[] }

/** rm-Aufruf in einem Command-Segment prüfen */
export function checkRm(segment: string, cwd: string): RmCheck {
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
export function sensitiveHits(abs: string): string[] {
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
export function bashWriteTargets(segment: string): string[] {
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
export function resolveBashWriteTarget(t: string, cwd: string): string {
	// Umgebende Quotes strippen (z. B. "> \"$HOME/.ssh/x\"" via $HOME-Escapes),
	// damit Quote-Wrapping nicht als Tarnung vor der Expansion schützt
	const raw = t.replace(/^["']+|["']+$/g, "");
	return realpathSafe(resolve(cwd, expandTilde(expandHomeVars(raw))));
}

/** Alle gefährlichen Muster in einem Bash-Command finden */
export function findBashDangers(command: string, cwd: string): string[] {
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

/* -------------------- write/edit-Prüfung (Allowlist + Freigaben) -------------------- */

/** write/edit-Pfad prüfen (Allowlist-Policy mit Freigabe-Stufen, siehe oben).
 *  extraRoots: kanonische Verzeichniswurzeln aus Session- und persistenten
 *  Freigaben. Harte Treffer (sensitiv, .git-Interna) bleiben IMMER hart. */
export function findPathDangers(rawPath: string, cwd: string, extraRoots: string[] = []): PathCheck {
	// Symlink-Härtung: Schreibziel UND cwd vor dem Wurzel-Vergleich
	// realpath-auflösen (sonst Symlink-Escape aus dem Projekt bzw. cwd
	// in anderer Schreibweise).
	const abs = realpathSafe(resolve(cwd, expandTilde(rawPath)));
	const cwdReal = realpathSafe(resolve(cwd));

	// Harte Treffer – auch innerhalb erlaubter/freigegebener Wurzeln geschützt
	const hard = sensitiveHits(abs);

	// Erlaubte Wurzeln: pi selbst (~/.pi), das aktuelle Projekt (cwd) und
	// die Freigaben (Session + persistent). Ist cwd das Home-Verzeichnis
	// selbst, bleibt ~/.pi erlaubt (sonst wäre das komplette Home freigegeben).
	const allowedRoots = [piRoot(), ...extraRoots];
	if (cwdReal !== realpathSafe(homedir())) allowedRoots.push(cwdReal);

	if (allowedRoots.some((root) => isInside(root, abs))) {
		return { dangers: hard, grantableDir: null };
	}

	const dangers = [
		"Pfad liegt außerhalb von ~/.pi und dem Projektverzeichnis",
		...hard.map((h) => (h.startsWith(".git") ? h : `sensitiver Pfad (${h})`)),
	];
	// Freigabe nur anbieten, wenn keine harten Treffer vorliegen
	const grantableDir = hard.length === 0 ? nearestExistingDir(dirname(abs)) : null;
	return { dangers, grantableDir };
}