/*
 * Lichess Blunder Trainer — plugin source.
 *
 * Tento soubor se NEnačítá přímo. `build.mjs` ho spojí s vendor/chess.js
 * a vendor/pieces.js do kořenového `main.js`, který načítá Obsidian.
 * Build vloží nahoru dvě globální konstanty: `CHESS` (třída Chess z chess.js)
 * a `PIECES` (mapa "wK".."bP" → SVG string).
 *
 * Code block:
 *
 *   ```lichess-blunder
 *   moves: e4 e5 Nf3 ...        # celá partie v SAN (blunder režim)
 *   ply: 16                     # index tahu blunderu (0 = 1. tah bílého)
 *   orientation: white
 *   variation: Ne5 Bxd1 Nxf7    # doporučená varianta z Lichess analýzy (SAN)
 *   best: f3e5                  # nejlepší tah v UCI (fallback, když chybí variation)
 *   played: Nc3                 # co jsi opravdu zahrál (SAN) – skryté do vyřešení
 *   evalBefore: +0.77
 *   evalAfter: -1.26
 *   comment: Blunder. Ne5 was best.
 *   date: 7. 9. 2026
 *   opponent: CocaineTeddyBear
 *   url: https://lichess.org/abc123/white#16
 *   ```
 *
 *   ```lichess-blunder
 *   puzzle: daily              # nebo:  puzzle: <id>  /  puzzle: next  /  puzzle: next <theme>
 *   token:                     # nepovinné – Lichess API token pro personalizované "next"
 *   ```
 *
 * Lze zadat i přímo pozici:  fen: <FEN> + solution: <UCI> <UCI> ...
 */

const obsidian = require("obsidian");
const { Plugin, MarkdownRenderChild, PluginSettingTab, Setting } = obsidian;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const PIECE_ORDER = ["q", "r", "b", "n"];

// barvy ručně kreslených šipek (pravý klik na PC); modifikátory jako na Lichess
const DRAW_COLORS = { green: "#15a34a", red: "#cc3333", blue: "#3a82d6", yellow: "#e0a112" };
const DRAW_COLOR_LABELS = { green: "Zelená", red: "Červená", blue: "Modrá", yellow: "Žlutá" };

// Modifikátory vrátí konkrétní barvu (jako na Lichess); bez modifikátoru
// vrátí null = "použij výchozí barvu z nastavení".
function drawColorForEvent(e) {
	if (e.shiftKey) return "red";
	if (e.altKey) return "blue";
	if (e.ctrlKey || e.metaKey) return "yellow";
	return null;
}

// klíč z DRAW_COLORS, #hex, nebo cokoli → platná CSS barva
function resolveColor(c) {
	if (!c) return DRAW_COLORS.green;
	if (DRAW_COLORS[c]) return DRAW_COLORS[c];
	if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c).trim())) return String(c).trim();
	return DRAW_COLORS.green;
}

/* --------------------------------------------------------------- vzhled desky */

// barvy polí jako RGB trojice (kvůli nastavitelné průhlednosti)
const BOARD_THEMES = {
	green: { label: "Zelená (Lichess)", light: "235, 236, 208", dark: "119, 149, 86" },
	brown: { label: "Hnědá", light: "240, 217, 181", dark: "181, 136, 99" },
	blue: { label: "Modrá", light: "222, 227, 230", dark: "140, 162, 173" },
	purple: { label: "Fialová", light: "230, 225, 234", dark: "136, 119, 183" },
	grey: { label: "Šedá", light: "220, 220, 220", dark: "138, 138, 138" },
	wood: { label: "Dřevo tmavé", light: "215, 185, 149", dark: "150, 105, 70" },
};

const PIECE_SETS = {
	neo: "neo — geometrická (vlastní)",
	cburnett: "cburnett — klasika",
	merida: "merida",
	alpha: "alpha — linka",
	staunty: "staunty",
	pixel: "pixel — 8-bit",
	shapes: "shapes — minimal",
	anarcandy: "anarcandy — cukrová",
	firi: "firi — modern",
	horsey: "horsey — Lichess doodle",
	maestro: "maestro — elegantní",
	unicode: "unicode (bez obrázků)",
};

const UNICODE_PIECES = {
	wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
	bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};

const DEFAULT_SETTINGS = {
	boardTheme: "auto", // "auto" = pole bez vlastní barvy, převezmou pozadí pod sebou
	lightColor: "",
	darkColor: "",
	pieceSet: "cburnett",
	boardOpacity: 85,
	arrowColor: "green", // výchozí barva ručních šipek (klíč nebo #hex)
	arrowColorCustom: "",
	arrowOpacity: 90,
	lichessToken: "", // Lichess API token – použije se u puzzle bloků automaticky
	showCoordinates: true, // popisky a–h / 1–8 po okrajích desky
	srsEnabled: true, // opakování chyb: blunder vyřešený s chybou se vrací, dokud ho 3× po sobě nezvládneš čistě
	resumeQueue: true, // fronta blunderů si pamatuje vyřešené a po reloadu naskočí na první nevyřešený
};

