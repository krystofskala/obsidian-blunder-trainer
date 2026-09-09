/*
 * Regeneruje vendor/pieces.js: vlastní sada "neo" (MIT) + vybrané sady
 * z lichess-org/lila (GPL-2.0). Stahuje SVG přímo z GitHubu.
 *
 * Spuštění:  node vendor/make-pieces.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAMES = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];
const LICHESS = ["cburnett", "merida", "alpha", "staunty", "pixel", "shapes", "anarcandy", "firi", "horsey", "maestro"];
const RAW = "https://raw.githubusercontent.com/lichess-org/lila/master/public/piece";

/* ---- vlastní geometrická sada "neo" (viewBox 45x45, jako lichess) ---- */
const BASE = "M11 41 L34 41 L34 38 L31 36 L14 36 L11 38 Z";
const SHAPES = {
	P: () => '<circle cx="22.5" cy="14" r="5.3"/><path d="M17.6 36 L19.6 20.5 L25.4 20.5 L27.4 36 Z"/>',
	R: () =>
		'<path d="M13.5 36 L15 20 L30 20 L31.5 36 Z"/><path d="M12 20 L12 10 L16 10 L16 13 L19 13 L19 10 L26 10 L26 13 L29 13 L29 10 L33 10 L33 20 Z"/>',
	B: () =>
		'<path d="M15.5 36 L18 22 L27 22 L29.5 36 Z"/><path d="M22.5 7 C 15.5 15 15.5 24 22.5 26.5 C 29.5 24 29.5 15 22.5 7 Z"/><circle cx="22.5" cy="6" r="2"/><path d="M20 14 L27 21" fill="none" stroke-width="1.7"/>',
	N: (c) =>
		'<path d="M13.5 36 L15 27 L17 20 L15 14 L17.5 8.5 L22.5 6.5 L27.5 10 L31.5 15 L33.5 22.5 L31 27 L29 29.5 L27 36 Z"/>' +
		`<circle cx="25.6" cy="15.4" r="1.5" fill="${c.eye}" stroke="none"/>`,
	Q: () =>
		'<path d="M15 36 L17 24 L28 24 L30 36 Z"/><path d="M13.5 24.5 L15.8 12.5 L19 20 L22.5 10.5 L26 20 L29.2 12.5 L31.5 24.5 Z"/><circle cx="15.8" cy="10.5" r="1.8"/><circle cx="22.5" cy="8.5" r="1.8"/><circle cx="29.2" cy="10.5" r="1.8"/>',
	K: () =>
		'<path d="M15 36 L17 23 L28 23 L30 36 Z"/><rect x="14" y="17.5" width="17" height="6" rx="1.5"/><path d="M21 5 L24 5 L24 8 L27 8 L27 11 L24 11 L24 18 L21 18 L21 11 L18 11 L18 8 L21 8 Z"/>',
};
const COLS = {
	w: { fill: "#f3f2f6", stroke: "#15141c", eye: "#15141c" },
	b: { fill: "#16151d", stroke: "#f3f2f6", eye: "#f3f2f6" },
};
function neo(ck, t) {
	const c = COLS[ck];
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45">' +
		`<g fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">` +
		`<path d="${BASE}"/>${SHAPES[t](c)}</g></svg>`
	);
}

const out = { neo: {} };
for (const t of ["K", "Q", "R", "B", "N", "P"]) {
	out.neo["w" + t] = neo("w", t);
	out.neo["b" + t] = neo("b", t);
}

for (const set of LICHESS) {
	out[set] = {};
	for (const n of NAMES) {
		const res = await fetch(`${RAW}/${set}/${n}.svg`);
		if (!res.ok) throw new Error(`${set}/${n}: ${res.status}`);
		out[set][n] = (await res.text()).trim().replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");
	}
	console.log("staženo:", set);
}

let src = '// Piece sets. Lichess sady z lichess-org/lila (GPL-2.0). Sada "neo" je vlastní (MIT).\n';
src += "// Regeneruj: node vendor/make-pieces.mjs\nmodule.exports = {\n";
for (const [set, map] of Object.entries(out)) {
	src += "\t" + JSON.stringify(set) + ": {\n";
	for (const n of NAMES) src += "\t\t" + JSON.stringify(n) + ": " + JSON.stringify(map[n]) + ",\n";
	src += "\t},\n";
}
src += "};\n";
writeFileSync(join(HERE, "pieces.js"), src);
console.log("vendor/pieces.js zapsán (" + src.length + " B, " + Object.keys(out).length + " sad)");
