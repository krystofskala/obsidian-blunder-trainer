/*
 * Templater user script.
 *
 * Vybere jeden dosud nepoužitý blunder z tvých analyzovaných partií na Lichess
 * (stejný princip jako lichess "Poučte se ze svých chyb") a vygeneruje code
 * block `lichess-blunder`, který plugin **Lichess Blunder Trainer** vykreslí
 * jako interaktivní šachovnici s pozicí těsně před blunderem: zahraješ tah,
 * hned vidíš jestli je nejlepší, můžeš si nechat ukázat řešení i variantu.
 *
 * Použití v šabloně (Templater):
 *   <%* tR += await tp.user.lichessBlunderCallout(tp) %>
 *
 * Aby se Lichess API neptalo pořád dokola (a nevracelo 429), stáhne se poslední
 * dávka partií jen jednou za `cacheHours` hodin do lichess-games-cache.json;
 * daily note vytvořené mezitím berou blunder z cache bez volání sítě.
 *
 * Nastavení: viz "Lichess Blunder Callout - Setup.md" ve vaultu.
 * (Tento skript už nepotřebuje chess.js – FEN pozice počítá plugin.)
 */

const CONFIG_PATH = "Scripts/templater/lichess-config.json";
const STATE_PATH = "Scripts/templater/lichess-blunders-used.json";
const CACHE_PATH = "Scripts/templater/lichess-games-cache.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function lichessBlunderCallout(tp) {
	const app = tp.app;

	const config = await readJson(app, CONFIG_PATH);
	if (!config || !config.username) {
		return warningCallout(
			`Chybí nebo je neplatný soubor \`${CONFIG_PATH}\`. Vytvoř ho podle "Lichess Blunder Callout - Setup" (musí obsahovat aspoň "username").`
		);
	}

	const username = config.username;
	const gamesPerFetch = config.gamesPerFetch || 50;
	const maxFetchRounds = config.maxFetchRounds || 4;
	const cacheHours = config.cacheHours != null ? config.cacheHours : 12;

	const used = new Set((await readJson(app, STATE_PATH)) || []);
	const cache = await readJson(app, CACHE_PATH);
	const cacheSameUser =
		cache &&
		Array.isArray(cache.games) &&
		typeof cache.username === "string" &&
		cache.username.toLowerCase() === username.toLowerCase();
	const cacheFresh =
		cacheSameUser &&
		typeof cache.fetchedAt === "number" &&
		Date.now() - cache.fetchedAt < cacheHours * 3600 * 1000;

	let candidate = null;

	// 1) čerstvá cache → žádné volání sítě
	if (cacheFresh) {
		candidate = pickCandidate(cache.games, username, used);
	}

	// 2) jinak živě z Lichess (round 0 se uloží do cache)
	if (!candidate) {
		let live;
		try {
			live = await pickFromLive(config, username, used, gamesPerFetch, maxFetchRounds);
		} catch (err) {
			// jiná než 429 chyba – zkus aspoň starou cache, ať den nezůstane prázdný
			const fallback = cacheSameUser
				? pickCandidate(cache.games, username, used)
				: null;
			if (fallback) {
				candidate = fallback;
			} else {
				return warningCallout(`Chyba při komunikaci s Lichess API: ${err.message}`);
			}
		}

		if (live) {
			if (live.round0Games) {
				await writeJson(app, CACHE_PATH, {
					fetchedAt: Date.now(),
					username,
					games: live.round0Games,
				});
			}
			candidate = live.candidate;

			if (!candidate && live.hit429) {
				const stale = cacheSameUser
					? pickCandidate(cache.games, username, used)
					: null;
				if (stale) {
					candidate = stale;
				} else {
					return infoCallout(
						"Lichess právě omezuje požadavky (429). Zkus daily note otevřít znovu za chvíli. " +
							"Když to vídáš často, přidej do `lichess-config.json` API token – limity se tím výrazně zvednou."
					);
				}
			}
		}
	}

	if (!candidate) {
		return infoCallout(
			"Nenašel jsem žádný nový blunder (buď nemáš analyzované partie, nebo jsou všechny už použité)."
		);
	}

	used.add(candidate.key);
	await writeJson(app, STATE_PATH, [...used]);

	return renderBlock(candidate);
};

function pickCandidate(games, username, used) {
	const cands = collectUnusedBlunders(games, username, used);
	if (cands.length === 0) return null;
	return cands[Math.floor(Math.random() * cands.length)];
}

// Postupně stahuje dávky partií (od nejnovějších). Vrací {candidate, hit429,
// round0Games}. round0Games = první (nejnovější) dávka pro uložení do cache.
async function pickFromLive(config, username, used, perFetch, rounds) {
	let until;
	let candidate = null;
	let round0Games = null;
	let hit429 = false;

	for (let round = 0; round < rounds && !candidate; round++) {
		const r = await fetchRoundWithRetry(config, perFetch, until);
		if (r.status === 429) {
			hit429 = true;
			break;
		}
		if (r.status !== 200) {
			throw new Error(`Lichess API vrátilo status ${r.status}`);
		}
		if (r.games.length === 0) break;
		if (round === 0) round0Games = r.games;
		until = r.games[r.games.length - 1].createdAt - 1;

		candidate = pickCandidate(r.games, username, used);
	}

	return { candidate, hit429, round0Games };
}

