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
	cburnett: "cburnett",
	merida: "merida",
	alpha: "alpha",
	staunty: "staunty",
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

	// blokové vlastní barvy mají přednost i před "auto"
	const blkLight = hexToRgbTriple(cfg.light);
	const blkDark = hexToRgbTriple(cfg.dark);

	// AUTO: pole nemají vlastní barvu, jen průsvitný závoj → převezmou to,
	// co je pod nimi (pozadí poznámky / calloutu / obrázku).
	if (themeName === "auto" && !cfg.board && !blkLight && !blkDark) {
		return { auto: true, pieceSet, alpha };
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

	return { auto: false, light, dark, pieceSet, alpha };
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
		this.view = opts.view || { light: "235, 236, 208", dark: "119, 149, 86", pieceSet: "cburnett", alpha: 1 };
		this.timers = new Set();
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
		this.arrows = this.opts.lastMove ? [square2(this.opts.lastMove, "hint")] : [];
		if (first) this.build();
		else this.render();
	}

	// ------- DOM skeleton -------
	build() {
		this.root.empty();
		this.root.addClass("lbt");
		this.applyViewVars();

		this.elTitle = this.root.createDiv({ cls: "lbt-title" });

		const stage = this.root.createDiv({ cls: "lbt-stage" });
		this.elBoard = stage.createDiv({ cls: "lbt-board" });
		this.elArrows = stage.createSvg("svg", { cls: "lbt-arrows" });
		this.elArrows.setAttribute("viewBox", "0 0 8 8");
		this.elArrows.setAttribute("preserveAspectRatio", "none");
		const defs = this.elArrows.createSvg("defs");
		const mk = (id, color) => {
			const m = defs.createSvg("marker", {
				attr: {
					id,
					viewBox: "0 0 10 10",
					refX: "7",
					refY: "5",
					markerWidth: "4",
					markerHeight: "4",
					orient: "auto-start-reverse",
				},
			});
			m.createSvg("path", { attr: { d: "M0,0 L10,5 L0,10 z", fill: color } });
		};
		mk("lbt-head-good", "var(--lbt-good, #3fb950)");
		mk("lbt-head-hint", "var(--lbt-hint, #d29922)");

		this.elSquares = {};
		this.elBoard.addEventListener("click", (e) => this.onBoardClick(e));

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

	renderTitle() {
		const side = this.game.turn() === "w" ? "bílé" : "černé";
		let label;
		if (this.opts.mode === "puzzle") {
			label = "🧩 Lichess puzzle";
			if (this.opts.meta.rating) label += " · " + this.opts.meta.rating;
		} else {
			label = "♟ Blunder z Lichess partie";
		}
		let tail;
		if (this.status === "solved") tail = " — ✅ vyřešeno";
		else if (this.status === "revealed") tail = " — řešení";
		else if (this.status === "nolines") tail = "";
		else tail = " — na tahu " + side + ", najdi nejlepší tah";
		this.elTitle.setText(label + tail);
	}

	renderPieces() {
		const board = this.game.board(); // [rank8..rank1][fileA..fileH]
		for (const sq of Object.keys(this.elSquares)) {
			const cell = this.elSquares[sq];
			cell.empty();
			cell.removeClass("lbt-sel", "lbt-dest", "lbt-good", "lbt-bad", "lbt-from", "lbt-to");
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
				if (this.elSquares[d]) this.elSquares[d].addClass("lbt-dest");
			}
		}
		// přetrvávající "blik" po tahu (přežije překreslení, mizí časovačem)
		if (this.flashSq && this.elSquares[this.flashSq.sq]) {
			this.elSquares[this.flashSq.sq].addClass(
				this.flashSq.kind === "good" ? "lbt-good" : "lbt-bad"
			);
		}
	}

	renderArrows() {
		// vyčistit staré čáry (ne defs)
		this.elArrows.querySelectorAll("line.lbt-arrow").forEach((n) => n.remove());
		for (const a of this.arrows) {
			if (!a.from || !a.to) continue;
			const p1 = this.center(a.from);
			const p2 = this.center(a.to);
			const line = this.elArrows.createSvg("line", {
				cls: "lbt-arrow",
				attr: {
					x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
					stroke: a.kind === "good"
						? "var(--lbt-good, #3fb950)"
						: "var(--lbt-hint, #d29922)",
					"stroke-width": "0.16",
					"stroke-linecap": "round",
					opacity: "0.85",
					"marker-end": a.kind === "good" ? "url(#lbt-head-good)" : "url(#lbt-head-hint)",
				},
			});
			line.dataset.k = a.kind;
		}
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
		if (this.status === "nolines") {
			this.elFeedback.addClass("is-info");
			msg = "K téhle pozici není uložená varianta řešení.";
		} else if (this.status === "solved") {
			this.elFeedback.addClass("is-good");
			msg = "Správně! Celá varianta sedí.";
		} else if (this.status === "revealed") {
			this.elFeedback.addClass("is-info");
			msg = "Tohle bylo nejlepší pokračování. Proklikej si ho tlačítky ◀ ▶.";
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
			btn("⟲ začátek", "", () => this.reviewGoto(0));
			btn("◀", "", () => this.reviewGoto((this.reviewIdx ?? 0) - 1),
				(this.reviewIdx ?? 0) <= 0);
			btn("▶", "", () => this.reviewGoto((this.reviewIdx ?? 0) + 1),
				(this.reviewIdx ?? 0) >= this.opts.lineUci.length);
		}
		if (this.status === "playing") {
			btn("💡 Ukázat řešení", "lbt-btn-hint", () => this.reveal());
		}
		btn("↺ Zkusit znovu", "", () => this.reset(false));
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

	onBoardClick(e) {
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
		this.cursor++;
		this.flash(to, "good");

		// blunder režim: stačí najít první (nejlepší) tah, zbytek varianty je
		// jen k prohlédnutí. puzzle režim: musí sedět celá vynucená linie.
		const target = this.opts.requireFullLine ? this.opts.lineUci.length : 1;
		if (this.cursor >= target) {
			this.status = "solved";
			this.reviewIdx = this.cursor;
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
			if (this.cursor >= this.opts.lineUci.length) {
				this.status = "solved";
				this.reviewIdx = this.opts.lineUci.length;
			}
			this.render();
		}, 450);
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

class LichessBlunderTrainer extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

				const cfg = parseBlock(source);
				entry.cfg = cfg;
				try {
					let opts;
					if (cfg.puzzle !== undefined) {
						el.createDiv({ cls: "lbt lbt-loading", text: "Načítám puzzle z Lichess…" });
						opts = await fetchPuzzle(cfg.puzzle, cfg.token);
						el.empty();
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

	async saveSettings() {
		await this.saveData(this.settings);
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

		const tip = containerEl.createEl("p", { cls: "setting-item-description" });
		tip.setText(
			"V jednotlivém bloku jde nastavení přepsat klíči: board:, pieces:, opacity:, light:, dark:"
		);
	}
}

module.exports = LichessBlunderTrainer;
module.exports.default = LichessBlunderTrainer;
