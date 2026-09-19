/**
 * web-search.ts – Websuche für pi über Exa und/oder Parallel.
 *
 * API-Keys liegen NUR im macOS-Schlüsselbund:
 *   Exa:      security add-generic-password -s pi-exa      -a "$USER" -w
 *   Parallel: security add-generic-password -s pi-parallel -a "$USER" -w
 *
 * Der Key wird zur Laufzeit über `security find-generic-password` geholt und
 * NIE ausgegeben, nie in Logs/Protokolle geschrieben.
 *
 * Status prüfen: /websearch-status in pi eingeben.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Provider = "exa" | "parallel";

/** Key aus dem Schlüsselbund holen – wird niemals geloggt oder zurückgegeben. */
async function getKey(service: string): Promise<string> {
	const { stdout } = await execFileAsync("security", [
		"find-generic-password", "-s", service, "-w",
	], { timeout: 5000 });
	const key = stdout.trim();
	if (!key) throw new Error("Schlüsselbund-Eintrag ist leer");
	return key;
}

async function hasKey(service: string): Promise<boolean> {
	try { await getKey(service); return true; } catch { return false; }
}

interface WebResult {
	title: string;
	url: string;
	date?: string;
	snippet: string;
	source: Provider;
}

/** Suche bei Exa (semantische/neurale Suche). */
async function searchExa(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<WebResult[]> {
	const res = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify({
			query,
			numResults,
			contents: { summary: true },
		}),
		signal,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		// body könnte im Fehlerfall sensitive Infos enthalten – nur Status melden
		throw new Error(`Exa-Fehler (HTTP ${res.status})`);
	}
	const data = await res.json() as {
		results?: Array<{ title?: string; url?: string; publishedDate?: string; summary?: string }>;
	};
	return (data.results ?? []).map(r => ({
		title: r.title ?? "(ohne Titel)",
		url: r.url ?? "",
		date: r.publishedDate?.slice(0, 10),
		snippet: r.summary ?? "",
		source: "exa",
	}));
}

/** Suche bei Parallel (Objective-basierte Agenten-Suche, Modus „fast"). */
async function searchParallel(query: string, numResults: number, key: string, signal?: AbortSignal): Promise<WebResult[]> {
	const res = await fetch("https://api.parallel.ai/v1/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify({
			objective: query,
			search_queries: [query],
			mode: "fast",
			advanced_settings: { max_results: numResults },
		}),
		signal,
	});
	if (!res.ok) {
		throw new Error(`Parallel-Fehler (HTTP ${res.status})`);
	}
	const data = await res.json() as {
		results?: Array<{ title?: string; url?: string; publish_date?: string; excerpts?: string[] }>;
	};
	return (data.results ?? []).map(r => ({
		title: r.title ?? "(ohne Titel)",
		url: r.url ?? "",
		date: r.publish_date?.slice(0, 10),
		snippet: (r.excerpts ?? []).join(" … ").slice(0, 600),
		source: "parallel",
	}));
}

/** Ganze Seiteninhalte nachladen (Exa Contents API), gekürzt. */
async function fetchExaContents(urls: string[], key: string, maxChars: number, signal?: AbortSignal): Promise<Record<string, string>> {
	const res = await fetch("https://api.exa.ai/contents", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify({ ids: urls, text: { maxCharacters: maxChars } }),
		signal,
	});
	if (!res.ok) throw new Error(`Exa-Contents-Fehler (HTTP ${res.status})`);
	const data = await res.json() as { contents?: Array<{ url?: string; text?: string }> };
	const out: Record<string, string> = {};
	for (const c of data.contents ?? []) {
		if (c.url) out[c.url] = (c.text ?? "").slice(0, maxChars);
	}
	return out;
}

