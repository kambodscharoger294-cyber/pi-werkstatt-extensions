/**
 * confirm-notify.ts
 *
 * macOS-Benachrichtigung (mit Ton), sobald pi auf eine Bestätigung wartet –
 * also ein blockierender Dialog aufgeht (ja/nein, Auswahl, Texteingabe).
 * Damit verpasst man kein "ja oder nein klicken" mehr, wenn man woanders schaut.
 *
 * Auslöser: das pi-Event ui_prompt_start (feuert bei ctx.ui.confirm/select/
 * input/editor/custom – z. B. destructive-guard-Nachfragen, Modellwahl,
 * Trust-Dialog). Passendes Gegenstück zu done-notify.ts (das bei "fertig"
 * benachrichtigt).
 *
 * Commands:
 *   /confirm-test       – Test-Benachrichtigung senden
 *   /confirm-notify-sound – System-Klang auswählen (wird gespeichert)
 *
 * Konfiguration: ~/.pi/agent/confirm-notify.json
 *   { "sound": "Ping", "cooldownSeconds": 2 }
 *   sound           – macOS-Systemsound (/System/Library/Sounds)
 *   cooldownSeconds – Mindestabstand zwischen zwei Benachrichtigungen
 *                     (verhindert Stapeln, wenn mehrere Dialoge sofort
 *                     nacheinander aufgehen)
 *
 * Installation: nach ~/.pi/agent/extensions/ legen, in pi: /reload
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "confirm-notify.json");

const SOUNDS = [
	"Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse",
	"Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
] as const;

const DEFAULTS = { sound: "Ping", cooldownSeconds: 2 };

interface Config {
	sound?: string;
	cooldownSeconds?: number;
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
	// OSC 777 – Ghostty, iTerm2, WezTerm (Fallback ohne Ton)
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

export default function confirmNotify(pi: ExtensionAPI) {
	let lastNotifyAt = 0;

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (!ctx.hasUI) return; // print/JSON-Modus: kein echtes Warten auf Dialog

		const cfg = { ...DEFAULTS, ...loadConfig() };
		const now = Date.now();
		const cooldownMs = Math.max(0, (cfg.cooldownSeconds ?? 0) * 1000);
		if (now - lastNotifyAt < cooldownMs) return;
		lastNotifyAt = now;

		const body = "Hilfe 👋";

		if (process.platform === "darwin") {
			notifyMac("pi – Bestätigung nötig", body, cfg.sound ?? "Ping");
		} else {
			notifyOsc("pi – Bestätigung nötig", body);
		}
	});

	pi.registerCommand("confirm-test", {
		description: "Test-Benachrichtigung für „Bestätigung nötig“ senden",
		handler: async (_args, ctx) => {
			const cfg = { ...DEFAULTS, ...loadConfig() };
			if (process.platform === "darwin") {
				notifyMac("pi – Bestätigung nötig", "Hilfe 👋", cfg.sound ?? "Ping");
			} else {
				notifyOsc("pi – Bestätigung nötig", "Hilfe 👋");
			}
			void ctx;
		},
	});

	pi.registerCommand("confirm-notify-sound", {
		description: "Benachrichtigungs-Klang für „Bestätigung nötig“ wählen",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const cfg = { ...DEFAULTS, ...loadConfig() };
			const items = SOUNDS.map((s) => (s === cfg.sound ? `${s}  ✓ (aktiv)` : s));
			const picked = await ctx.ui.select("System-Klang wählen", items);
			if (!picked) return;
			const sound = picked.replace(/\s+✓.*/, "");
			saveConfig({ ...cfg, sound });
			ctx.ui.notify(`Klang gespeichert: ${sound}`, "info");
			notifyMac("pi – Bestätigung nötig", "Hilfe 👋", sound);
		},
	});
}
