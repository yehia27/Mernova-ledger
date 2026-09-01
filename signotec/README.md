# signotec — Undo last stroke on the pad's Retry button

The pad's built-in **Retry** touch button no longer clears the whole
signature. It removes only the **last stroke**, in the local preview
(`sigCanvas`) *and* on the **pad's own screen**.

API mode only. Run `node test/simulate-pad.js` to exercise the whole file
against a simulated pad.

## Why the earlier attempts blanked the screen and closed the session

Not a firmware limitation. The old `onMessage()` dispatched **every**
response to **every** handler through one fall-through `switch`. So the
`DISPLAY_SET_TARGET` / `DISPLAY_SET_IMAGE` responses belonging to the Undo
repaint also reached `api_signature_start_responses()`, whose `SET_IMAGE`
branch did, unconditionally:

```js
preparationState = preparationStates.setCancelButton;
api_signature_start();
```

That restarts the one-time **preparation** sequence mid-session — re-adding
hot spots, re-setting the sign rect, calling `SIGNATURE_START` again. The
cascade fails, and every failure branch there calls `close_pad()`. Blank
screen, then the session closes.

## How it works now

`handleResponse()` routes each response to **exactly one** handler, and the
Undo state machine gets first refusal — so the whole class of bug is gone.
Nothing in the Undo path calls `close_pad()`: on error it abandons the
screen sync only, and the saved image stays correct because it comes from
`sigCanvas`.

The repaint never writes a bitmap to the **live** display. It renders into
image store 1 and blits it, the same mechanism the preparation sequence
already uses:

| step | command |
|---|---|
| 1 | `API_SIGNATURE_RETRY` — drop the firmware's captured strokes |
| 2 | `API_DISPLAY_SET_TARGET` → `1` (off-screen store) |
| 3 | `API_DISPLAY_SET_IMAGE` — template + remaining strokes |
| 4–5 | `API_DISPLAY_SET_TEXT_IN_RECT` ×2 — the two labels |
| 6 | `API_DISPLAY_SET_TARGET` → `0` (live display) |
| 7 | `API_DISPLAY_SET_IMAGE_FROM_STORE` → `1` — firmware-native blit |

If a step fails or times out, the sync stops there and the session keeps
going with the pad screen one stroke out of date.

## Tuning flags (top of the file)

| flag | default | meaning |
|---|---|---|
| `UNDO_SYNC_TO_PAD` | `true` | `false` = local-only Undo, no device commands |
| `UNDO_RETRY_FIRST` | `true` | flip to `false` to send `RETRY` *after* the repaint |
| `UNDO_STORE_ID` | `1` | image store the preparation sequence renders into |
| `UNDO_TIMEOUT_MS` | `8000` | give up on a step if the pad does not answer |
| `PAD_PEN_WIDTH` | `3` | matches `DISPLAY_CONFIG_PEN`, so the repaint looks native |
| `PREVIEW_PEN_WIDTH` | `5` | pen width for the on-screen preview |

## Logging

`logMessage()` used to overwrite `#log` on every message, so only the last
line survived — which is why the earlier crash could never be diagnosed. It
now **appends**, shortens the huge base64 payloads, mirrors to the browser
console, and every error reports its `TOKEN_PARAM_RETURN_CODE` and
`TOKEN_PARAM_ERROR_DESCRIPTION`.

Prefixes: `>>` sent, `<<` received, `--` progress, `!!` error.

## Bugs fixed along the way

- `padMode` was stuck on `Default` because the mode selector was never
  called, so retry / confirm / cancel / image / sign_data all sent the wrong
  token. Default mode is now gone entirely; the file is API-only.
- The no-WebSocket branch read `evt.target.url` with no `evt` in scope — a
  `ReferenceError` on any browser without WebSocket support.
- `signature_retry_send()` emitted malformed JSON (`message + "1"`) followed
  by an `alert(1)` that halted execution.
- Several stray `debugger` statements halted execution with DevTools open.
- `allcanvass` grew without bound, one entry per pen sample, and was never
  read.
- Drawing re-stroked the entire accumulated path on every pen sample, so
  cost grew with the square of the stroke length. Each segment now gets its
  own path.
- The start-of-stroke dot was filled white instead of the pen colour.
- Every `getElementById` result was used unguarded; a missing optional
  element aborted the session.
- The final image is taken from `sigCanvas.toDataURL()` and exposed as
  `window.lastSignatureImage` (and into `#SignatureImageData` when present).
  It is **not** read back from the pad: `SAVE_AS_STREAM_EX` and
  `GET_SIGN_DATA` both read the pad's internal buffer, which still contains
  undone strokes. This system has no legal or biometric use for SignData.

## Removed

Default-mode code (`search_for_pads`, `open_pad`, `signature_start`, the
selection dialog), the unreachable `signature_image` / `signature_sign_data`
round trip and the ~160 commented-out lines of Ajax inside it. The file went
from 2556 lines to 1723, and every remaining line is reachable.

`clearSignature()`, `check_boxes_selectedElements_onchange()` and
`ModeListName_onchange()` are kept as guarded no-ops, since the HTML may
still reference them from inline handlers.

## If the pad does not open

Run this in the browser console once the page is loaded:

```js
signotecDiagnostics()
```

It reports the connection state, whether `#sigCanvas` and `#log` were found,
the pad type and whether it is supported, and where each state machine is
sitting. It also writes the same line into `#log`.

The connection is opened lazily and is re-checked by `getSignature()`, so a
page where `onMainWindowLoad()` never ran, or where `#sigCanvas` is created
later inside a dialog, still works. Commands issued before the socket is open
are queued and flushed on `onopen` rather than throwing `InvalidStateError`.