function hexToRgbTriple(hex) {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
	if (!m) return null;
	let h = m[1];
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	const n = parseInt(h, 16);
	return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// vytáhne z globálního nastavení + z klíčů v bloku finální vzhled
function resolveView(settings, cfg) {
	const themeName = (cfg.board || settings.boardTheme || "auto").toLowerCase();

	let pieceSet = (cfg.pieces || settings.pieceSet || "cburnett").toLowerCase();
	if (!PIECE_SETS[pieceSet]) pieceSet = "cburnett";

	let opacity = cfg.opacity !== undefined ? parseInt(cfg.opacity, 10) : settings.boardOpacity;
	if (!Number.isFinite(opacity)) opacity = 85;
	opacity = Math.max(10, Math.min(100, opacity));
	const alpha = opacity / 100;

	// šipky: barva + průhlednost (globální nebo z bloku)
	let arrowSpec = cfg.arrowcolor || settings.arrowColor || "green";
	if (arrowSpec === "custom") arrowSpec = settings.arrowColorCustom;
	const arrowColor = resolveColor(arrowSpec);
	let aOp = cfg.arrowopacity !== undefined ? parseInt(cfg.arrowopacity, 10) : settings.arrowOpacity;
	if (!Number.isFinite(aOp)) aOp = 90;
	const arrowAlpha = Math.max(15, Math.min(100, aOp)) / 100;
	const coords =
		cfg.coords !== undefined
			? /^(1|true|yes|on)$/i.test(String(cfg.coords).trim())
			: settings.showCoordinates !== false;
	const arrow = { arrowColor, arrowAlpha, coords };

	// blokové vlastní barvy mají přednost i před "auto"
	const blkLight = hexToRgbTriple(cfg.light);
	const blkDark = hexToRgbTriple(cfg.dark);

	// AUTO: pole nemají vlastní barvu, jen průsvitný závoj → převezmou to,
	// co je pod nimi (pozadí poznámky / calloutu / obrázku).
	if (themeName === "auto" && !cfg.board && !blkLight && !blkDark) {
		return { auto: true, pieceSet, alpha, ...arrow };
	}

	const theme = BOARD_THEMES[themeName] || BOARD_THEMES.green;
	let light = theme.light;
	let dark = theme.dark;
	// globální vlastní barvy platí jen pro motiv "custom"
	if (!cfg.board && themeName === "custom") {
		const gLight = hexToRgbTriple(settings.lightColor);
		const gDark = hexToRgbTriple(settings.darkColor);
		if (gLight) light = gLight;
		if (gDark) dark = gDark;
	}
	// blokové light:/dark: přebijí vždy
	if (blkLight) light = blkLight;
	if (blkDark) dark = blkDark;

	return { auto: false, light, dark, pieceSet, alpha, ...arrow };
}

/* ------------------------------------------------------------------ parsing */

function parseBlock(src) {
	const cfg = {};
	for (const raw of String(src).split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const i = line.indexOf(":");
		if (i === -1) continue;
		cfg[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
	}
	return cfg;
}

// klíče objektu na malá písmena (JSON blok od Templater scriptu je už malý,
// tohle je jen pojistka)
function lcKeys(o) {
	const r = {};
	for (const k of Object.keys(o || {})) r[k.toLowerCase()] = o[k];
	return r;
}

function uciOf(move) {
	return move.from + move.to + (move.promotion || "");
}

// SAN sekvence -> pole UCI, počítáno od `fen`. Zastaví se na prvním nelegálním.
function sanLineToUci(fen, sanLine) {
	const out = [];
	if (!sanLine) return out;
	const g = new CHESS(fen);
	for (const tok of sanLine.trim().split(/\s+/)) {
		const san = tok.replace(/^\d+\.+/, "").trim();
		if (!san) continue;
		let m;
		try {
			m = g.move(san, { sloppy: true });
		} catch (e) {
			m = null;
		}
		if (!m) break;
		out.push(uciOf(m));
	}
	return out;
}

function sanOfUci(fen, uci) {
	if (!uci || uci.length < 4) return null;
	try {
		const g = new CHESS(fen);
		const m = g.move({
			from: uci.slice(0, 2),
			to: uci.slice(2, 4),
			promotion: uci.slice(4, 5) || undefined,
		});
		return m ? m.san : null;
	} catch (e) {
		return null;
	}
}

/* ------------------------------------------------------ config -> board opts */

function optsFromConfig(cfg) {
	// 1) přímý FEN + solution
	if (cfg.fen) {
		const line = (cfg.solution || cfg.line || "")
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		const g = new CHESS(cfg.fen); // vyhodí u nevalidního FEN
		const mode = cfg.mode || "puzzle";
		return {
			mode,
			fen: cfg.fen,
			orientation: cfg.orientation || (g.turn() === "w" ? "white" : "black"),
			lineUci: line,
			requireFullLine: mode !== "blunder",
			lastMove: cfg.lastmove || null,
			meta: metaFromConfig(cfg),
		};
	}

	// 2) blunder režim: moves + ply
	if (cfg.moves && cfg.ply !== undefined) {
		const moves = cfg.moves.trim().split(/\s+/).filter(Boolean);
		const ply = parseInt(cfg.ply, 10);
		if (!Number.isFinite(ply) || ply < 0 || ply > moves.length) {
			throw new Error("Neplatné `ply`.");
		}
		const g = new CHESS();
		for (let i = 0; i < ply; i++) g.move(moves[i], { sloppy: true });
		const fen = g.fen();
		let lineUci = sanLineToUci(fen, cfg.variation);
		if (lineUci.length === 0 && cfg.best) lineUci = [cfg.best.trim()];
		return {
			mode: "blunder",
			fen,
			orientation:
				cfg.orientation || (g.turn() === "w" ? "white" : "black"),
			lineUci,
			requireFullLine: false,
			lastMove: ply > 0 ? guessLastMove(moves, ply) : null,
			meta: metaFromConfig(cfg, fen),
		};
	}

	throw new Error(
		"Chybí data. Zadej `puzzle:`, nebo `fen:` + `solution:`, nebo `moves:` + `ply:`."
	);
}

function guessLastMove(moves, ply) {
	try {
		const g = new CHESS();
		for (let i = 0; i < ply - 1; i++) g.move(moves[i], { sloppy: true });
		const m = g.move(moves[ply - 1], { sloppy: true });
		return m ? uciOf(m) : null;
	} catch (e) {
		return null;
	}
}

function metaFromConfig(cfg, fen) {
	return {
		played: cfg.played || null,
		evalBefore: cfg.evalbefore || null,
		evalAfter: cfg.evalafter || null,
		comment: cfg.comment || null,
		date: cfg.date || null,
		opponent: cfg.opponent || null,
		rating: cfg.rating || null,
		themes: cfg.themes || null,
		url: cfg.url || null,
		fen: fen || cfg.fen || null,
	};
}

/* --------------------------------------------------------- Lichess puzzle API */

async function fetchPuzzle(spec, token) {
	const s = (spec || "").trim();
	let url;
	if (!s || s === "daily") {
		url = "https://lichess.org/api/puzzle/daily";
	} else if (s.startsWith("next")) {
		const theme = s.slice(4).trim();
		url =
			"https://lichess.org/api/puzzle/next" +
			(theme ? "?angle=" + encodeURIComponent(theme) : "");
	} else {
		url = "https://lichess.org/api/puzzle/" + encodeURIComponent(s);
	}
	const headers = {};
	if (token) headers.Authorization = "Bearer " + token;
	const res = await obsidian.requestUrl({ url, headers, throw: false });
	if (res.status !== 200) {
		throw new Error("Lichess puzzle API vrátilo status " + res.status);
	}
	const data = res.json;
	const p = data.puzzle || {};

	// /api/puzzle/daily vrací puzzle.fen + puzzle.lastMove rovnou.
	// /api/puzzle/next a /api/puzzle/{id} je nevrací – pozici složíme
	// z game.pgn zahraného po initialPly (včetně).
	let fen = p.fen;
	let lastMove = p.lastMove || null;
	if (!fen) {
		const pgn = (data.game && data.game.pgn) || "";
		const ply = Number.isFinite(p.initialPly) ? p.initialPly : -1;
		if (!pgn || ply < 0) throw new Error("Odpověď puzzle API nemá FEN ani PGN.");
		const sim = new CHESS();
		const toks = pgn.trim().split(/\s+/).filter(Boolean);
		let last = null;
		for (let i = 0; i <= ply && i < toks.length; i++) {
			try {
				last = sim.move(toks[i]);
			} catch (e) {
				break;
			}
		}
		fen = sim.fen();
		if (last) lastMove = uciOf(last);
	}

	const g = new CHESS(fen);
	return {
		mode: "puzzle",
		fen,
		orientation: g.turn() === "w" ? "white" : "black",
		lineUci: (p.solution || []).slice(),
		requireFullLine: true,
		lastMove,
		meta: {
			rating: p.rating != null ? String(p.rating) : null,
			themes: (p.themes || []).join(", ") || null,
			url: p.id ? "https://lichess.org/training/" + p.id : null,
			played: null,
			evalBefore: null,
			evalAfter: null,
			comment: null,
			date: null,
			opponent: null,
			fen,
		},
	};
}

/* --------------------------------------------------------------- board widget */

class BoardWidget {
	constructor(root, opts) {
		this.root = root;
		this.opts = opts;
		this.view = opts.view || {
			light: "235, 236, 208", dark: "119, 149, 86", pieceSet: "cburnett", alpha: 1,
			arrowColor: DRAW_COLORS.green, arrowAlpha: 0.9, coords: true,
		};
		this.timers = new Set();
		this.solvedCount = 0; // kolik jsi jich v tomhle bloku vyřešil za sebou
		this.loadingNext = false;
		this.reset(true);
	}

	// přepnutí vzhledu za běhu (bez ztráty rozehrané pozice)
	applyView(view) {
		this.view = view;
		this.applyViewVars();
		this.renderSquares();
		this.render();
	}

	applyViewVars() {
		const s = this.root.style;
		s.setProperty("--lbt-board-alpha", String(this.view.alpha));
		if (this.view.coords) this.root.addClass("show-coords");
		else this.root.removeClass("show-coords");
		if (this.view.auto) {
			this.root.addClass("is-auto");
			s.removeProperty("--lbt-light");
			s.removeProperty("--lbt-dark");
		} else {
			this.root.removeClass("is-auto");
			s.setProperty("--lbt-light", this.view.light);
			s.setProperty("--lbt-dark", this.view.dark);
		}
	}

	pieceMarkup(colorLetter, typeLetter) {
		const key = colorLetter + typeLetter.toUpperCase();
		if (this.view.pieceSet === "unicode") {
			return {
				uni: true,
				cls: "lbt-uni lbt-uni-" + colorLetter,
				text: UNICODE_PIECES[key] || "",
			};
		}
		const set = PIECES[this.view.pieceSet] || PIECES.cburnett;
		return { uni: false, html: set[key] || PIECES.cburnett[key] || "" };
	}

	destroy() {
		for (const t of this.timers) window.clearTimeout(t);
		this.timers.clear();
		if (this._drag) this.cancelDrag();
	}

	later(fn, ms) {
		const t = window.setTimeout(() => {
			this.timers.delete(t);
			fn();
		}, ms);
		this.timers.add(t);
		return t;
	}

	reset(first) {
		this.destroy();
		this.game = new CHESS(this.opts.fen);
		this.cursor = 0; // index dalšího očekávaného tahu v lineUci
		this.tries = 0;
		this.selected = null;
		this.locked = this.opts.lineUci.length === 0;
		this.status = this.locked ? "nolines" : "playing";
		this.reviewIdx = null; // v režimu prohlížení: kolik tahů linie je zahráno
		this.pendingPromo = null;
		this.flashSq = null;
		this.lastWrong = null;
		this.hintLevel = 0; // 0 nic, 1 figura, 2 šipka (3. klik = zahraje se)
		this.usedHint = false;
		this.hadWrong = false; // padl někdy v téhle úloze špatný tah?
		this.peeked = false; // použil jsi v téhle úloze nápovědu (jakýkoli stupeň)?
		this.resultReported = false; // výsledek do SRS se hlásí jen jednou
		this.userShapes = []; // ruční šipky/kolečka (pravý klik na PC)
		this.drawFrom = null;
		this.cancelDrag(); // kdyby se resetovalo přímo během tažení
		this._suppressClick = false;
		this.nextMsg = null;
		this.nextMsgKind = null;
		this.arrows = this.opts.lastMove ? [square2(this.opts.lastMove, "hint")] : [];
		if (first) this.build();
		else this.render();
	}

	get queue() {
		return this.opts.queue || null;
	}
	get queueIndex() {
		return this.opts.queueIndex || 0;
	}
	hasNext() {
		if (this.opts.puzzleNext) return true;
		return this.nextQueueIndex() !== -1;
	}

	// index dalšího nehotového blunderu ve frontě (přeskakuje __done), nebo -1
	nextQueueIndex() {
		if (!this.queue) return -1;
		let i = this.queueIndex + 1;
		while (i < this.queue.length && this.queue[i].__done) i++;
		return i < this.queue.length ? i : -1;
	}

	// celkový počet „ostrých" blunderů ve frontě (bez SRS opakování)
	queueTotal() {
		return this.queue ? this.queue.filter((e) => !e.__srs).length : 0;
	}

	// pořadí aktuálního blunderu mezi „ostrými" (1-based)
	queuePosition() {
		let pos = 0;
		for (let i = 0; i <= this.queueIndex && i < this.queue.length; i++) {
			if (!this.queue[i].__srs) pos++;
		}
		return Math.max(1, pos);
	}

	// další blunder z fronty (JSON pole od Templater scriptu)
	nextInQueue() {
		const ni = this.nextQueueIndex();
		if (ni === -1) return;
		const entry = this.queue[ni];
		let no;
		try {
			no = optsFromConfig(entry);
		} catch (e) {
			this.nextMsg = "Další blunder je poškozený: " + (e.message || e);
			this.render();
			return;
		}
		no.view = this.view;
		no.queue = this.queue;
		no.queueIndex = ni;
		no.onResult = this.opts.onResult;
		this.opts = no;
		this.reset(true);
	}

	// další puzzle přes Lichess /api/puzzle/next
	async loadNextPuzzle() {
		if (this.loadingNext || !this.opts.puzzleNext) return;
		this.loadingNext = true;
		this.nextMsg = null;
		this.render();
		try {
			const { spec, token } = this.opts.puzzleNext;
			const no = await fetchPuzzle(spec, token);
			no.view = this.view;
			no.puzzleNext = this.opts.puzzleNext;
			this.opts = no;
			this.loadingNext = false;
			this.reset(true);
		} catch (e) {
			this.loadingNext = false;
			this.nextMsg = "Další puzzle se nenačetlo: " + (e.message || e);
			this.render();
		}
	}

	// ------- DOM skeleton -------
	build() {
		this.root.empty();
		this.root.addClass("lbt");
		this.applyViewVars();

		this.elTitle = this.root.createDiv({ cls: "lbt-title" });

		const stage = this.root.createDiv({ cls: "lbt-stage" });
		this.elStage = stage;
		this.elBoard = stage.createDiv({ cls: "lbt-board" });

		// Šipky jsou jen ozdoba – kdyby createSvg na nějakém webview zlobil,
		// nesmí to shodit celou šachovnici.
		// Hlavičky šipek si kreslíme jako <polygon> (žádné SVG <marker>), aby
		// barva byla libovolná bez předdefinovaných markerů.
		this.elArrows = null;
		try {
			this.elArrows = stage.createSvg("svg", { cls: "lbt-arrows" });
			this.elArrows.setAttribute("viewBox", "0 0 8 8");
			this.elArrows.setAttribute("preserveAspectRatio", "none");
		} catch (e) {
			this.elArrows = null;
		}

		this.elSquares = {};
		this.elBoard.addEventListener("click", (e) => this.onBoardClick(e));
		// tažení figur myší / prstem (levé tlačítko, 1. dotyk) – jako na Lichess.
		// klik-klik (vyber figuru → klikni cíl) zůstává jako záloha.
		this.elBoard.addEventListener("pointerdown", (e) => this.onPieceDragStart(e));
		this.elBoard.addEventListener("pointermove", (e) => this.onPieceDragMove(e));
		this.elBoard.addEventListener("pointerup", (e) => this.onPieceDragEnd(e));
		this.elBoard.addEventListener("pointercancel", (e) => this.onPieceDragEnd(e));
		// ruční kreslení šipek na PC (pravý klik / pravé táhnutí), jako na Lichess
		this.elBoard.addEventListener("contextmenu", (e) => e.preventDefault());
		this.elBoard.addEventListener("mousedown", (e) => this.onDrawStart(e));
		this.elBoard.addEventListener("mouseup", (e) => this.onDrawEnd(e));
		this.elBoard.addEventListener("mouseleave", () => {
			this.drawFrom = null;
		});

		this.elFeedback = this.root.createDiv({ cls: "lbt-feedback" });

		this.elControls = this.root.createDiv({ cls: "lbt-controls" });

		this.elMeta = this.root.createDiv({ cls: "lbt-meta" });

		this.renderSquares();
		this.render();
	}

	renderSquares() {
		this.elBoard.empty();
		this.elSquares = {};
		const ranks = this.opts.orientation === "white"
			? [8, 7, 6, 5, 4, 3, 2, 1]
			: [1, 2, 3, 4, 5, 6, 7, 8];
		const files = this.opts.orientation === "white"
			? [0, 1, 2, 3, 4, 5, 6, 7]
			: [7, 6, 5, 4, 3, 2, 1, 0];
		for (const r of ranks) {
			for (const f of files) {
				const sq = FILES[f] + r;
				const cell = this.elBoard.createDiv({
					cls: "lbt-sq " + ((f + r) % 2 === 0 ? "lbt-light" : "lbt-dark"),
				});
				cell.dataset.square = sq;
				this.elSquares[sq] = cell;
			}
		}
		this.renderCoords(ranks, files);
	}

	// popisky a–h / 1–8 – vlastní vrstva, nezávislá na překreslování figur
	renderCoords(ranks, files) {
		if (this.elCoords) this.elCoords.remove();
		this.elCoords = null;
		if (!this.view.coords || !this.elStage) return;
		const layer = this.elStage.createDiv({ cls: "lbt-coords" });
		const rankRow = layer.createDiv({ cls: "lbt-ranks" });
		for (const r of ranks) rankRow.createSpan({ text: String(r) });
		const fileRow = layer.createDiv({ cls: "lbt-files" });
		for (const f of files) fileRow.createSpan({ text: FILES[f] });
		this.elCoords = layer;
	}

	// ------- rendering -------
	render() {
		this.renderPieces();
		this.renderArrows();
		this.renderTitle();
		this.renderFeedback();
		this.renderControls();
		this.renderMeta();
	}

	currentEntry() {
		return this.queue ? this.queue[this.queueIndex] : null;
	}

	renderTitle() {
		const side = this.game.turn() === "w" ? "bílé" : "černé";
		const cur = this.currentEntry();
		let label;
		if (this.opts.mode === "puzzle") {
			label = "🧩 Lichess puzzle";
			if (this.opts.meta.rating) label += " · " + this.opts.meta.rating;
		} else if (cur && cur.__srs) {
			label = "🔁 Opakování chyby";
			const st = cur.__srsStreak || 0;
			label += " · " + Math.min(st, SRS_GRADUATE) + "/" + SRS_GRADUATE + " čistě";
		} else if (this.queue && this.queueTotal() > 1) {
			label = "♟ Blunder " + this.queuePosition() + "/" + this.queueTotal();
		} else {
			label = "♟ Blunder z Lichess partie";
		}
		if (this.solvedCount > 1) label += " · série " + this.solvedCount + " 🔥";
		let tail;
		if (this.status === "solved") tail = " — ✅ vyřešeno";
		else if (this.status === "revealed") tail = this.usedHint ? " — řešení (s nápovědou)" : " — řešení";
		else if (this.status === "nolines") tail = "";
		else tail = " — na tahu " + side + ", najdi nejlepší tah";
		this.elTitle.setText(label + tail);
	}

	renderPieces() {
		const board = this.game.board(); // [rank8..rank1][fileA..fileH]
		for (const sq of Object.keys(this.elSquares)) {
			const cell = this.elSquares[sq];
			cell.empty();
			cell.removeClass(
				"lbt-sel", "lbt-dest", "lbt-dest-cap", "lbt-good", "lbt-bad",
				"lbt-from", "lbt-to", "lbt-hintsrc", "lbt-dragging", "lbt-drag-over"
			);
		}
		for (let r = 0; r < 8; r++) {
			for (let f = 0; f < 8; f++) {
				const p = board[r][f];
				if (!p) continue;
				const sq = FILES[f] + (8 - r);
				const cell = this.elSquares[sq];
				if (!cell) continue;
				const m = this.pieceMarkup(p.color, p.type);
				const span = cell.createSpan({ cls: "lbt-piece" + (m.uni ? " " + m.cls : "") });
				if (m.uni) span.setText(m.text);
				else span.innerHTML = m.html;
			}
		}
		// zvýraznění posledního tahu / hintu
		for (const a of this.arrows) {
			if (a.kind === "hint" && a.from && this.elSquares[a.from])
				this.elSquares[a.from].addClass("lbt-from");
			if (a.kind === "hint" && a.to && this.elSquares[a.to])
				this.elSquares[a.to].addClass("lbt-to");
		}
		if (this.selected && this.elSquares[this.selected]) {
			this.elSquares[this.selected].addClass("lbt-sel");
			for (const d of this.legalDests(this.selected)) {
				if (!this.elSquares[d]) continue;
				this.elSquares[d].addClass("lbt-dest");
				if (this.game.get(d)) this.elSquares[d].addClass("lbt-dest-cap");
			}
		}
		// nápověda 1. stupně: zvýrazni figuru, kterou hrát
		if (this.status === "playing" && this.hintLevel >= 1) {
			const hu = this.opts.lineUci[this.cursor];
			if (hu && this.elSquares[hu.slice(0, 2)]) {
				this.elSquares[hu.slice(0, 2)].addClass("lbt-hintsrc");
			}
		}
		// přetrvávající "blik" po tahu (přežije překreslení, mizí časovačem)
		if (this.flashSq && this.elSquares[this.flashSq.sq]) {
			this.elSquares[this.flashSq.sq].addClass(
				this.flashSq.kind === "good" ? "lbt-good" : "lbt-bad"
			);
		}
		// probíhá tažení → drž zdrojové pole "zvednuté" i po překreslení
		if (this._drag && this._drag.moved && this.elSquares[this._drag.from]) {
			this.elSquares[this._drag.from].addClass("lbt-dragging");
		}
	}

	renderArrows() {
		if (!this.elArrows) return;
		this.elArrows.querySelectorAll(".lbt-shape").forEach((n) => n.remove());

		const uCol = this.view.arrowColor || DRAW_COLORS.green;
		const uOp = this.view.arrowAlpha != null ? this.view.arrowAlpha : 0.9;

		// šipky poslední tah / prohlížení řešení (funkční barvy, pevná průhlednost)
		for (const a of this.arrows) {
			if (!a.from || !a.to) continue;
			this.drawArrow(a.from, a.to, {
				color: a.kind === "good" ? "var(--lbt-good, #3fb950)" : "var(--lbt-hint, #d29922)",
				width: 0.16,
				opacity: 0.85,
			});
		}

		// nápověda 2. stupně: šipka pro další tah řešení
		if (this.status === "playing" && this.hintLevel >= 2) {
			const hu = this.opts.lineUci[this.cursor];
			if (hu) {
				this.drawArrow(hu.slice(0, 2), hu.slice(2, 4), {
					color: "var(--lbt-good, #3fb950)",
					width: 0.2,
					opacity: 0.95,
				});
			}
		}

		// ruční tvary (pravý klik na PC) – barva i průhlednost z nastavení
		for (const s of this.userShapes) {
			const col = s.color ? resolveColor(s.color) : uCol;
			if (s.type === "circle") {
				const c = this.center(s.from);
				this.elArrows.createSvg("circle", {
					cls: "lbt-shape",
					attr: {
						cx: c.x, cy: c.y, r: 0.44,
						fill: "none", stroke: col, "stroke-width": 0.09, opacity: String(uOp),
					},
				});
			} else {
				this.drawArrow(s.from, s.to, { color: col, width: 0.22, opacity: uOp });
			}
		}
	}

	// šipka = čára zkrácená o hlavičku + trojúhelníková hlavička (<polygon>)
	drawArrow(from, to, o) {
		const p1 = this.center(from);
		const p2 = this.center(to);
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		const len = Math.hypot(dx, dy) || 1;
		const ux = dx / len;
		const uy = dy / len;
		const head = Math.min(0.34, len * 0.5); // délka hlavičky
		const hw = head * 0.62; // poloviční šířka hlavičky
		const bx = p2.x - ux * head; // pata hlavičky
		const by = p2.y - uy * head;
		const op = String(o.opacity != null ? o.opacity : 0.9);
		this.elArrows.createSvg("line", {
			cls: ["lbt-shape", "lbt-arrow"],
			attr: {
				x1: p1.x, y1: p1.y, x2: bx, y2: by,
				stroke: o.color,
				"stroke-width": String(o.width || 0.18),
				"stroke-linecap": "round",
				opacity: op,
			},
		});
		this.elArrows.createSvg("polygon", {
			cls: "lbt-shape",
			attr: {
				points:
					p2.x + "," + p2.y + " " +
					(bx - uy * hw) + "," + (by + ux * hw) + " " +
					(bx + uy * hw) + "," + (by - ux * hw),
				fill: o.color,
				opacity: op,
			},
		});
	}

	center(sq) {
		const f = FILES.indexOf(sq[0]);
		const r = parseInt(sq[1], 10);
		const x = this.opts.orientation === "white" ? f + 0.5 : 7 - f + 0.5;
		const y = this.opts.orientation === "white" ? 8 - r + 0.5 : r - 0.5;
		return { x, y };
	}

	renderFeedback() {
		this.elFeedback.empty();
		this.elFeedback.removeClass("is-good", "is-bad", "is-info");
		let msg = "";
		if (this.nextMsg) {
			this.elFeedback.addClass(this.nextMsgKind === "info" ? "is-info" : "is-bad");
			this.elFeedback.setText(this.nextMsg);
			return;
		}
		if (this.status === "nolines") {
			this.elFeedback.addClass("is-info");
			msg = "K téhle pozici není uložená varianta řešení.";
		} else if (this.status === "solved") {
			this.elFeedback.addClass("is-good");
			msg = "Správně!" + (this.solvedCount > 1 ? "  " + this.solvedCount + " v řadě 🔥" : "");
		} else if (this.status === "revealed") {
			this.elFeedback.addClass("is-info");
			msg = "Tohle bylo nejlepší pokračování. Proklikej si ho tlačítky ◀ ▶.";
		} else if (this.status === "playing" && this.hintLevel === 1) {
			this.elFeedback.addClass("is-info");
			msg = "💡 Táhni zvýrazněnou figurou.";
		} else if (this.status === "playing" && this.hintLevel >= 2) {
			this.elFeedback.addClass("is-info");
			msg = "💡 Zahraj naznačený tah (další klik ho zahraje za tebe).";
		} else if (this.lastWrong) {
			this.elFeedback.addClass("is-bad");
			msg = "✗ " + this.lastWrong + " není nejlepší. Zkus jiný tah." +
				(this.tries > 1 ? "  (pokusů: " + this.tries + ")" : "");
		} else if (this.cursor > 0) {
			this.elFeedback.addClass("is-good");
			msg = "✓ Dobře, hraj dál.";
		} else {
			this.elFeedback.addClass("is-info");
			msg = "Táhni figurou na šachovnici.";
		}
		this.elFeedback.setText(msg);
	}

	renderControls() {
		this.elControls.empty();
		const btn = (label, cls, fn, disabled) => {
			const b = this.elControls.createEl("button", { text: label, cls: "lbt-btn " + (cls || "") });
			if (disabled) b.disabled = true;
			else b.addEventListener("click", fn);
			return b;
		};

		if (this.status === "revealed" || this.status === "solved") {
			// „Další" – nejdůležitější akce, dej ji první
			if (this.opts.puzzleNext) {
				btn(
					this.loadingNext ? "Načítám…" : "▶ Další puzzle",
					"lbt-btn-next",
					() => this.loadNextPuzzle(),
					this.loadingNext
				);
			} else if (this.queue && this.queueTotal() > 1) {
				if (this.hasNext()) {
					btn("▶ Další blunder", "lbt-btn-next", () => this.nextInQueue());
				} else {
					btn("✓ Hotovo (" + this.queueTotal() + ")", "", null, true);
				}
			}
			btn("⟲ začátek", "", () => this.reviewGoto(0));
			btn("◀", "", () => this.reviewGoto((this.reviewIdx ?? 0) - 1),
				(this.reviewIdx ?? 0) <= 0);
			btn("▶", "", () => this.reviewGoto((this.reviewIdx ?? 0) + 1),
				(this.reviewIdx ?? 0) >= this.opts.lineUci.length);
		}
		if (this.status === "playing") {
			const labels = ["💡 Nápověda", "💡 Ukázat tah", "▶ Zahrát tah"];
			btn(labels[Math.min(this.hintLevel, 2)], "lbt-btn-hint", () => this.bumpHint());
		}
		btn("↺ Zkusit znovu", "", () => this.reset(false));
		btn("⇅ Otočit", "", () => this.flipBoard());
		btn("⧉ FEN", "", () => this.copyFen());
		if (this.opts.meta.url) {
			const a = this.elControls.createEl("a", {
				text: "↗ Lichess",
				cls: "lbt-btn lbt-btn-link",
				href: this.opts.meta.url,
			});
			a.target = "_blank";
			a.rel = "noopener";
		}
	}

	flipBoard() {
		this.opts.orientation = this.opts.orientation === "white" ? "black" : "white";
		this.selected = null;
		this.renderSquares();
		this.render();
	}

	copyFen() {
		const fen = this.game.fen();
		this.nextMsgKind = "info";
		try {
			navigator.clipboard.writeText(fen);
			this.nextMsg = "FEN zkopírován do schránky";
		} catch (e) {
			this.nextMsg = fen;
		}
		this.renderFeedback();
	}

	renderMeta() {
		const m = this.opts.meta;
		this.elMeta.empty();
		const rows = [];
		const revealed = this.status === "solved" || this.status === "revealed";
		if (m.opponent) rows.push("Soupeř: " + m.opponent + (m.date ? " · " + m.date : ""));
		else if (m.date) rows.push(m.date);
		if (m.themes) rows.push("Témata: " + m.themes);
		if (revealed) {
			const best = sanOfUci(this.opts.fen, this.opts.lineUci[0]);
			if (best) rows.push("Nejlepší tah: " + best);
			if (m.played) {
				let s = "V partii jsi zahrál: " + m.played;
				if (m.evalBefore && m.evalAfter) s += "  (" + m.evalBefore + " → " + m.evalAfter + ")";
				rows.push(s);
			}
			if (m.comment) rows.push(m.comment);
		}
		for (const r of rows) this.elMeta.createDiv({ cls: "lbt-meta-row", text: r });
	}

	// ------- interaction -------
	legalDests(sq) {
		try {
			return this.game.moves({ square: sq, verbose: true }).map((m) => m.to);
		} catch (e) {
			return [];
		}
	}

	squareFromEvent(e) {
		const cell = e.target && e.target.closest ? e.target.closest(".lbt-sq") : null;
		if (!cell || !this.elBoard.contains(cell)) return null;
		return cell.dataset.square || null;
	}

	// ------- tažení figur (pointer events – myš i dotyk) -------

	// pole pod bodem [clientX, clientY], i když se přesně netrefí do <div>
	squareFromPoint(clientX, clientY) {
		if (!this.elBoard) return null;
		const rect = this.elBoard.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		const col = Math.floor(((clientX - rect.left) / rect.width) * 8);
		const row = Math.floor(((clientY - rect.top) / rect.height) * 8);
		if (col < 0 || col > 7 || row < 0 || row > 7) return null;
		let f, r;
		if (this.opts.orientation === "white") { f = col; r = 8 - row; }
		else { f = 7 - col; r = row + 1; }
		return FILES[f] + r;
	}

	onPieceDragStart(e) {
		if (e.button !== 0 || e.isPrimary === false) return; // jen levé tlačítko / 1. dotyk
		if (this.locked || this.pendingPromo || this.status !== "playing") return;
		if (this._drag) return;
		const from = this.squareFromPoint(e.clientX, e.clientY);
		if (!from) return;
		const piece = this.game.get(from);
		if (!piece || piece.color !== this.game.turn()) return; // taháme jen figurou na tahu

		e.preventDefault();
		const prevSelected = this.selected;
		this.selected = from;
		if (this.nextMsg) this.nextMsg = null;
		if (this.userShapes.length) { this.userShapes = []; this.renderArrows(); }
		this.renderPieces(); // ukáže výběr + legální cílová pole

		const m = this.pieceMarkup(piece.color, piece.type);
		const ghost = this.elStage.createDiv({ cls: "lbt-drag-ghost" });
		if (m.uni) {
			ghost.addClass("lbt-uni", "lbt-uni-" + piece.color);
			ghost.setText(m.text);
		} else {
			ghost.innerHTML = m.html;
		}

		this._drag = {
			from,
			prevSelected,
			pointerId: e.pointerId,
			ghost,
			uni: !!m.uni,
			startX: e.clientX,
			startY: e.clientY,
			moved: false,
			over: null,
			legal: new Set(this.legalDests(from)),
		};
		this.positionDragGhost(e.clientX, e.clientY);
		try { this.elBoard.setPointerCapture(e.pointerId); } catch (_) {}
	}

	positionDragGhost(clientX, clientY) {
		const g = this._drag;
		if (!g || !g.ghost) return;
		const rect = this.elBoard.getBoundingClientRect();
		const size = rect.width / 8;
		g.ghost.style.width = size + "px";
		g.ghost.style.height = size + "px";
		if (g.uni) g.ghost.style.fontSize = (size * 0.82) + "px";
		g.ghost.style.transform =
			"translate(" + (clientX - rect.left - size / 2) + "px," +
			(clientY - rect.top - size / 2) + "px)";
	}

	onPieceDragMove(e) {
		const g = this._drag;
		if (!g || e.pointerId !== g.pointerId) return;
		e.preventDefault();
		if (!g.moved) {
			// malý práh, ať čisté ťuknutí projde jako klik (výběr / klik-klik)
			if (Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) < 4) return;
			g.moved = true;
			if (this.elSquares[g.from]) this.elSquares[g.from].addClass("lbt-dragging");
		}
		this.positionDragGhost(e.clientX, e.clientY);
		const sq = this.squareFromPoint(e.clientX, e.clientY);
		if (sq !== g.over) {
			if (g.over && this.elSquares[g.over]) this.elSquares[g.over].removeClass("lbt-drag-over");
			g.over = sq;
			if (sq && g.legal.has(sq) && this.elSquares[sq]) {
				this.elSquares[sq].addClass("lbt-drag-over");
			}
		}
	}

	onPieceDragEnd(e) {
		const g = this._drag;
		if (!g || e.pointerId !== g.pointerId) return;
		const cancelled = e.type === "pointercancel";
		const target = (!cancelled && g.moved)
			? this.squareFromPoint(e.clientX, e.clientY)
			: null;
		this.cancelDrag();

		if (g.moved) {
			// po opravdovém tažení nechceme, aby dorazivší "click" zopakoval akci
			this._suppressClick = true;
			this.later(() => { this._suppressClick = false; }, 400);
			if (target && target !== g.from && g.legal.has(target)) {
				this.tryMove(g.from, target); // vybere promoci / vyhodnotí tah
			} else {
				this.selected = null; // pustil mimo legální pole → zruš výběr
				this.renderPieces();
			}
			return;
		}

		// bez pohybu = obyčejné ťuknutí: chovej se jako klik na figuru
		this._suppressClick = true;
		this.later(() => { this._suppressClick = false; }, 400);
		if (g.prevSelected === g.from) {
			this.selected = null; // druhé ťuknutí na tutéž figuru = odznačit
		} else {
			this.selected = g.from; // vyber figuru (cílová pole už svítí)
		}
		this.renderPieces();
	}

	// úklid stavu tažení (ghost, zvýraznění, pointer capture) – bez logiky tahu
	cancelDrag() {
		const g = this._drag;
		if (!g) return;
		this._drag = null;
		try { this.elBoard.releasePointerCapture(g.pointerId); } catch (_) {}
		if (g.ghost) g.ghost.remove();
		if (this.elSquares[g.from]) this.elSquares[g.from].removeClass("lbt-dragging");
		if (g.over && this.elSquares[g.over]) this.elSquares[g.over].removeClass("lbt-drag-over");
	}

	// nápověda: 1. klik = figura, 2. klik = šipka, 3. klik = tah se zahraje
	bumpHint() {
		if (this.status !== "playing" || this.locked) return;
		if (!this.opts.lineUci[this.cursor]) return;
		this.peeked = true; // jakýkoli stupeň nápovědy = úloha už není "čistá"
		if (this.hintLevel < 2) {
			this.hintLevel++;
			this.render();
			return;
		}
		this.usedHint = true;
		this.selected = null;
		this.hintPlayMove(this.opts.lineUci[this.cursor]);
	}

	hintPlayMove(uci) {
		this.userShapes = [];
		this.playUci(uci);
		this.cursor++;
		this.hintLevel = 0;
		this.flash(uci.slice(2, 4), "good");

		const target = this.opts.requireFullLine ? this.opts.lineUci.length : 1;
		if (this.cursor >= target) {
			this.finishRevealed();
			this.render();
			return;
		}
		this.locked = true;
		this.render();
		this.later(() => {
			const reply = this.opts.lineUci[this.cursor];
			this.playUci(reply);
			this.cursor++;
			this.flash(reply.slice(2, 4), "good");
			this.locked = false;
			if (this.cursor >= this.opts.lineUci.length) this.finishRevealed();
			this.render();
		}, 450);
	}

	finishRevealed() {
		this.status = "revealed";
		this.reviewIdx = this.cursor;
		this.reportResult(true); // vyřešeno, ale s nápovědou = do SRS jako "ne čistě"
	}

	// ------- ruční šipky (pravý klik na PC, jako Lichess) -------
	onDrawStart(e) {
		if (e.button !== 2) return;
		e.preventDefault();
		this.drawFrom = this.squareFromEvent(e);
		this.drawColor = drawColorForEvent(e); // "red"/"blue"/"yellow" nebo null (= výchozí)
	}

	onDrawEnd(e) {
		if (!this.drawFrom) return; // spouští jen po pravém mousedownu
		e.preventDefault();
		const from = this.drawFrom;
		const to = this.squareFromEvent(e);
		this.drawFrom = null;
		if (!to) return;
		const shape =
			to === from
				? { type: "circle", from, color: this.drawColor }
				: { type: "arrow", from, to, color: this.drawColor };
		this.toggleShape(shape);
		this.renderArrows();
	}

	toggleShape(shape) {
		const i = this.userShapes.findIndex(
			(s) => s.type === shape.type && s.from === shape.from && s.to === shape.to
		);
		if (i >= 0) {
			if (this.userShapes[i].color === shape.color) this.userShapes.splice(i, 1);
			else this.userShapes[i].color = shape.color;
		} else {
			this.userShapes.push(shape);
		}
	}

	onBoardClick(e) {
		// klik, který vygeneroval prohlížeč po dokončeném tažení, ignoruj
		if (this._suppressClick) {
			this._suppressClick = false;
			return;
		}
		if (this.nextMsg) {
			this.nextMsg = null;
			this.renderFeedback();
		}
		// levý klik smaže ručně nakreslené šipky (jako na Lichess)
		if (this.userShapes.length) {
			this.userShapes = [];
			this.renderArrows();
		}
		if (this.locked) return;
		const cell = e.target.closest ? e.target.closest(".lbt-sq") : null;
		if (!cell || !this.elBoard.contains(cell)) return;
		const sq = cell.dataset.square;
		if (this.pendingPromo) return;

		if (this.selected) {
			if (sq === this.selected) {
				this.selected = null;
				this.renderPieces();
				return;
			}
			if (this.legalDests(this.selected).includes(sq)) {
				this.tryMove(this.selected, sq);
				return;
			}
		}
		const piece = this.game.get(sq);
		if (piece && piece.color === this.game.turn()) {
			this.selected = sq;
			this.renderPieces();
		} else {
			this.selected = null;
			this.renderPieces();
		}
	}

	needsPromotion(from, to) {
		const p = this.game.get(from);
		if (!p || p.type !== "p") return false;
		return to[1] === "8" || to[1] === "1";
	}

	tryMove(from, to) {
		if (this.needsPromotion(from, to)) {
			this.showPromo(from, to);
			return;
		}
		this.applySolverMove(from, to, "q");
	}

	showPromo(from, to) {
		this.pendingPromo = { from, to };
		const overlay = this.elBoard.createDiv({ cls: "lbt-promo" });
		for (const t of PIECE_ORDER) {
			const m = this.pieceMarkup(this.game.turn(), t);
			const b = overlay.createDiv({ cls: "lbt-promo-opt" + (m.uni ? " " + m.cls : "") });
			if (m.uni) b.setText(m.text);
			else b.innerHTML = m.html;
			b.addEventListener("click", (ev) => {
				ev.stopPropagation();
				overlay.remove();
				this.pendingPromo = null;
				this.applySolverMove(from, to, t);
			});
		}
	}

	applySolverMove(from, to, promo) {
		let move;
		try {
			move = this.game.move({ from, to, promotion: promo });
		} catch (e) {
			move = null;
		}
		if (!move) return;
		this.selected = null;

		const played = uciOf(move);
		const expected = (this.opts.lineUci[this.cursor] || "").toLowerCase();
		const ok =
			played.toLowerCase() === expected ||
			played.toLowerCase() === expected + "q" ||
			this.game.isCheckmate();

		if (!ok) {
			this.tries++;
			this.hadWrong = true;
			this.lastWrong = move.san;
			this.flash(to, "bad");
			this.later(() => {
				this.game.undo();
				this.render();
			}, 420);
			this.render();
			return;
		}

		this.lastWrong = null;
		this.hintLevel = 0; // po správném tahu se nápověda počítá znovu
		this.userShapes = [];
		this.cursor++;
		this.flash(to, "good");

		// blunder režim: stačí najít první (nejlepší) tah, zbytek varianty je
		// jen k prohlédnutí. puzzle režim: musí sedět celá vynucená linie.
		const target = this.opts.requireFullLine ? this.opts.lineUci.length : 1;
		if (this.cursor >= target) {
			this.markSolved(this.cursor);
			this.render();
			return;
		}

		// vynucená odpověď soupeře
		this.locked = true;
		this.render();
		this.later(() => {
			const reply = this.opts.lineUci[this.cursor];
			this.playUci(reply);
			this.cursor++;
			this.flash(reply.slice(2, 4), "good");
			this.locked = false;
			if (this.cursor >= this.opts.lineUci.length) this.markSolved(this.opts.lineUci.length);
			this.render();
		}, 450);
	}

	markSolved(idx) {
		const first = this.status !== "solved";
		this.status = "solved";
		this.reviewIdx = idx;
		// do série 🔥 (a jako "čistý" pokus pro opakování chyb) se počítá jen
		// vyřešení napoprvé bez nápovědy a bez jediného špatného tahu
		const clean = !this.hadWrong && !this.peeked;
		if (first && clean) this.solvedCount++;
		if (first) this.reportResult(true);
	}

	// hlášení výsledku úlohy do SRS (opakování chyb) – jen jednou za úlohu
	reportResult(solved) {
		if (this.resultReported || typeof this.opts.onResult !== "function") return;
		if (!this.queue) return; // SRS jede jen nad frontou blunderů
		this.resultReported = true;
		const cfg = this.queue[this.queueIndex];
		// v rámci session hned označ za hotové, ať „▶ Další" tenhle přeskočí
		if (solved && cfg && !cfg.__srs) cfg.__done = true;
		try {
			this.opts.onResult(cfg, {
				solved: !!solved,
				hadWrong: this.hadWrong,
				hadHint: this.peeked,
			});
		} catch (e) {
			/* ignore */
		}
	}

	playUci(uci) {
		try {
			this.game.move({
				from: uci.slice(0, 2),
				to: uci.slice(2, 4),
				promotion: uci.slice(4, 5) || "q",
			});
		} catch (e) {
			/* ignore */
		}
	}

	flash(sq, kind) {
		this.flashSq = { sq, kind };
		this.later(() => {
			this.flashSq = null;
			this.renderPieces();
		}, 650);
	}

	// ------- reveal / review -------
	reveal() {
		this.status = "revealed";
		this.locked = true;
		this.selected = null;
		this.reviewGoto(this.opts.lineUci.length);
	}

	reviewGoto(idx) {
		const n = Math.max(0, Math.min(idx, this.opts.lineUci.length));
		this.reviewIdx = n;
		this.game = new CHESS(this.opts.fen);
		for (let i = 0; i < n; i++) this.playUci(this.opts.lineUci[i]);
		// šipka pro poslední zahraný tah linie
		this.arrows = [];
		if (this.opts.lastMove && n === 0) this.arrows.push(square2(this.opts.lastMove, "hint"));
		if (n > 0) {
			const last = this.opts.lineUci[n - 1];
			this.arrows.push({
				from: last.slice(0, 2),
				to: last.slice(2, 4),
				kind: n % 2 === 1 ? "good" : "hint",
			});
		}
		if (this.status !== "solved") this.status = "revealed";
		this.render();
	}
}

function square2(uci, kind) {
	return { from: uci.slice(0, 2), to: uci.slice(2, 4), kind };
}

/* --------------------------------------------------------------------- plugin */

/* ------------------------------------------------- opakování chyb (mini SRS) */

const SRS_CFG_KEYS = [
	"moves", "ply", "orientation", "variation", "best", "played",
	"evalbefore", "evalafter", "comment", "opponent", "date", "url", "key",
];
const SRS_GRADUATE = 3; // kolikrát čistě po sobě = "naučeno", zmizí ze seznamu

function srsPickCfg(cfg) {
	const out = {};
	for (const k of SRS_CFG_KEYS) if (cfg[k] !== undefined) out[k] = cfg[k];
	return out;
}

// Stabilní identifikátor jedné úlohy napříč reloady. Templater dává `key`
// ("gameId:ply"); jinak zkusíme URL, pak moves+ply, pak FEN+řešení.
function blunderKey(cfg) {
	if (!cfg) return null;
	if (cfg.key) return String(cfg.key);
	if (cfg.url) return String(cfg.url);
	if (cfg.moves && cfg.ply !== undefined) return String(cfg.moves).trim() + "#" + cfg.ply;
	if (cfg.fen) return "fen:" + cfg.fen + "|" + (cfg.solution || cfg.line || "");
	return null;
}

const PROGRESS_MAX = 1500; // strop záznamů ve __progress
const PROGRESS_TTL = 150 * 24 * 3600 * 1000; // a max stáří (ms)

// náhodný interval do dalšího zopakování; s rostoucí sérií se roztahuje
function srsInterval(streak) {
	const H = 3600 * 1000;
	const bands = [[2, 10], [10, 30], [24, 72]]; // hodiny
	const [lo, hi] = bands[Math.max(0, Math.min(streak, bands.length - 1))];
	return Math.round((lo + Math.random() * (hi - lo)) * H);
}

class LichessBlunderTrainer extends Plugin {
	async onload() {
		const data = (await this.loadData()) || {};
		this.srs = data.__srs && typeof data.__srs === "object" ? data.__srs : {};
		delete data.__srs;
		this.progress = data.__progress && typeof data.__progress === "object" ? data.__progress : {};
		delete data.__progress;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.liveWidgets = new Set(); // { widget, cfg } pro živé překreslení

		this.addSettingTab(new LbtSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor(
			"lichess-blunder",
			async (source, el, ctx) => {
				const child = new MarkdownRenderChild(el);
				const entry = { widget: null, cfg: null };
				child.onunload = () => {
					if (entry.widget) entry.widget.destroy();
					this.liveWidgets.delete(entry);
				};
				ctx.addChild(child);
				this.liveWidgets.add(entry);

				const trimmed = String(source).trim();
				const cfg = parseBlock(source);
				entry.cfg = cfg;
				try {
					let opts;
					if (cfg.puzzle !== undefined) {
						// token: z bloku má přednost, jinak z nastavení pluginu
						const token = cfg.token || this.settings.lichessToken || "";
						el.createDiv({ cls: "lbt lbt-loading", text: "Načítám puzzle z Lichess…" });
						opts = await fetchPuzzle(cfg.puzzle, token);
						el.empty();
						// „▶ Další puzzle" vždy táhne přes /api/puzzle/next
						const spec = (cfg.puzzle || "").trim();
						opts.puzzleNext = {
							spec: spec.startsWith("next") ? spec : "next",
							token,
						};
					} else if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
						// fronta blunderů: JSON pole (od Templater scriptu)
						const parsed = JSON.parse(trimmed);
						const queue = (Array.isArray(parsed) ? parsed : [parsed]).map(lcKeys);
						if (!queue.length) throw new Error("Prázdný seznam blunderů.");
						this.injectSrsRepeats(queue);

						// (znovu)sestav desku z fronty: vyřešené (mimo SRS opakování)
						// přeskoč a naskoč na první nehotový. Když jsou hotové všechny,
						// ukaž místo desky panel „projít znovu".
						const mountQueue = () => {
							if (entry.widget) { entry.widget.destroy(); entry.widget = null; }
							el.empty();
							try {
								for (const e of queue) e.__done = !e.__srs && this.isBlunderDone(e);
								let start = 0;
								while (start < queue.length && queue[start].__done) start++;
								if (start >= queue.length) {
									this.renderAllDone(el, queue, () => {
										this.forgetProgressFor(queue);
										mountQueue();
									});
									return;
								}
								const o = optsFromConfig(queue[start]);
								o.queue = queue;
								o.queueIndex = start;
								o.onResult = (c, oc) => {
									this.recordProgress(c, oc);
									this.srsRecord(c, oc);
								};
								o.view = resolveView(this.settings, cfg);
								entry.widget = new BoardWidget(el, o);
							} catch (e) {
								el.empty();
								el.createDiv({
									cls: "lbt lbt-error",
									text: "Lichess Blunder Trainer: " + (e && e.message ? e.message : String(e)),
								});
							}
						};
						mountQueue();
						return;
					} else {
						opts = optsFromConfig(cfg);
					}
					opts.view = resolveView(this.settings, cfg);
					entry.widget = new BoardWidget(el, opts);
				} catch (err) {
					el.empty();
					el.createDiv({
						cls: "lbt lbt-error",
						text: "Lichess Blunder Trainer: " + (err && err.message ? err.message : String(err)),
					});
				}
			}
		);
	}

	async persist() {
		await this.saveData(Object.assign({}, this.settings, { __srs: this.srs, __progress: this.progress }));
	}

	/* ---- postup frontou (které blundery už mám hotové) ---- */

	isBlunderDone(cfg) {
		if (this.settings.resumeQueue === false) return false;
		const k = blunderKey(cfg);
		return !!(k && this.progress && this.progress[k]);
	}

	recordProgress(cfg, outcome) {
		if (this.settings.resumeQueue === false) return;
		if (!outcome || !outcome.solved) return;
		const k = blunderKey(cfg);
		if (!k) return;
		if (!this.progress[k]) this.progress[k] = Date.now();
		this.pruneProgress();
		this.persist();
	}

	// „projít znovu" – zapomene hotové pro konkrétní seznam
	forgetProgressFor(queue) {
		let changed = false;
		for (const c of queue || []) {
			const k = blunderKey(c);
			if (k && this.progress[k]) { delete this.progress[k]; changed = true; }
		}
		if (changed) this.persist();
	}

	// panel místo desky, když jsou všechny blundery ze seznamu hotové
	renderAllDone(el, queue, onReplay) {
		const total = queue.filter((e) => !e.__srs).length;
		const box = el.createDiv({ cls: "lbt lbt-alldone" });
		box.createDiv({
			cls: "lbt-title",
			text: "✅ Hotovo — všech " + total + " blunderů z tohoto seznamu máš vyřešených.",
		});
		box.createDiv({
			cls: "lbt-feedback is-info",
			text: "Nové přijdou v další denní poznámce. Chyby, které sis pokazil, se vrátí přes Opakování chyb.",
		});
		const controls = box.createDiv({ cls: "lbt-controls" });
		const b = controls.createEl("button", { cls: "lbt-btn lbt-btn-next", text: "↻ Projít znovu" });
		b.addEventListener("click", () => onReplay());
	}

	pruneProgress() {
		const cutoff = Date.now() - PROGRESS_TTL;
		let ents = Object.entries(this.progress)
			.filter(([, t]) => typeof t === "number" && t >= cutoff);
		if (ents.length > PROGRESS_MAX) {
			ents.sort((a, b) => b[1] - a[1]);
			ents = ents.slice(0, PROGRESS_MAX);
		}
		if (ents.length !== Object.keys(this.progress).length) {
			this.progress = Object.fromEntries(ents);
		}
	}

	async saveSettings() {
		await this.persist();
		// živě překresli všechny otevřené šachovnice (rozehraná pozice zůstává)
		for (const entry of this.liveWidgets) {
			if (entry.widget) {
				try {
					entry.widget.applyView(resolveView(this.settings, entry.cfg || {}));
				} catch (e) {
					/* ignore */
				}
			}
		}
	}

	/* ---- opakování chyb ---- */

	srsDue(now) {
		return Object.keys(this.srs)
			.map((k) => this.srs[k])
			.filter((e) => e && e.cfg && e.cfg.moves && (e.dueAt || 0) <= now);
	}

	// vloží dnes „splatné" opakování na náhodná místa do fronty
	injectSrsRepeats(queue) {
		if (!this.settings.srsEnabled) return;
		const due = this.srsDue(Date.now());
		for (const e of due) {
			const item = lcKeys(e.cfg);
			item.__srs = true; // widget podle toho ukáže "Opakování" a stupeň série
			item.__srsStreak = e.streak || 0;
			const at = queue.length <= 1 ? queue.length : 1 + Math.floor(Math.random() * queue.length);
			queue.splice(at, 0, item);
		}
	}

	// widget hlásí, jak úloha dopadla; outcome = { solved, hadWrong, hadHint }
	srsRecord(cfg, outcome) {
		if (!this.settings.srsEnabled) return;
		const key = cfg && cfg.key;
		if (!key || !outcome || !outcome.solved) return;
		const now = Date.now();
		const clean = !outcome.hadWrong && !outcome.hadHint;
		let e = this.srs[key];

		if (e) {
			e.lastAt = now;
			if (clean) {
				e.streak = (e.streak || 0) + 1;
				if (e.streak >= SRS_GRADUATE) delete this.srs[key];
				else e.dueAt = now + srsInterval(e.streak);
			} else {
				e.streak = 0;
				e.fails = (e.fails || 0) + 1;
				e.dueAt = now + srsInterval(0);
			}
		} else if (outcome.hadWrong) {
			// nový blunder pokažený hned napoprvé → na seznam opakování
			this.srs[key] = {
				key,
				streak: 0,
				fails: 1,
				addedAt: now,
				lastAt: now,
				dueAt: now + srsInterval(0),
				cfg: srsPickCfg(cfg),
			};
		} else {
			return; // čisté vyřešení mimo seznam = nic neukládat
		}
		this.persist();
	}
}

class LbtSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl("h3", { text: "Lichess" });

		new Setting(containerEl)
			.setName("Lichess API token")
			.setDesc(
				"Nepovinné. Použije se automaticky u všech puzzle bloků i u tlačítka " +
					"Další puzzle – zvedne rate limity a umožní personalizované puzzly. " +
					"Vytvoř na lichess.org → Preferences → API access tokens, žádný scope " +
					"není potřeba. Ukládá se v plain textu do data.json pluginu."
			)
			.addText((t) => {
				t.setPlaceholder("lip_xxxxxxxxxxxxxxxx")
					.setValue(s.lichessToken)
					.onChange(async (v) => {
						s.lichessToken = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.type = "password";
				t.inputEl.autocomplete = "off";
				t.inputEl.spellcheck = false;
			});

		containerEl.createEl("h3", { text: "Trénink" });

		const srsCount = Object.keys(this.plugin.srs || {}).length;
		new Setting(containerEl)
			.setName("Opakování chyb")
			.setDesc(
				"Blunder, který napoprvé zkusíš špatně, se přidá na seznam a vrací se " +
					"v náhodných intervalech do fronty, dokud ho 3× po sobě nezvládneš " +
					"čistě (bez chyby a bez nápovědy). Aktuálně na seznamu: " + srsCount + "."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.srsEnabled !== false).onChange(async (v) => {
					this.plugin.settings.srsEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		if (srsCount > 0) {
			new Setting(containerEl)
				.setName("Vymazat seznam opakování")
				.setDesc("Smaže všech " + srsCount + " čekajících blunderů. Nevratné.")
				.addButton((b) =>
					b.setButtonText("Vymazat").setWarning().onClick(async () => {
						this.plugin.srs = {};
						await this.plugin.persist();
						this.display();
					})
				);
		}

		const doneCount = Object.keys(this.plugin.progress || {}).length;
		new Setting(containerEl)
			.setName("Pokračovat ve frontě")
			.setDesc(
				"Seznam blunderů (např. v denní poznámce) si pamatuje, které už máš " +
					"vyřešené. Po znovunačtení poznámky naskočí na první nevyřešený, ne od začátku. " +
					"Uloženo hotových: " + doneCount + "."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.resumeQueue !== false).onChange(async (v) => {
					this.plugin.settings.resumeQueue = v;
					await this.plugin.saveSettings();
				})
			);

		if (doneCount > 0) {
			new Setting(containerEl)
				.setName("Zapomenout vyřešené blundery")
				.setDesc("Smaže historii " + doneCount + " vyřešených. Všechny seznamy pak zase začnou od začátku.")
				.addButton((b) =>
					b.setButtonText("Zapomenout").setWarning().onClick(async () => {
						this.plugin.progress = {};
						await this.plugin.persist();
						this.display();
					})
				);
		}

		containerEl.createEl("h3", { text: "Vzhled" });

		new Setting(containerEl)
			.setName("Souřadnice na desce")
			.setDesc("Popisky a–h / 1–8 po okrajích šachovnice.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showCoordinates !== false).onChange(async (v) => {
					this.plugin.settings.showCoordinates = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Motiv šachovnice")
			.setDesc(
				"Automatický = pole nemají vlastní barvu, převezmou to, co je pod nimi " +
					"(pozadí poznámky / calloutu / obrázku). Vlastní = barvy zadané níže."
			)
			.addDropdown((d) => {
				d.addOption("auto", "Automatický (podle pozadí)");
				for (const [k, v] of Object.entries(BOARD_THEMES)) d.addOption(k, v.label);
				d.addOption("custom", "Vlastní (barvy níže)");
				const cur = s.boardTheme === "auto" || s.boardTheme === "custom" || BOARD_THEMES[s.boardTheme]
					? s.boardTheme
					: "auto";
				d.setValue(cur).onChange(async (v) => {
					s.boardTheme = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Vlastní barva — světlá pole")
			.setDesc("HEX, např. #EBECD0. Použije se u motivu Vlastní; u Automatického jen když je vyplněná.")
			.addText((t) =>
				t.setPlaceholder("#EBECD0").setValue(s.lightColor).onChange(async (v) => {
					s.lightColor = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Vlastní barva — tmavá pole")
			.addText((t) =>
				t.setPlaceholder("#779556").setValue(s.darkColor).onChange(async (v) => {
					s.darkColor = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sada figur")
			.addDropdown((d) => {
				for (const [k, label] of Object.entries(PIECE_SETS)) d.addOption(k, label);
				d.setValue(s.pieceSet).onChange(async (v) => {
					s.pieceSet = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Sytost / průhlednost šachovnice")
			.setDesc(
				"Automatický motiv: síla závoje polí. Barevné motivy: krytí polí " +
					"(nižší = víc prosvítá pozadí). Figury zůstávají plné."
			)
			.addSlider((sl) =>
				sl
					.setLimits(10, 100, 5)
					.setValue(s.boardOpacity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.boardOpacity = v;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Šipky" });

		new Setting(containerEl)
			.setName("Barva ručních šipek")
			.setDesc(
				"Výchozí barva při pravém kliku. Shift/Alt/Ctrl ji dočasně změní na " +
					"červenou/modrou/žlutou. Funkční šipky (nápověda, poslední tah) zůstávají."
			)
			.addDropdown((d) => {
				for (const [k, label] of Object.entries(DRAW_COLOR_LABELS)) d.addOption(k, label);
				d.addOption("custom", "Vlastní (HEX níže)");
				d.setValue(DRAW_COLOR_LABELS[s.arrowColor] ? s.arrowColor : (s.arrowColor === "custom" ? "custom" : "green"))
					.onChange(async (v) => {
						s.arrowColor = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Vlastní barva šipek")
			.setDesc("HEX, např. #E0115F. Použije se, když je výše zvoleno Vlastní.")
			.addText((t) =>
				t.setPlaceholder("#E0115F").setValue(s.arrowColorCustom).onChange(async (v) => {
					s.arrowColorCustom = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Průhlednost šipek")
			.setDesc("Platí pro ručně kreslené šipky a kolečka.")
			.addSlider((sl) =>
				sl
					.setLimits(15, 100, 5)
					.setValue(s.arrowOpacity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.arrowOpacity = v;
						await this.plugin.saveSettings();
					})
			);

		const tip = containerEl.createEl("p", { cls: "setting-item-description" });
		tip.setText(
			"V jednotlivém bloku jde nastavení přepsat klíči: board:, pieces:, opacity:, " +
				"light:, dark:, arrowColor:, arrowOpacity:, coords:, token:"
		);
	}
}

module.exports = LichessBlunderTrainer;
module.exports.default = LichessBlunderTrainer;
