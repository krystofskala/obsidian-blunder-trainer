# Lichess Blunder Trainer

Obsidian plugin: interaktivní šachovnice v poznámkách. Vykreslí code block
` ```lichess-blunder ` jako plnohodnotný trenažér — zahraješ tah, hned vidíš
jestli je nejlepší, můžeš si nechat ukázat řešení se šipkou a proklikat
variantu tam a zpět.

Dva režimy:

- **blunder** — pozice těsně před blunderem z tvojí Lichess partie; stačí najít
  ten jeden nejlepší tah. Zbytek varianty je k prohlédnutí. Blok může nést
  **frontu** blunderů (JSON pole) — po vyřešení jednoho klikneš na **▶ Další
  blunder** a jedeš dál.
- **puzzle** — Lichess puzzle; musí sedět celá vynucená linie (soupeřovy
  odpovědi se hrají samy). Alternativní mat se uznává. Po vyřešení **▶ Další
  puzzle** natáhne nový přes `/api/puzzle/next`.

Blunder bloky obvykle generuje Templater script do daily note (viz
`extras/templater/lichessBlunderCallout.js` — stáhne z Lichess API tvoje
analyzované partie, vybere `blundersPerNote` nepoužitých blunderů a zapíše je
jako JSON pole); puzzle bloky se dají psát ručně.

### Opakování chyb (mini SRS)

Blunder z fronty, který **napoprvé zkusíš špatně**, se přidá na seznam a v
náhodných intervalech se vrací do fronty (v jakémkoli JSON blunder bloku),
dokud ho **3× po sobě nezvládneš čistě** — bez špatného tahu a bez nápovědy.
Pak se ze seznamu vyřadí. Seznam je v `data.json` pluginu (klíč `__srs`),
zapíná/maže se v nastavení. Vyžaduje, aby entries ve frontě měly `key`
(Templater script ho přidává).

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
`src/plugin.js` spojené dohromady. Edituj `src/plugin.js`, ne `main.js`.

```
node build.mjs            # jen sestaví main.js
node build.mjs --deploy   # sestaví a nakopíruje do vaultu
```

`--deploy` bere cíl z `deploy.local.json` (gitignored) nebo z env `LBT_DEPLOY_DIR`:

```json
{ "dir": "C:/…/<vault>/.obsidian/plugins/lichess-blunder-trainer" }
```

Nasadí `main.js`, `manifest.json`, `styles.css` a prázdný `.hotreload`. Když má
`deploy.local.json` navíc `templaterDir`, nakopíruje tam i doprovodný Templater
script. S pluginem [Hot Reload](https://github.com/pjeby/hot-reload) se změna
projeví hned; jinak plugin ve vaultu vypni a zapni.

- `vendor/chess.js` — [chess.js](https://github.com/jhlywa/chess.js) 1.0.0-beta.8 (BSD-2-Clause), legalita tahů, SAN ↔ UCI, detekce matu.
- `vendor/pieces.js` — vlastní sada `neo` (MIT) + 10 sad z [lichess-org/lila](https://github.com/lichess-org/lila) (GPL-2.0), vše inline SVG. Regenerace: `node vendor/make-pieces.mjs`.

## Syntaxe code bloku

`key: value` řádky, `#` = komentář. Neznámé klíče se ignorují.

Blok, jehož obsah začíná `[`, se čte jako **JSON pole** — fronta blunderů; každý
prvek má stejné klíče jako blunder blok (malými písmeny). Widget mezi nimi
přepíná tlačítkem **▶ Další blunder**.

### puzzle

| klíč | popis |
|---|---|
| `puzzle` | `daily` \| `<id>` \| `next` \| `next <theme>` — stáhne se z Lichess puzzle API |
| `token` | nepovinný Lichess API token (Bearer). Když je vyplněný v nastavení pluginu, použije se automaticky u všech puzzle bloků — tady jen na přepsání. |

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
- **💡 Nápověda** — stupňovitá, vždy jen na další tah:
  1. klik → zvýrazní figuru, kterou hrát
  2. klik → nakreslí šipku toho tahu
  3. klik → zahraje ten tah za tebe (+ vynucenou odpověď); pak jedeš dál
- Po vyřešení / dohrání přes nápovědu: **⟲ ◀ ▶** na proklikání celé varianty.
- **▶ Další blunder / ▶ Další puzzle** — načte další z fronty / z Lichess.
- **↺ Zkusit znovu** · **⇅ Otočit** · **⧉ FEN** (do schránky).
- **série 🔥** se počítá jen za vyřešení **napoprvé, bez nápovědy a bez jediného
  špatného tahu**. Nápověda ani špatný pokus se do série nezapočítá.
- **Ruční šipky (PC):** pravý klik = kolečko na poli, pravé táhnutí = šipka mezi
  poli. Výchozí barvu a průhlednost nastavíš v Settings; `Shift` červená, `Alt`
  modrá, `Ctrl` žlutá to dočasně přebijí. Levý klik / tah šipky smaže.

## Nastavení pluginu

Settings → Lichess Blunder Trainer:

| volba | popis |
|---|---|
| **Lichess API token** | Nepovinné. Vyplněný se automaticky použije u **všech** puzzle bloků i u „▶ Další puzzle" — zvedne rate limity, umožní personalizované puzzly. Bez scope. Ukládá se do `data.json` pluginu v plain textu. |
| **Opakování chyb** | Zap/vyp mini SRS (viz výše) + počet čekajících + tlačítko vymazat seznam. |
| **Souřadnice na desce** | Popisky a–h / 1–8 po okrajích. Přepis v bloku: `coords: false`. |
| **Motiv šachovnice** | `auto` (výchozí – viz níže), nebo pevné barvy: `green` (Lichess), `brown`, `blue`, `purple`, `grey`, `wood`, `custom` |
| **Vlastní barvy** | HEX světlých / tmavých polí (jen pro motiv `custom`) |
| **Sada figur** | `neo` (vlastní geometrická), `cburnett`, `merida`, `alpha`, `staunty`, `pixel`, `shapes`, `anarcandy`, `firi`, `horsey`, `maestro`, nebo `unicode` |
| **Sytost / průhlednost šachovnice** | 10–100 %. U `auto` = síla závoje polí. U barevných motivů = krytí polí. Figury zůstávají plné. |
| **Barva ručních šipek** | `green` / `red` / `blue` / `yellow` / `custom` (+ HEX). Výchozí barva pravého kliku; Shift/Alt/Ctrl ji přebijí. |
| **Průhlednost šipek** | 15–100 %, jen pro ručně kreslené šipky a kolečka. |

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
light: #EAEAEA          # vlastní barvy jen pro tento blok
dark: #6C8CB4
arrowColor: #E0115F     # barva ručních šipek jen pro tento blok
arrowOpacity: 70
```
````

Figury jsou z [lichess-org/lila](https://github.com/lichess-org/lila) (GPL-2.0),
inline v `vendor/pieces.js`.

## Licence

Kód pluginu: MIT (viz `LICENSE`). Přibalené knihovny/assety ve `vendor/` si drží
vlastní licence — `chess.js` (BSD-2-Clause) a sady figur z lichess/lila
(GPL-2.0). Podrobnosti: `vendor/CREDITS.md`.
