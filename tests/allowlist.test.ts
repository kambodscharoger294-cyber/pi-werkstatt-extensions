/**
 * Tests für destructive-guard-lib.ts (bun test).
 *
 * Fokus: die Freigabe-Stufen (Session-/persistente extraRoots) dürfen NUR
 * die „liegt außerhalb“-Nachfrage aufheben — harte Anker (sensible Pfade,
 * .git-Interna) bleiben in jedem Fall hart.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	addGrant,
	findBashDangers,
	findPathDangers,
	GRANTS_PATH,
	loadGrants,
	nearestExistingDir,
	realpathSafe,
	removeGrant,
	saveGrants,
} from "../extensions/destructive-guard-lib.ts";

const HOME = realpathSafe(homedir());

// Temp-Wurzel direkt unter dem Home anlegen (dort greift das
// PROTECTED_ROOT-Muster nicht; /private/var unter macOS würde es)
const root = mkdtempSync(join(homedir(), ".pi-guard-test-"));
const project = join(root, "proj");
const other = join(root, "other");
mkdirSync(project, { recursive: true });
mkdirSync(other, { recursive: true });
const projectReal = realpathSafe(project);
const otherReal = realpathSafe(other);

function cleanup() {
	rmSync(root, { recursive: true, force: true });
	rmSync(GRANTS_PATH, { force: true }); // Tests dürfen den echten Speicher nicht anfassen
}

describe("findPathDangers — Allowlist-Basis (ohne Freigaben)", () => {
	test("Pfad im Projekt: erlaubt, keine harten Treffer", () => {
		const r = findPathDangers(join(project, "src/neu.ts"), project);
		expect(r.dangers).toEqual([]);
		expect(r.grantableDir).toBeNull();
	});

	test("Pfad in ~/.pi: erlaubt", () => {
		const r = findPathDangers("~/.pi/test.md", project);
		expect(r.dangers).toEqual([]);
	});

	test("Pfad außerhalb: dangers + grantableDir = nächstliegendes existierendes Verzeichnis", () => {
		const r = findPathDangers(join(other, "notiz.md"), project);
		expect(r.dangers[0]).toContain("außerhalb");
		expect(r.grantableDir).toBe(otherReal);
	});

	test("Noch nicht existierende Unterordner: grantableDir = existierender Vorfahre", () => {
		const r = findPathDangers(join(other, "a/b/c/x.md"), project);
		expect(r.dangers[0]).toContain("außerhalb");
		expect(r.grantableDir).toBe(otherReal);
	});
});

describe("findPathDangers — Freigaben (Session/persistent als extraRoots)", () => {
	test("freigegebenes Verzeichnis: keine dangers", () => {
		const r = findPathDangers(join(other, "notiz.md"), project, [otherReal]);
		expect(r.dangers).toEqual([]);
		expect(r.grantableDir).toBeNull();
	});

	test("freigegebene tiefere Struktur: Unterordner abgedeckt", () => {
		mkdirSync(join(other, "tief"), { recursive: true });
		const r = findPathDangers(join(other, "tief/noch/gerader/x.md"), project, [otherReal]);
		expect(r.dangers).toEqual([]);
	});

	test("andere Freigabe hilft nicht: weiterhin „außerhalb“ mit grantableDir", () => {
		const r = findPathDangers(join(other, "notiz.md"), project, [projectReal]);
		expect(r.dangers[0]).toContain("außerhalb");
		expect(r.grantableDir).toBe(otherReal);
	});
});

describe("findPathDangers — harte Anker bleiben hart", () => {
	test("~/.ssh auch bei Freigabe des kompletten Home blockiert, kein grantableDir", () => {
		const r = findPathDangers("~/.ssh/id_ed25519", project, [HOME]);
		expect(r.dangers.join("\n")).toContain("~/.ssh");
		expect(r.grantableDir).toBeNull();
	});

	test(".git-Interna im Projekt bleiben geschützt (auch mit Freigaben)", () => {
		const r = findPathDangers(join(project, ".git/objects/aa/bb"), project, [otherReal, HOME]);
		expect(r.dangers.join("\n")).toContain(".git-Interna");
		expect(r.grantableDir).toBeNull();
	});

	test("~/.zshrc außerhalb bleibt sensitiv", () => {
		const r = findPathDangers("~/.zshrc", project);
		const all = r.dangers.join("\n");
		expect(all).toContain("sensitiver Pfad (~/.zshrc)");
		expect(r.grantableDir).toBeNull();
	});
});

describe("Freigaben-Speicher (write-allowlist.json)", () => {
	test("roundtrip über separate Temp-Datei", () => {
		const path = join(root, "allowlist.json");
		expect(loadGrants(path).grants).toEqual([]);
		saveGrants({ grants: [{ path: otherReal, grantedAt: "2026-10-02T00:00:00Z", grantedFrom: project }] }, path);
		const loaded = loadGrants(path);
		expect(loaded.grants).toHaveLength(1);
		expect(loaded.grants[0].path).toBe(otherReal);

		// addGrant idempotent (ohne file-Argument: lädt + speichert)
		expect(addGrant({ path: otherReal, grantedAt: "x", grantedFrom: "y" }, undefined, path)).toBe(false);
		expect(addGrant({ path: join(root, "zwei"), grantedAt: "x", grantedFrom: "y" }, undefined, path)).toBe(true);
		expect(loadGrants(path).grants).toHaveLength(2);

		// removeGrant (ohne file-Argument: lädt + speichert)
		expect(removeGrant(otherReal, undefined, path)).toBe(true);
		expect(loadGrants(path).grants).toHaveLength(1);
	});

	test("kaputte/fehlende Datei → leerer Stand statt Crash", () => {
		writeFileSync(join(root, "kaputt.json"), "{kein json", "utf8");
		expect(loadGrants(join(root, "kaputt.json")).grants).toEqual([]);
		expect(loadGrants(join(root, "gibts-nicht.json")).grants).toEqual([]);
	});
});

describe("nearestExistingDir", () => {
	test("existierendes Verzeichnis → realpath", () => {
		expect(nearestExistingDir(other)).toBe(otherReal);
	});

	test("nicht existierende Tiefe → nächster existierender Vorfahre", () => {
		expect(nearestExistingDir(join(other, "x/y/z"))).toBe(otherReal);
	});
});

describe("findBashDangers — Regressionen (unverändert, Freigaben greifen hier nicht)", () => {
	test("rm -rf ~/Documents fragt, rm -rf node_modules nicht", () => {
		expect(findBashDangers("rm -rf ~/Documents", project).length).toBeGreaterThan(0);
		expect(findBashDangers("rm -rf node_modules", project)).toEqual([]);
	});

	test("Umleitung nach ~/.ssh wird erkannt", () => {
		const dangers = findBashDangers('echo x > "$HOME/.ssh/config"', project);
		expect(dangers.join("\n")).toContain("bash-Schreibzugriff auf ~/.ssh");
	});

	test("Umleitung nach /dev/null ist ok", () => {
		expect(findBashDangers("echo x > /dev/null", project)).toEqual([]);
	});
});

process.on("exit", cleanup);