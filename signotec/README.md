# signotec — Undo last stroke on the Retry button

The pad's built-in **Retry** touch button no longer clears the whole
signature. It now removes only the **last stroke**, both in the local
preview (`sigCanvas`) and on the **pad's own screen**.

## Why the previous attempts blanked the screen and closed the session

Not a firmware limitation. `onMessage()` dispatches **every** response to
**every** handler through one big fall-through `switch`. So the
`DISPLAY_SET_TARGET` / `DISPLAY_SET_IMAGE` responses that belonged to the
Undo repaint were also delivered to `api_signature_start_responses()`,
whose `SET_IMAGE` branch does, unconditionally:

```js
preparationState = preparationStates.setCancelButton;
api_signature_start();
```

That re-enters the one-time **preparation** sequence in the middle of a
live session — re-adding hot spots, re-setting the sign rect, calling
`SIGNATURE_START` again. The cascade fails, and every failure branch in
there calls `close_pad()`. Blank screen, then the session closes.

## The fix

1. `undoSync_handleResponse()` gets **first refusal** on every response in
   `onMessage()`, which returns immediately when the response is consumed.
   No Undo response can reach the preparation handlers again.
2. Nothing in the Undo path calls `close_pad()`. On any error it logs the
   return code and description and abandons the *screen sync only* — the
   signing session stays alive and the saved image is still correct.
3. The repaint never writes a bitmap to the **live** display. It uses the
   same image-store mechanism the preparation sequence already uses:

   | step | command |
   |---|---|
   | 1 | `API_SIGNATURE_RETRY` — drop the firmware's captured strokes |
   | 2 | `API_DISPLAY_SET_TARGET` → `1` (off-screen store) |
   | 3 | `API_DISPLAY_SET_IMAGE` — template + remaining strokes |
   | 4–5 | `API_DISPLAY_SET_TEXT_IN_RECT` ×2 — the two labels |
   | 6 | `API_DISPLAY_SET_TARGET` → `0` (live display) |
   | 7 | `API_DISPLAY_SET_IMAGE_FROM_STORE` → `1` — firmware-native blit |

## Tuning flags (top of the file)

| flag | default | meaning |
|---|---|---|
| `UNDO_SYNC_TO_PAD` | `true` | `false` = local-only Undo, no device commands |
| `UNDO_RETRY_FIRST` | `true` | flip to `false` to send `RETRY` *after* the repaint |
| `UNDO_STORE_ID` | `1` | image store used by the preparation sequence |
| `UNDO_TIMEOUT_MS` | `8000` | give up on a step if the pad does not answer |
| `PAD_PEN_WIDTH` | `3` | matches `DISPLAY_CONFIG_PEN`, so the repaint looks native |

## Logging

`logMessage()` used to overwrite `#log` on every message, so only the last
line ever survived — which is why the earlier crash could never be
diagnosed. It now **appends**, shortens the huge base64 payloads, mirrors
everything to the browser console, and every error branch prints its
`TOKEN_PARAM_RETURN_CODE` and `TOKEN_PARAM_ERROR_DESCRIPTION`.

Undo lines are prefixed `>> undo[state]`, `<< undo[state]`, `-- ` and `!! `.

## Other fixes carried over

- `padMode` is forced to `padModes.API` after `API_DEVICE_OPEN`; it was
  stuck on `Default`, so retry/confirm/cancel/image/sign_data all sent the
  wrong token.
- `signature_retry_send()` no longer emits malformed JSON.
- The final image comes straight from `sigCanvas.toDataURL()`, not from the
  pad's internal buffer — the pad's buffer would still contain undone
  strokes.
