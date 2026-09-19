/**
 * done-notify.ts
 *
 * Desktop-Benachrichtigung (macOS) mit Ton, wenn pi mit der Antwort fertig ist
 * und auf Eingabe wartet. Für Nicht-macOS fällt es auf OSC-777-Terminal-Notify
 * zurück (Ghostty, iTerm2, WezTerm, Kitty ohne Ton).
 *
 * Commands:
 *   /notify-sound   – System-Klang auswählen (wird gespeichert)
 *   /notify-test    – Test-Benachrichtigung senden
 *
 * Konfiguration: ~/.pi/agent/done-notify.json
 *   { "sound": "Glass", "minSeconds": 15 }
 *   sound      – Name eines macOS-Systemsounds (siehe /notify-sound)
 *   minSeconds – nur benachrichtigen, wenn der Run mindestens so lange dauerte
 *                (0 = immer benachrichtigen; verhindert Notify-Spam bei Kurzfragen)
 *
 * Installation: nach ~/.pi/agent/extensions/ legen, in pi: /reload
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "done-notify.json");

/** Alle macOS-Systemsounds (/System/Library/Sounds) */
const SOUNDS = [
	"Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse",
	"Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
] as const;

const DEFAULTS = { sound: "Glass", minSeconds: 15 };

interface Config {
	sound?: string;
	minSeconds?: number;
}

function loadConfig(): Config {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
	} catch {
		return {};
	}
}

function saveConfig(cfg: Config): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function notifyMac(title: string, body: string, sound: string): void {
	const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name ${JSON.stringify(sound)}`;
	execFile("osascript", ["-e", script], () => {
		/* Fehler still ignorieren (z. B. Sound nicht gefunden) */
	});
}

function notifyOsc(title: string, body: string): void {
	// OSC 777 – Ghostty, iTerm2, WezTerm, rxvt-unicode
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

export default function doneNotify(pi: ExtensionAPI) {
	let runStartedAt = 0;

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
	});

	// agent_settled = pi läuft garantiert nicht weiter (kein Auto-Retry/Compaction mehr)
	pi.on("agent_settled", async (event, ctx) => {
		const cfg = { ...DEFAULTS, ...loadConfig() };
		const seconds = runStartedAt > 0 ? (Date.now() - runStartedAt) / 1000 : 0;
		runStartedAt = 0;
		if (seconds < (cfg.minSeconds ?? 0)) return;

		const body = "Fertig 🙂";
		if (process.platform === "darwin") {
			notifyMac("pi", body, cfg.sound ?? "Glass");
		} else {
			notifyOsc("pi", body);
		}
		void event;
		void ctx;
	});

	pi.registerCommand("notify-sound", {
		description: "Benachrichtigungs-Klang für „pi fertig“ wählen",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const cfg = { ...DEFAULTS, ...loadConfig() };
			const items = [...SOUNDS.map((s) => (s === cfg.sound ? `${s}  ✓ (aktiv)` : s))];
			const picked = await ctx.ui.select("System-Klang wählen", items);
			if (!picked) return;
			const sound = picked.replace(/\s+✓.*/, "");
			saveConfig({ ...cfg, sound });
			ctx.ui.notify(`Klang gespeichert: ${sound}`, "info");
			notifyMac("pi", "Test-Benachrichtigung", sound);
		},
	});

	pi.registerCommand("notify-test", {
		description: "Test-Benachrichtigung senden",
		handler: async (_args, ctx) => {
			const cfg = { ...DEFAULTS, ...loadConfig() };
			if (process.platform === "darwin") {
				notifyMac("pi", "Test-Benachrichtigung", cfg.sound ?? "Glass");
			} else {
				notifyOsc("pi", "Test-Benachrichtigung");
			}
			void ctx;
		},
	});
}