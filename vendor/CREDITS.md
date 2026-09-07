# Vendored third-party assets

These files are bundled into `main.js` by `build.mjs`. They keep their original
licenses; the plugin's MIT license does not apply to them.

## chess.js (`vendor/chess.js`)

- Source: https://github.com/jhlywa/chess.js
- Version: 1.0.0-beta.8
- License: BSD-2-Clause
- Copyright (c) 2023, Jeff Hlywa

Used for move legality, SAN ↔ UCI conversion and check/mate detection.

## Piece sets (`vendor/pieces.js`)

Inlined SVG piece sets `cburnett`, `merida`, `alpha`, `staunty`.

- Source: https://github.com/lichess-org/lila (`public/piece/<set>/`)
- License: GPL-2.0
- The cburnett set is by Colin M.L. Burnett (originally Wikimedia Commons).

If you redistribute this plugin you must keep this notice and the GPL-2.0
terms for the piece SVGs.