async function fetchRoundWithRetry(config, max, until) {
	let r = await fetchRound(config, max, until);
	if (r.status === 429) {
		// 429 z tohohle endpointu často znamená jen "1 request naráz" a povolí
		// se rychle; zkusíme jednou po krátké pauze (Retry-After když je rozumné).
		const waitMs = Math.min(
			Math.max((r.retryAfter || 0) * 1000, 1500),
			5000
		);
		await sleep(waitMs);
		r = await fetchRound(config, max, until);
	}
	return r;
}

async function fetchRound(config, max, until) {
	const params = new URLSearchParams({
		max: String(max),
		analysed: "true",
		moves: "true",
		evals: "true",
		opening: "false",
		clocks: "false",
		tags: "false",
		ongoing: "false",
	});
	if (until) params.set("until", String(until));

	const headers = { Accept: "application/x-ndjson" };
	if (config.token) headers.Authorization = `Bearer ${config.token}`;

	// fetch místo obsidian.requestUrl – v Templater user scriptu není modul
	// "obsidian" dostupný. Lichess API má povolený CORS, takže to projde.
	const res = await fetch(
		`https://lichess.org/api/games/user/${encodeURIComponent(config.username)}?${params}`,
		{ headers }
	);

	if (res.status === 429) {
		let retryAfter = null;
		try {
			const ra = parseInt(res.headers.get("Retry-After") || "", 10);
			if (Number.isFinite(ra)) retryAfter = ra;
		} catch (e) {
			/* ignore */
		}
		return { status: 429, retryAfter, games: [] };
	}
	if (!res.ok) return { status: res.status, games: [] };

	const text = await res.text();
	const games = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	return { status: 200, games };
}

async function readJson(app, path) {
	try {
		const raw = await app.vault.adapter.read(path);
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

async function writeJson(app, path, data) {
	const folder = path.split("/").slice(0, -1).join("/");
	if (folder && !(await app.vault.adapter.exists(folder))) {
		await app.vault.adapter.mkdir(folder);
	}
	await app.vault.adapter.write(path, JSON.stringify(data, null, 2));
}

function userColor(game, username) {
	const lower = username.toLowerCase();
	if (game.players?.white?.user?.name?.toLowerCase() === lower) return "white";
	if (game.players?.black?.user?.name?.toLowerCase() === lower) return "black";
	return null;
}

// Sesbírá všechny bludery hráče "username", které ještě nejsou v `used`
// (klíč je "gameId:ply", takže stejný blunder ze stejné partie se nikdy
// nezopakuje, ale jiný blunder ze stejné partie klidně znovu vybrán být může).
function collectUnusedBlunders(games, username, used) {
	const out = [];
	for (const game of games) {
		const color = userColor(game, username);
		if (!color || !game.analysis || !game.moves) continue;
		const moves = game.moves.split(" ");

		game.analysis.forEach((entry, ply) => {
			if (!entry || !entry.judgment || entry.judgment.name !== "Blunder") return;
			const moveColor = ply % 2 === 0 ? "white" : "black";
			if (moveColor !== color) return;

			const key = `${game.id}:${ply}`;
			if (used.has(key)) return;

			out.push({ key, game, ply, moves, color, entry });
		});
	}
	return out;
}

function formatEval(entry) {
	if (!entry) return null;
	if (typeof entry.mate === "number") return `#${entry.mate}`;
	if (typeof entry.eval === "number") {
		const pawns = entry.eval / 100;
		return (pawns > 0 ? "+" : "") + pawns.toFixed(2);
	}
	return null;
}

function opponentName(game, color) {
	const opp = color === "white" ? game.players.black : game.players.white;
	if (opp?.user?.name) return opp.user.name;
	if (typeof opp?.aiLevel === "number") return `Stockfish (level ${opp.aiLevel})`;
	return "?";
}

// jedna řádka "key: value" pro code block; hodnota se čistí od zalomení
function kv(key, value) {
	if (value === null || value === undefined || value === "") return null;
	return `${key}: ${String(value).replace(/\s+/g, " ").trim()}`;
}

function renderBlock(candidate) {
	const { game, ply, moves, color, entry } = candidate;
	const date = new Date(game.createdAt).toLocaleDateString("cs-CZ");
	const opponent = opponentName(game, color);
	const afterUrl = `https://lichess.org/${game.id}/${color}#${ply + 1}`;

	const lines = [
		kv("moves", moves.join(" ")),
		kv("ply", ply),
		kv("orientation", color),
		kv("variation", entry.variation),
		kv("best", entry.best),
		kv("played", moves[ply]),
		kv("evalBefore", formatEval(game.analysis[ply - 1])),
		kv("evalAfter", formatEval(entry)),
		kv("comment", entry.judgment && entry.judgment.comment),
		kv("opponent", opponent),
		kv("date", date),
		kv("url", afterUrl),
	].filter(Boolean);

	return [
		`**♟ Dnešní blunder** — z partie ${date} vs. ${opponent}. Zahraj na šachovnici lepší tah, než jsi tehdy zahrál.`,
		"",
		"```lichess-blunder",
		...lines,
		"```",
	].join("\n");
}

function warningCallout(msg) {
	return `> [!warning] Lichess blunder trainer\n> ${msg}`;
}

function infoCallout(msg) {
	return `> [!info] Lichess blunder trainer\n> ${msg}`;
}