function formatResults(results: WebResult[], contents?: Record<string, string>): string {
	if (results.length === 0) return "Keine Ergebnisse gefunden.";
	const parts = results.map((r, i) => {
		let block = `${i + 1}. ${r.title}\n   ${r.url}`;
		if (r.date) block += ` (${r.date})`;
		if (r.snippet) block += `\n   ${r.snippet}`;
		const content = contents?.[r.url];
		if (content) block += `\n   --- Seiteninhalt (gekürzt) ---\n   ${content.replaceAll("\n", " ").slice(0, 1500)}`;
		return block;
	});
	return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Websuche",
		description:
			"Websuche im Internet über Exa (semantische Suche, gut für thematische/fachliche Fragen) " +
			"oder Parallel (Objective-Suche, gut für aktuelle Fakten/News). " +
			"Bei provider=auto wird Exa versucht und bei Fehler/Quota-Ende automatisch Parallel genutzt. " +
			"Mit fetchContent=true werden die wichtigsten Seiten als Volltext mitgeliefert (braucht mehr Zeit, kostet mehr API-Kontingent).",
		parameters: Type.Object({
			query: Type.String({ description: "Suchanfrage, natürlich formuliert" }),
			provider: Type.Optional(StringEnum(["auto", "exa", "parallel"], {
				description: "Welcher Suchdienst. Standard: auto (erst Exa, dann Parallel als Ausweichoption)",
			})),
			numResults: Type.Optional(Type.Number({
				description: "Anzahl Ergebnisse (1–10, Standard 5)",
			})),
			fetchContent: Type.Optional(Type.Boolean({
				description: "true = Seiteninhalte der Ergebnisse zusätzlich als Text laden (Standard: false)",
			})),
		}),
		async execute(_toolCallId, params, signal) {
			const numResults = Math.min(Math.max(Math.round(params.numResults ?? 5), 1), 10);
			const wanted: Provider[] =
				params.provider === "exa" ? ["exa"] :
				params.provider === "parallel" ? ["parallel"] :
				["exa", "parallel"]; // auto

			const errors: string[] = [];
			for (const provider of wanted) {
				try {
					const key = await getKey(provider === "exa" ? "pi-exa" : "pi-parallel");
					const results = provider === "exa"
						? await searchExa(params.query, numResults, key, signal)
						: await searchParallel(params.query, numResults, key, signal);

					let contents: Record<string, string> | undefined;
					if (params.fetchContent && provider === "exa") {
						const urls = results.slice(0, 3).map(r => r.url).filter(Boolean);
						if (urls.length > 0) {
							try { contents = await fetchExaContents(urls, key, 2500, signal); } catch { /* Inhalt optional */ }
						}
					}

					return {
						content: [{
							type: "text",
							text: `Suchdienst: ${provider}\n\n${formatResults(results, contents)}`,
						}],
						details: { provider, count: results.length },
					};
				} catch (err) {
					if (signal?.aborted) throw err;
					errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			// Nur throw setzt isError auf dem Tool-Result (pi-Doku: Returning a
			// value never sets the error flag). Der Hinweistext bleibt Teil der
			// Fehlermeldung, damit das Modell den Nutzer hinweisen kann.
			throw new Error(
				"Websuche fehlgeschlagen:\n" + errors.join("\n") +
				"\n\nHinweis: Ist der API-Key im Schlüsselbund? Anlegen mit:\n" +
				'  security add-generic-password -s pi-exa -a "$USER" -w\n' +
				'  security add-generic-password -s pi-parallel -a "$USER" -w\n' +
				"Status prüfen: /websearch-status"
			);
		},
	});

	pi.registerCommand("websearch-status", {
		description: "Zeigt, welche Websuche-Dienste (Exa/Parallel) im Schlüsselbund hinterlegt sind",
		handler: async (_args, ctx) => {
			const [exa, parallel] = await Promise.all([
				hasKey("pi-exa"),
				hasKey("pi-parallel"),
			]);
			const lines = [
				`Exa:      ${exa ? "✅ Key im Schlüsselbund" : "❌ fehlt (security add-generic-password -s pi-exa -a \"$USER\" -w)"}`,
				`Parallel: ${parallel ? "✅ Key im Schlüsselbund" : "❌ fehlt (security add-generic-password -s pi-parallel -a \"$USER\" -w)"}`,
			];
			ctx.ui.notify(lines.join("\n"), exa || parallel ? "info" : "warning");
		},
	});
}
