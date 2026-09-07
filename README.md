# Lichess Blunder Trainer

Obsidian plugin: interaktivní šachovnice v poznámkách. Vykreslí code block
` ```lichess-blunder ` jako plnohodnotný trenažér — zahraješ tah, hned vidíš
jestli je nejlepší, můžeš si nechat ukázat řešení se šipkou a proklikat
variantu tam a zpět.

Dva režimy:

- **blunder** — pozice těsně před blunderem z tvojí Lichess partie; stačí najít
  ten jeden nejlepší tah. Zbytek varianty je k prohlédnutí.
- **puzzle** — Lichess puzzle; musí sedět celá vynucená linie (soupeřovy
  odpovědi se hrají samy). Alternativní mat se uznává.

Blunder bloky obvykle generuje Templater script do daily note (viz
`extras/templater/lichessBlunderCallout.js` — stáhne z Lichess API tvoje
analyzované partie, najde nepoužitý blunder a vygeneruje blok); puzzle bloky se
dají psát ručně.

## Instalace

Není v obchodě.

**Ručně:** stáhni `main.js`, `manifest.json`, `styles.css` z
[releases](../../releases) (nebo si je sestav, viz Build) do:

```
<vault>/.obsidian/plugins/lichess-blunder-trainer/
    main.js
    manifest.json
    styles.css
```

Pak Settings → Community plugins → zapnout **Lichess Blunder Trainer**.

**Přes [BRAT](https://github.com/TfTHacker/obsidian42-brat):** přidej repozitář
`krystofskala/obsidian-blunder-trainer`.

## Build

Bez závislostí. `main.js` = `vendor/chess.js` + `vendor/pieces.js` +
`src/plugin.js` spojené dohromady:

```
node build.mjs
```

Edituj `src/plugin.js`, ne `main.js`.

- `vendor/chess.js` — [chess.js](https://github.com/jhlywa/chess.js) 1.0.0-beta.8 (BSD-2-Clause), legalita tahů, SAN ↔ UCI, detekce matu.
- `vendor/pieces.js` — cburnett sada figur z [lichess-org/lila](https://github.com/lichess-org/lila) (GPL-2.0), inline SVG.

## Syntaxe code bloku

`key: value` řádky, `#` = komentář. Neznámé klíče se ignorují.

### puzzle

| klíč | popis |
|---|---|
| `puzzle` | `daily` \| `<id>` \| `next` \| `next <theme>` — stáhne se z Lichess puzzle API |
| `token` | nepovinný Lichess API token (Bearer) pro personalizované `next` |

### blunder (z partie)

| klíč | popis |
|---|---|
| `moves` | celá partie v SAN, oddělené mezerou |
| `ply` | index tahu blunderu (0 = 1. tah bílého) — pozice se počítá těsně před ním |
| `orientation` | `white` \| `black` (default = strana na tahu) |
| `variation` | doporučená varianta z Lichess analýzy v SAN (první tah = nejlepší) |
| `best` | nejlepší tah v UCI (fallback, když chybí `variation`) |
| `played` | co jsi zahrál v partii (SAN) — v UI skryté do vyřešení |
| `evalBefore`, `evalAfter` | hodnocení před/po (jen text do patičky) |
| `comment` | komentář z Lichess analýzy |
| `opponent`, `date` | do patičky |
| `url` | odkaz na tlačítko „↗ Lichess" |

### přímá pozice

| klíč | popis |
|---|---|
| `fen` | výchozí pozice |
| `solution` | tahy řešení v UCI, oddělené mezerou (liché indexy = vynucená odpověď soupeře) |
| `orientation` | volitelně |
| `mode` | `puzzle` (default) nebo `blunder` (pak stačí 1. tah) |
| `lastMove` | UCI tahu k zvýraznění |

## Ovládání

- Klik na figuru → zvýrazní se možné tahy, klik na cíl = tah.
- Správně = zelený rámeček; špatně = červený a tah se vezme zpět.
- **💡 Ukázat řešení** — nakreslí šipku a přehraje linii, pak ◀ ▶ na proklikání.
- **↺ Zkusit znovu** — reset pozice.

## Vzhled — nastavení pluginu

Settings → Lichess Blunder Trainer:

| volba | popis |
|---|---|
| **Motiv šachovnice** | `auto` (výchozí – viz níže), nebo pevné barvy: `green` (Lichess), `brown`, `blue`, `purple`, `grey`, `wood`, `custom` |
| **Vlastní barvy** | HEX světlých / tmavých polí (jen pro motiv `custom`) |
| **Sada figur** | `cburnett`, `merida`, `alpha`, `staunty`, nebo `unicode` (bez obrázků) |
| **Sytost / průhlednost šachovnice** | 10–100 %. U `auto` = síla závoje polí. U barevných motivů = krytí polí. Figury zůstávají plné. |

**Motiv `auto`:** pole nemají vlastní barvu, jen průsvitný závoj (světlá =
zesvětlí, tmavá = ztmaví). Deska tím převezme barvu čehokoli je pod ní — pozadí
poznámky, calloutu, obrázku — a funguje i přes víc průhledných vrstev. Přizpůsobí
se i světlému/tmavému režimu Obsidianu bez dalšího nastavení. Chceš-li konkrétní
barvu, vyber pevný motiv nebo `custom`.

Změna nastavení se **hned promítne** do všech otevřených šachovnic, rozehraná
pozice zůstane.

### Přepis v jednom bloku

Kterýkoli klíč jde nastavit lokálně přímo v bloku (přebije globální nastavení):

````
```lichess-blunder
puzzle: daily
board: brown
pieces: staunty
opacity: 45
```

```lichess-blunder
puzzle: daily
light: #EAEAEA        # vlastní barvy jen pro tento blok
dark: #6C8CB4
```
````

Figury jsou z [lichess-org/lila](https://github.com/lichess-org/lila) (GPL-2.0),
inline v `vendor/pieces.js`.

## Licence

Kód pluginu: MIT (viz `LICENSE`). Přibalené knihovny/assety ve `vendor/` si drží
vlastní licence — `chess.js` (BSD-2-Clause) a sady figur z lichess/lila
(GPL-2.0). Podrobnosti: `vendor/CREDITS.md`.
