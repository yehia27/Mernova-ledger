/*
 * signotec signature pad integration (Omega / Sigma / Gamma / Delta / Alpha)
 * ---------------------------------------------------------------------------
 * Talks to the local signotec WebSocket service using the JSON TOKEN_CMD_*
 * protocol, in API mode only.
 *
 * The pad draws three touch buttons on its own screen:
 *
 *   Cancel   -> abort signing
 *   Retry    -> UNDO THE LAST STROKE (originally: clear everything)
 *   Confirm  -> accept the signature
 *
 * Undo removes the last stroke from the local preview AND repaints the pad's
 * own screen so both stay in sync. See "Undo -> pad screen sync" below for why
 * the repaint is done through an image store rather than by writing to the
 * live display.
 *
 * The final image is taken from sigCanvas, never from the pad's internal
 * buffer: the pad's buffer would still contain strokes that were undone.
 */

/* global $ */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var wsUri = "wss://local.signotecwebsocket.de:49494";

// pad subset passed to TOKEN_CMD_API_DEVICE_SET_COM_PORT
var padConnectionType = "HID";

// index of the pad to use when several are connected
var padIndex = 0;

// pen width the pad itself draws with (TOKEN_CMD_API_DISPLAY_CONFIG_PEN)
var PAD_PEN_WIDTH = 3;

// pen width used for the on-screen preview
var PREVIEW_PEN_WIDTH = 5;

// labels drawn onto the pad during preparation, re-applied after an Undo
var PAD_FIELD_NAME_TEXT = "Signature 1";
var PAD_CUSTOM_TEXT = "Please sign!";

// --- Undo -> pad screen sync -----------------------------------------------
//
// Set to false for local-only Undo. The pad's own screen then keeps showing
// the undone stroke until Confirm, but the saved image is still correct
// because it is built from sigCanvas.
var UNDO_SYNC_TO_PAD = true;

// How the remaining strokes are put back on the pad screen.
//
//   "store" (default) - render into image store UNDO_STORE_ID, then blit it
//                       onto the display with SET_IMAGE_FROM_STORE. This is
//                       what the preparation sequence itself does, and the
//                       blit is what actually makes anything appear: writes
//                       to target 0 land in a back buffer that needs an
//                       explicit present.
//   "direct"          - SET_TARGET(0) then SET_IMAGE straight at the display.
//                       Fewer commands, but only works if the firmware
//                       presents display writes immediately.
//
// If the chosen mode fails, the other one is tried automatically; see
// UNDO_REPAINT_FALLBACK.
var UNDO_REPAINT_MODE = "store";

// On a failed repaint, retry once with the other UNDO_REPAINT_MODE. The log
// records which mode succeeded, so the default above can be set accordingly.
var UNDO_REPAINT_FALLBACK = true;

// Whether TOKEN_CMD_API_SIGNATURE_RETRY is sent at all.
//
//   "none" (default) - never sent. The repaint already overwrites the undone
//                      stroke, and this file never reads the firmware's own
//                      stroke buffer: the saved image comes from sigCanvas.
//                      RETRY also clears the pad screen itself, and that clear
//                      can land AFTER our repaint and wipe it, which shows up
//                      as "Retry erased everything".
//   "before"         - RETRY first, then repaint.
//   "after"          - repaint, then RETRY.
var UNDO_RETRY_MODE = "none";

// Image store the preparation sequence renders into and blits from.
// Only used when UNDO_REPAINT_MODE is "store".
var UNDO_STORE_ID = 1;

// Give up on a step if the pad does not answer within this long.
var UNDO_TIMEOUT_MS = 8000;

var PEN_COLOR_GREY = "#7F7F7F";
var PEN_COLOR_RED = "#FF0000";
var PEN_COLOR_GREEN = "#008000";
var PEN_COLOR_BLUE = "#0000FF";
var PEN_COLOR_BLACK = "#000000";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

var padTypes = {
    sigmaUSB: 1,
    sigmaSerial: 2,
    omegaUSB: 11,
    omegaSerial: 12,
    gammaUSB: 15,
    gammaSerial: 16,
    deltaUSB: 21,
    deltaSerial: 22,
    deltaIP: 23,
    alphaUSB: 31,
    alphaSerial: 32,
    alphaIP: 33
};

var deviceCapabilities = {
    HasColorDisplay: 0x00000001,
    HasBacklight: 0x00000002,
    SupportsVerticalScrolling: 0x00000004,
    SupportsHorizontalScrolling: 0x00000008,
    SupportsPenScrolling: 0x00000010,
    SupportsServiceMenu: 0x00000020,
    SupportsRSA: 0x00000040,
    SupportsContentSigning: 0x00000080,
    SupportsH2ContentSigning: 0x00000100,
    CanGenerateSignKey: 0x00000200,
    CanStoreSignKey: 0x00000400,
    CanStoreEncryptKey: 0x00000800,
    CanSignExternalHash: 0x00001000,
    SupportsRSAPassword: 0x00002000,
    SupportsSecureModePassword: 0x00004000,
    Supports4096BitKeys: 0x00008000,
    HasNFCReader: 0x00010000
};

var searchStates = {
    setPadType: 0,
    search: 1,
    getInfo: 2,
    getVersion: 3
};

var openStates = {
    openPad: 0,
    setColor: 1,
    getDisplayWidth: 2,
    getDisplayHeight: 3,
    getResolution: 4
};

var preparationStates = {
    setDisplayRotation: 0,
    getDisplayRotation: 1,
    setBackgroundTarget: 2,
    setBackgroundImage: 3,
    setCancelButton: 4,
    setRetryButton: 5,
    setConfirmButton: 6,
    setSignRect: 7,
    setFieldName: 8,
    setCustomText: 9,
    setForegroundTarget: 10,
    switchBuffers: 11,
    startSignature: 12
};

var padStates = {
    closed: 0,
    opened: 1
};

var undoStates = {
    idle: 0,
    retry: 1,
    setStoreTarget: 2,      // SET_TARGET -> the off-screen store
    setDisplayTarget: 3,    // SET_TARGET -> the live display
    setImage: 4,            // SET_IMAGE with the composite
    setFieldText: 5,
    setCustomText: 6,
    blitStore: 7            // SET_IMAGE_FROM_STORE, "store" mode only
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var signoPADAPIWeb = null;

var searchState = searchStates.setPadType;
var openState = openStates.openPad;
var preparationState = preparationStates.setDisplayRotation;
var padState = padStates.closed;

var padType = 0;
var supportsRSA = false;

// hot spot ids returned by TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT
var cancelButton = -1;
var retryButton = -1;
var confirmButton = -1;

// hot spot layout, computed while the buttons are added
var buttonDiff = 0;
var buttonLeft = 0;

// pristine per-model template (border / title / button graphics), base64 PNG
// without the "data:image/png;base64," prefix. Undo always composites onto
// this original, never onto a previous composite, so nothing accumulates.
var backgroundImage = null;
var backgroundImageWidth = 0;
var backgroundImageHeight = 0;

// Whether the pad has a colour display. Unknown counts as colour, so a pad
// that does not report its capabilities keeps the selected pen colour.
var hasColorDisplay = true;

// pad display <-> signature coordinate scaling
var scaleFactorX = 1.0;
var scaleFactorY = 1.0;

// One entry per stroke: { color, points: [{x, y}, ...] } in raw device
// coordinates. This is the source of truth for Undo and for every redraw.
var signatureStrokes = [];
var currentStroke = null;

// data URL of the last confirmed signature, also exposed as
// window.lastSignatureImage for the surrounding application.
var lastSignatureImage = null;

// Undo -> pad screen sync
var undoState = undoStates.idle;
var undoSequence = [];
var undoSequenceIndex = -1;
var undoCompositeImage = null;
var undoTimeoutId = null;
var undoResyncPending = false;
var undoActiveMode = null;
var undoTriedModes = [];

var statusElement = null;
var sigcanvas = null;

// ---------------------------------------------------------------------------
// Per-model geometry
// ---------------------------------------------------------------------------
//
// Single source of truth: the background image element id, the hot spot size,
// the signature rectangle, and the two text rectangles. Used by both the
// one-time preparation sequence and the Undo repaint, so the two can never
// drift apart.

function getPadProfile() {
    switch (padType) {
        case padTypes.sigmaUSB:
        case padTypes.sigmaSerial:
            return {
                imageId: "Sigma",
                buttonSize: 36,
                buttonTop: 2,
                signRectTop: 40,
                fieldNameRect: { left: 15, top: 43, width: 285, height: 18 },
                customTextRect: { left: 15, top: 110, width: 265, height: 18 }
            };

        case padTypes.omegaUSB:
        case padTypes.omegaSerial:
            return {
                imageId: "Omega",
                buttonSize: 48,
                buttonTop: 4,
                signRectTop: 56,
                fieldNameRect: { left: 40, top: 86, width: 570, height: 40 },
                customTextRect: { left: 40, top: 350, width: 520, height: 40 }
            };

        case padTypes.gammaUSB:
        case padTypes.gammaSerial:
            return {
                imageId: "Gamma",
                buttonSize: 48,
                buttonTop: 4,
                signRectTop: 56,
                fieldNameRect: { left: 40, top: 86, width: 720, height: 40 },
                customTextRect: { left: 40, top: 350, width: 670, height: 40 }
            };

        case padTypes.deltaUSB:
        case padTypes.deltaSerial:
        case padTypes.deltaIP:
            return {
                imageId: "Delta",
                buttonSize: 48,
                buttonTop: 4,
                signRectTop: 56,
                fieldNameRect: { left: 40, top: 86, width: 1200, height: 50 },
                customTextRect: { left: 40, top: 640, width: 670, height: 50 }
            };

        case padTypes.alphaUSB:
        case padTypes.alphaSerial:
        case padTypes.alphaIP:
            return {
                imageId: "Alpha",
                buttonSize: 80,
                buttonTop: 10,
                signRectTop: 100,
                fieldNameRect: { left: 20, top: 120, width: 730, height: 30 },
                customTextRect: { left: 20, top: 1316, width: 730, height: 30 }
            };

        default:
            return null;
    }
}

function getReadableType(type) {
    switch (type) {
        case padTypes.sigmaUSB: return "Sigma USB";
        case padTypes.sigmaSerial: return "Sigma serial";
        case padTypes.omegaUSB: return "Omega USB";
        case padTypes.omegaSerial: return "Omega serial";
        case padTypes.gammaUSB: return "Gamma USB";
        case padTypes.gammaSerial: return "Gamma serial";
        case padTypes.deltaUSB: return "Delta USB";
        case padTypes.deltaSerial: return "Delta serial";
        case padTypes.deltaIP: return "Delta IP";
        case padTypes.alphaUSB: return "Alpha USB";
        case padTypes.alphaSerial: return "Alpha serial";
        case padTypes.alphaIP: return "Alpha IP";
        default: return "Unknown (" + type + ")";
    }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
//
// Every lookup is guarded: this script runs against several pages and a
// missing optional element must never abort a signing session.

function byId(id) {
    try {
        return document.getElementById(id);
    } catch (e) {
        return null;
    }
}

function setStatus(text, className) {
    if (statusElement === null) {
        statusElement = byId("status");
    }
    if (statusElement === null) {
        return;
    }
    statusElement.innerHTML = text;
    statusElement.className = className;
}

function setText(id, text) {
    var el = byId(id);
    if (el !== null) {
        el.innerHTML = text;
    }
}

function getSelectedPenColor() {
    var select = byId("signaturePenColorSelect");
    var value = (select === null) ? "" : String(select.value).toUpperCase();

    switch (value) {
        case PEN_COLOR_GREY:
        case PEN_COLOR_RED:
        case PEN_COLOR_GREEN:
        case PEN_COLOR_BLUE:
        case PEN_COLOR_BLACK:
            return value;
        default:
            return PEN_COLOR_RED;
    }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
//
// Appends to <ul id="log"> and mirrors to the browser console. The previous
// version assigned to log.innerHTML on every message, so only the last line
// ever survived, which is why earlier failures could not be diagnosed.
//
// Line prefixes:  >> sent   << received   -- progress   !! error

var logLineCount = 0;

// Kept in memory as well as in #log, so signotecLog() works on a page that has
// no #log element and survives the list being cleared.
var logHistory = [];
var LOG_HISTORY_LIMIT = 2000;

function shortenForLog(msg) {
    try {
        // collapse the very large base64 image payloads
        return String(msg).replace(
            /("TOKEN_PARAM_(?:BITMAP|IMAGE|FILE)":")([^"]{80,})(")/g,
            function (match, head, body, tail) {
                return head + body.substring(0, 40) +
                    "...[" + body.length + " chars]..." + tail;
            });
    } catch (e) {
        return String(msg);
    }
}

function logMessage(msg) {
    var line = shortenForLog(msg);

    try {
        console.log("[signotec] " + line);
    } catch (e) { /* no console */ }

    logHistory.push(line);
    if (logHistory.length > LOG_HISTORY_LIMIT) {
        logHistory.shift();
    }

    try {
        var list = byId("log");
        if (list === null) {
            return;
        }
        logLineCount++;
        var item = document.createElement("li");
        item.textContent = "[" + logLineCount + "] " + line;
        list.appendChild(item);
        list.scrollTop = list.scrollHeight;
    } catch (e) { /* logging must never break signing */ }
}

/**
 * Reports a failed response with the exact return code and description, so a
 * failure is visible in #log instead of vanishing silently.
 */
function logResponseError(what, obj) {
    logMessage("!! " + what +
        " | TOKEN_CMD_ORIGIN=" + obj.TOKEN_CMD_ORIGIN +
        " | TOKEN_PARAM_RETURN_CODE=" + obj.TOKEN_PARAM_RETURN_CODE +
        " | TOKEN_PARAM_ERROR_DESCRIPTION=" + obj.TOKEN_PARAM_ERROR_DESCRIPTION);
}

// Messages queued while the socket is still connecting. Without this, a
// getSignature() that runs before the connection is established would throw
// InvalidStateError and the session would never start.
var pendingMessages = [];

function sendMessage(message) {
    if (signoPADAPIWeb === null) {
        logMessage("!! not connected to the signotec service, dropped: " + shortenForLog(message));
        return false;
    }

    // readyState is undefined on the ActiveX object, which is always ready
    var readyState = signoPADAPIWeb.readyState;

    if (readyState === 0 /* CONNECTING */) {
        logMessage("-- queued until the connection is open: " + shortenForLog(message));
        pendingMessages.push(message);
        return true;
    }

    if (readyState === 2 /* CLOSING */ || readyState === 3 /* CLOSED */) {
        logMessage("!! connection is closed, dropped: " + shortenForLog(message));
        return false;
    }

    logMessage(">> " + message);
    try {
        signoPADAPIWeb.send(message);
        return true;
    } catch (e) {
        logMessage("!! send failed: " + e);
        return false;
    }
}

function flushPendingMessages() {
    var queued = pendingMessages;
    pendingMessages = [];

    for (var i = 0; i < queued.length; i++) {
        logMessage(">> " + queued[i]);
        try {
            signoPADAPIWeb.send(queued[i]);
        } catch (e) {
            logMessage("!! send failed: " + e);
        }
    }
}

/**
 * Shared guard for every response handler: logs and closes the pad when the
 * pad reports a failure. Returns true when the caller should stop.
 */
function returnCode(obj) {
    return Number(obj.TOKEN_PARAM_RETURN_CODE);
}

function failed(obj, what) {
    if (returnCode(obj) >= 0) {
        return false;
    }
    logResponseError(what, obj);
    resetPipelineState();
    close_pad();
    return true;
}

function resetPipelineState() {
    searchState = searchStates.setPadType;
    openState = openStates.openPad;
    preparationState = preparationStates.setDisplayRotation;
}

// ---------------------------------------------------------------------------
// Page lifecycle
// ---------------------------------------------------------------------------

function onMainWindowLoad() {
    statusElement = byId("status");

    // #sigCanvas may live inside a dialog that is built later, so its absence
    // here is not fatal: getSignature() resolves it again when signing starts.
    sigcanvas = byId("sigCanvas");
    if (sigcanvas === null) {
        logMessage("-- sigCanvas not in the DOM yet, will look again on getSignature()");
    }

    connectToService();

    clearSignature();
    check_boxes_selectedElements_onchange();
}

/**
 * Opens the connection to the local signotec service. Safe to call more than
 * once: an existing connection is kept. Returns true when a connection object
 * exists afterwards.
 */
function connectToService() {
    if (signoPADAPIWeb !== null) {
        return true;
    }

    try {
        // legacy Internet Explorer path
        signoPADAPIWeb = new ActiveXObject("signotec.STPadActiveXServer");
        setStatus("ActiveX loaded", "success");
        logMessage("-- connected through the ActiveX server");
    } catch (activeXError) {
        try {
            signoPADAPIWeb = new WebSocket(wsUri);
            signoPADAPIWeb.onopen = onOpen;
            signoPADAPIWeb.onclose = onClose;
            signoPADAPIWeb.onerror = onError;
            logMessage("-- connecting to " + wsUri);
        } catch (socketError) {
            signoPADAPIWeb = null;
            setStatus("Could not connect to the signotec service", "fail");
            logMessage("!! could not open " + wsUri + ": " + socketError);
            return false;
        }
    }

    signoPADAPIWeb.onmessage = onMessage;
    return true;
}

/**
 * The whole log as one string, ready to copy out of the console:
 *
 *     copy(signotecLog())        // Chrome / Edge devtools
 *     console.log(signotecLog())
 */
function signotecLog() {
    return logHistory.join("\n");
}

/**
 * Dump of everything needed to diagnose a stalled session. Call
 * signotecDiagnostics() from the browser console.
 */
function signotecDiagnostics() {
    var socketState = "no connection object";
    if (signoPADAPIWeb !== null) {
        socketState = (signoPADAPIWeb.readyState === undefined)
            ? "ActiveX"
            : ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][signoPADAPIWeb.readyState];
    }

    var info = {
        wsUri: wsUri,
        connection: socketState,
        sigCanvasFound: byId("sigCanvas") !== null,
        logElementFound: byId("log") !== null,
        padState: (padState === padStates.opened) ? "opened" : "closed",
        padType: getReadableType(padType),
        padProfile: getPadProfile() === null ? "UNSUPPORTED" : getPadProfile().imageId,
        backgroundTemplate: backgroundImage === null ? "not loaded" : "loaded",
        searchState: searchState,
        openState: openState,
        preparationState: preparationState,
        undoState: undoSync_stateName(undoState),
        repaintMode: UNDO_REPAINT_MODE,
        retryMode: UNDO_RETRY_MODE,
        lastRepaintModeUsed: undoActiveMode,
        strokes: signatureStrokes.length,
        hotSpots: { cancel: cancelButton, retry: retryButton, confirm: confirmButton }
    };

    logMessage("-- diagnostics " + JSON.stringify(info));
    return info;
}

function onMainWindowBeforeUnload() {
    close_pad();
}

function connectionUrl(evt) {
    if (!evt || evt.target === undefined || evt.target.url === undefined) {
        return null;
    }
    return evt.target.url;
}

function onOpen(evt) {
    var url = connectionUrl(evt);
    setStatus(url === null ? "ActiveX loaded" : "Connected to " + url, "success");
    logMessage("-- connection open");

    flushPendingMessages();
}

function onClose(evt) {
    var url = connectionUrl(evt);
    setStatus(url === null ? "ActiveX unloaded" : "Disconnected from " + url, "fail");
    logMessage("!! connection closed");

    pendingMessages = [];
    padState = padStates.closed;
    resetPipelineState();
    undoResyncPending = false;
    undoSync_finish();
}

function onError(evt) {
    var url = connectionUrl(evt);
    setStatus(url === null ? "Communication error" : "Communication error " + url, "fail");
}

// ---------------------------------------------------------------------------
// Signature capture: drawing
// ---------------------------------------------------------------------------

/**
 * Draws one stroke as a single path. Called for the preview redraw and for
 * the composite pushed back to the pad.
 */
function drawStroke(ctx, stroke, penWidth, colorOverride) {
    var points = stroke.points;
    if (!points || points.length === 0) {
        return;
    }

    var color = colorOverride || stroke.color;

    ctx.lineWidth = penWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    var firstX = points[0].x * scaleFactorX;
    var firstY = points[0].y * scaleFactorY;

    if (points.length === 1) {
        // a tap: render the single point as a dot
        ctx.beginPath();
        ctx.arc(firstX, firstY, penWidth / 2, 0, 2 * Math.PI, true);
        ctx.fill();
        return;
    }

    ctx.beginPath();
    ctx.moveTo(firstX, firstY);
    for (var i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * scaleFactorX, points[i].y * scaleFactorY);
    }
    ctx.stroke();
}

function drawStrokes(ctx, penWidth, colorOverride) {
    for (var i = 0; i < signatureStrokes.length; i++) {
        drawStroke(ctx, signatureStrokes[i], penWidth, colorOverride);
    }
}

/**
 * Draws the segment that was just added to the current stroke. Each segment
 * gets its own path, so cost stays constant per point instead of growing with
 * the length of the stroke.
 */
function drawLastSegment(ctx, stroke) {
    var points = stroke.points;

    ctx.lineWidth = PREVIEW_PEN_WIDTH;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;

    if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0].x * scaleFactorX, points[0].y * scaleFactorY,
                PREVIEW_PEN_WIDTH / 2, 0, 2 * Math.PI, true);
        ctx.fill();
        return;
    }

    var from = points[points.length - 2];
    var to = points[points.length - 1];

    ctx.beginPath();
    ctx.moveTo(from.x * scaleFactorX, from.y * scaleFactorY);
    ctx.lineTo(to.x * scaleFactorX, to.y * scaleFactorY);
    ctx.stroke();
}

function clearCanvas() {
    if (sigcanvas === null) {
        return;
    }
    var ctx = sigcanvas.getContext("2d");
    ctx.clearRect(0, 0, sigcanvas.width, sigcanvas.height);
}

function redrawSignatureCanvas() {
    if (sigcanvas === null) {
        return;
    }
    clearCanvas();
    drawStrokes(sigcanvas.getContext("2d"), PREVIEW_PEN_WIDTH);
}

function resetSignature() {
    signatureStrokes = [];
    currentStroke = null;
    clearCanvas();
}

// TOKEN_CMD_SIGNATURE_POINT: one pen sample from the pad.
//
// A pressure of 0 marks the first point of a new stroke. The pad sends these
// values as JSON strings, so they MUST be coerced before comparing: a strict
// p === 0 never matches "0", every sample then lands in one single stroke,
// the preview draws a connecting line between what should be separate
// strokes, and Undo removes that one stroke, which is the whole signature.
function signature_point_send(x, y, p) {
    if (sigcanvas === null) {
        return;
    }

    var pressure = Number(p);

    if (pressure === 0 || currentStroke === null) {
        currentStroke = { color: getSelectedPenColor(), points: [] };
        signatureStrokes.push(currentStroke);
        logMessage("-- stroke " + signatureStrokes.length + " started");
    }

    currentStroke.points.push({ x: Number(x), y: Number(y) });
    drawLastSegment(sigcanvas.getContext("2d"), currentStroke);
}

// ---------------------------------------------------------------------------
// Undo the last stroke (bound to the pad's Retry hot spot)
// ---------------------------------------------------------------------------
//
// Why the pad screen repaint is done this way:
//
// Two earlier attempts blanked the pad and closed the session. The cause was
// not the firmware refusing SET_IMAGE mid-session. The old onMessage()
// dispatched every response to every handler, so the repaint's SET_TARGET and
// SET_IMAGE responses also reached the preparation handler, whose SET_IMAGE
// branch unconditionally did:
//
//     preparationState = preparationStates.setCancelButton;
//     api_signature_start();
//
// which restarted the one-time preparation sequence in the middle of a live
// session. That cascade fails, and its failure branches call close_pad().
//
// Three things prevent it now:
//
//   1. handleResponse() routes each response to exactly one handler, and the
//      Undo state machine gets first refusal.
//   2. Nothing in the Undo path calls close_pad(). On error it abandons the
//      screen sync only; the session survives and the saved image stays
//      correct because it comes from sigCanvas.
//   3. SIGNATURE_RETRY is not sent at all by default (UNDO_RETRY_MODE).
//      RETRY clears the pad screen itself, and that clear can land after our
//      repaint and wipe it, which looks exactly like "Retry erased
//      everything". We never need it: the repaint already covers the undone
//      stroke, and this file never reads the firmware's stroke buffer, since
//      the saved image comes from sigCanvas.
//
// The repaint itself, with the default UNDO_REPAINT_MODE of "direct":
//
//        SET_TARGET      -> 0     live display
//        SET_IMAGE                template + remaining strokes
//        SET_TEXT_IN_RECT x2      the two labels
//
// Setting UNDO_REPAINT_MODE to "store" renders into image store 1 first and
// blits it with SET_IMAGE_FROM_STORE instead, the mechanism the preparation
// sequence uses. Use it if the firmware refuses SET_IMAGE on the live
// display.

function undo_last_stroke_send() {
    if (signatureStrokes.length === 0) {
        logMessage("-- undo ignored: no strokes");
        return;
    }

    signatureStrokes.pop();
    currentStroke = null;

    // The preview is fixed immediately and unconditionally. It is what
    // signature_image_from_canvas() saves on Confirm, so the produced file is
    // correct even if the pad screen sync below fails.
    redrawSignatureCanvas();
    logMessage("-- undo: " + signatureStrokes.length + " stroke(s) left");

    undoSync_start();
}

function undoSync_orderedStates(mode) {
    var sequence;

    if (mode === "store") {
        // render off-screen, then blit the finished store onto the display
        sequence = [
            undoStates.setStoreTarget,
            undoStates.setImage,
            undoStates.setFieldText,
            undoStates.setCustomText,
            undoStates.setDisplayTarget,
            undoStates.blitStore
        ];
    } else {
        // paint straight onto the live display
        sequence = [
            undoStates.setDisplayTarget,
            undoStates.setImage,
            undoStates.setFieldText,
            undoStates.setCustomText
        ];
    }

    if (UNDO_RETRY_MODE === "before") {
        sequence.unshift(undoStates.retry);
    } else if (UNDO_RETRY_MODE === "after") {
        sequence.push(undoStates.retry);
    }

    return sequence;
}

function undoSync_messageFor(state) {
    var profile = getPadProfile();

    switch (state) {
        case undoStates.retry:
            return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_RETRY" }';

        case undoStates.setStoreTarget:
            return displaySetTargetMessage(UNDO_STORE_ID);

        case undoStates.setImage:
            return displaySetImageMessage(undoCompositeImage);

        case undoStates.setFieldText:
            return profile === null ? null
                : displaySetTextMessage(profile.fieldNameRect, PAD_FIELD_NAME_TEXT);

        case undoStates.setCustomText:
            return profile === null ? null
                : displaySetTextMessage(profile.customTextRect, PAD_CUSTOM_TEXT);

        case undoStates.setDisplayTarget:
            return displaySetTargetMessage(0);

        case undoStates.blitStore:
            return displaySetImageFromStoreMessage(UNDO_STORE_ID);

        default:
            return null;
    }
}

function undoSync_expectedOrigin(state) {
    switch (state) {
        case undoStates.retry: return "TOKEN_CMD_API_SIGNATURE_RETRY";
        case undoStates.setStoreTarget: return "TOKEN_CMD_API_DISPLAY_SET_TARGET";
        case undoStates.setDisplayTarget: return "TOKEN_CMD_API_DISPLAY_SET_TARGET";
        case undoStates.setImage: return "TOKEN_CMD_API_DISPLAY_SET_IMAGE";
        case undoStates.setFieldText: return "TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT";
        case undoStates.setCustomText: return "TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT";
        case undoStates.blitStore: return "TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE";
        default: return null;
    }
}

function undoSync_stateName(state) {
    for (var key in undoStates) {
        if (undoStates.hasOwnProperty(key) && undoStates[key] === state) {
            return key;
        }
    }
    return "?" + state;
}

function undoSync_start() {
    if (!UNDO_SYNC_TO_PAD) {
        return;
    }
    if (padState !== padStates.opened) {
        logMessage("-- undo sync skipped: pad is not open");
        return;
    }
    if (backgroundImage === null) {
        logMessage("-- undo sync skipped: background template not loaded yet");
        return;
    }
    if (undoState !== undoStates.idle) {
        // Retry pressed again while a sync is in flight: run once more after.
        undoResyncPending = true;
        logMessage("-- undo sync busy, queued a re-sync");
        return;
    }

    buildCompositeImage(function (compositeBase64) {
        if (compositeBase64 === null) {
            return;
        }
        if (undoState !== undoStates.idle) {
            undoResyncPending = true;
            return;
        }

        undoCompositeImage = compositeBase64;
        undoTriedModes = [];
        undoSync_run(UNDO_REPAINT_MODE);
    });
}

/** Runs the repaint with one particular UNDO_REPAINT_MODE. */
function undoSync_run(mode) {
    undoActiveMode = mode;
    undoTriedModes.push(mode);

    undoSequence = undoSync_orderedStates(mode);
    undoSequenceIndex = -1;

    logMessage("-- undo sync start (repaint=" + mode +
        ", retry=" + UNDO_RETRY_MODE + ")");
    undoSync_advance();
}

/** The repaint mode that has not been tried yet, or null. */
function undoSync_otherMode() {
    var other = (undoActiveMode === "store") ? "direct" : "store";
    return (undoTriedModes.indexOf(other) === -1) ? other : null;
}

function undoSync_advance() {
    clearUndoTimeout();

    undoSequenceIndex++;
    if (undoSequenceIndex >= undoSequence.length) {
        logMessage("-- undo sync done with repaint mode '" + undoActiveMode +
            "': pad screen matches the preview");
        undoSync_finish();
        return;
    }

    undoState = undoSequence[undoSequenceIndex];

    var message = undoSync_messageFor(undoState);
    if (message === null) {
        undoSync_abort("no message for this step");
        return;
    }

    undoTimeoutId = setTimeout(function () {
        undoTimeoutId = null;
        undoSync_abort("timed out waiting for " + undoSync_expectedOrigin(undoState));
    }, UNDO_TIMEOUT_MS);

    logMessage("-- undo step " + undoSync_stateName(undoState));
    if (!sendMessage(message)) {
        undoSync_abort("send failed");
    }
}

/**
 * Consulted by handleResponse() before any other handler. Returns true when
 * the response belongs to the running Undo sequence, in which case no other
 * handler may see it.
 */
function undoSync_handleResponse(obj) {
    if (undoState === undoStates.idle) {
        return false;
    }
    if (obj.TOKEN_CMD_ORIGIN !== undoSync_expectedOrigin(undoState)) {
        return false;
    }

    if (returnCode(obj) < 0) {
        logResponseError("undo step " + undoSync_stateName(undoState) + " failed", obj);
        // Deliberately not close_pad(): keep signing alive and give up on the
        // screen repaint only.
        undoSync_failed();
        return true;
    }

    logMessage("-- undo step " + undoSync_stateName(undoState) + " ok");

    undoSync_advance();
    return true;
}

/** Ends the screen sync without touching the signing session. */
function undoSync_abort(reason) {
    logMessage("!! undo sync aborted at " + undoSync_stateName(undoState) + ": " + reason);
    undoSync_failed();
}

/**
 * A repaint step failed. Try the other repaint mode once before giving up,
 * so a firmware that refuses one route still gets its screen updated.
 */
function undoSync_failed() {
    clearUndoTimeout();

    var other = UNDO_REPAINT_FALLBACK ? undoSync_otherMode() : null;
    if (other !== null && padState === padStates.opened && undoCompositeImage !== null) {
        logMessage("-- repaint mode '" + undoActiveMode + "' failed, retrying with '" + other + "'");
        undoSync_run(other);
        return;
    }

    undoSync_finish();
}

function undoSync_finish() {
    clearUndoTimeout();

    undoState = undoStates.idle;
    undoSequence = [];
    undoSequenceIndex = -1;
    undoCompositeImage = null;
    undoActiveMode = null;
    undoTriedModes = [];

    if (undoResyncPending) {
        undoResyncPending = false;
        undoSync_start();
    }
}

function clearUndoTimeout() {
    if (undoTimeoutId !== null) {
        clearTimeout(undoTimeoutId);
        undoTimeoutId = null;
    }
}

/**
 * Renders the pristine template plus the remaining strokes at the pad's own
 * display resolution and hands back a base64 PNG without the data URL prefix,
 * ready to be sent as TOKEN_PARAM_BITMAP. Calls back with null on failure.
 */
function buildCompositeImage(callback) {
    var template = new Image();

    template.onload = function () {
        try {
            var offscreen = document.createElement("canvas");
            offscreen.width = sigcanvas.width;
            offscreen.height = sigcanvas.height;

            var ctx = offscreen.getContext("2d");

            // Drawn at 0,0 at its own size, exactly like the
            // TOKEN_PARAM_X_POS/Y_POS 0,0 SET_IMAGE the preparation sequence
            // sends. Scaling it here instead would shift the border and the
            // button graphics relative to what the pad is already showing.
            ctx.drawImage(template, 0, 0);

            if (template.width !== offscreen.width || template.height !== offscreen.height) {
                logMessage("!! template is " + template.width + "x" + template.height +
                    " but the display is " + offscreen.width + "x" + offscreen.height);
            }

            // PAD_PEN_WIDTH so the repainted strokes match the width the
            // firmware itself drew with (TOKEN_CMD_API_DISPLAY_CONFIG_PEN).
            // On a monochrome pad the firmware drew in black, so the repaint
            // uses black too instead of the preview's pen colour.
            drawStrokes(ctx, PAD_PEN_WIDTH, hasColorDisplay ? null : "#000000");

            var dataURL = offscreen.toDataURL("image/png");
            callback(stripDataUrlPrefix(dataURL));
        } catch (e) {
            logMessage("!! composite image failed: " + e);
            callback(null);
        }
    };

    template.onerror = function () {
        logMessage("!! composite image failed: background template did not load");
        callback(null);
    };

    template.src = "data:image/png;base64," + backgroundImage;
}

function stripDataUrlPrefix(dataURL) {
    return String(dataURL).replace(/^data:image\/[a-z]+;base64,/, "");
}

// ---------------------------------------------------------------------------
// Display command builders, shared by preparation and Undo
// ---------------------------------------------------------------------------

function displaySetTargetMessage(target) {
    return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TARGET"' +
        ', "TOKEN_PARAM_TARGET":"' + target + '" }';
}

function displaySetImageMessage(base64Png) {
    return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_IMAGE"' +
        ', "TOKEN_PARAM_X_POS":"0", "TOKEN_PARAM_Y_POS":"0"' +
        ', "TOKEN_PARAM_BITMAP":"' + base64Png + '" }';
}

function displaySetImageFromStoreMessage(storeId) {
    return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE"' +
        ', "TOKEN_PARAM_STORE_ID":"' + storeId + '" }';
}

function displaySetTextMessage(rect, text) {
    return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT"' +
        ', "TOKEN_PARAM_LEFT":"' + rect.left +
        '", "TOKEN_PARAM_TOP":"' + rect.top +
        '", "TOKEN_PARAM_WIDTH":"' + rect.width +
        '", "TOKEN_PARAM_HEIGHT":"' + rect.height +
        '", "TOKEN_PARAM_ALIGNMENT":"3", "TOKEN_PARAM_TEXT":"' + text +
        '", "TOKEN_PARAM_OPTIONS":"0" }';
}

// ---------------------------------------------------------------------------
// Step 1: search for pads
// ---------------------------------------------------------------------------

function getSignature() {
    if (statusElement === null) {
        statusElement = byId("status");
    }

    // resolve the canvas again: it may have been added to the DOM after load
    sigcanvas = byId("sigCanvas");
    if (sigcanvas === null) {
        setStatus("sigCanvas element not found", "fail");
        logMessage("!! sigCanvas element not found, cannot capture a signature");
        return;
    }

    // connect on demand, in case onMainWindowLoad() never ran
    if (!connectToService()) {
        return;
    }

    resetSignature();
    resetPipelineState();

    logMessage("-- searching for pads (" + padConnectionType + ")");
    api_search_for_pads();
}

function api_search_for_pads() {
    var message;

    switch (searchState) {
        case searchStates.setPadType:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_SET_COM_PORT"' +
                ', "TOKEN_PARAM_PORT_LIST":"' + padConnectionType + '" }';
            break;

        case searchStates.search:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_GET_COUNT" }';
            break;

        case searchStates.getInfo:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_GET_INFO"' +
                ', "TOKEN_PARAM_INDEX":"' + padIndex + '" }';
            break;

        case searchStates.getVersion:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_GET_VERSION"' +
                ', "TOKEN_PARAM_INDEX":"' + padIndex + '" }';
            break;

        default:
            logMessage("!! invalid searchState " + searchState);
            resetPipelineState();
            return;
    }

    sendMessage(message);
}

function onSetComPortResponse(obj) {
    if (failed(obj, "failed to set the pad type")) {
        return;
    }
    searchState = searchStates.search;
    api_search_for_pads();
}

function onGetCountResponse(obj) {
    if (failed(obj, "the search for pads failed")) {
        return;
    }
    if (returnCode(obj) === 0) {
        logMessage("!! no connected pads have been found");
        resetPipelineState();
        return;
    }

    searchState = searchStates.getInfo;
    api_search_for_pads();
}

function onGetInfoResponse(obj) {
    if (failed(obj, "failed to get the device info")) {
        return;
    }

    padType = parseInt(obj.TOKEN_PARAM_TYPE, 10);
    logMessage("-- pad type " + getReadableType(padType) +
        ", serial " + obj.TOKEN_PARAM_SERIAL);

    var profile = getPadProfile();
    if (profile === null) {
        logMessage("!! unsupported pad type: TOKEN_PARAM_TYPE=" + obj.TOKEN_PARAM_TYPE +
            " (parsed as " + padType + "). Add it to getPadProfile() to support it.");
        resetPipelineState();
        close_pad();
        return;
    }

    var capabilities = Number(obj.TOKEN_PARAM_CAPABILITIES);
    if (isNaN(capabilities)) {
        // the pad did not report them; assume the more permissive defaults
        supportsRSA = false;
        hasColorDisplay = true;
    } else {
        supportsRSA = (capabilities & deviceCapabilities.SupportsRSA) !== 0;
        hasColorDisplay = (capabilities & deviceCapabilities.HasColorDisplay) !== 0;
        logMessage("-- display is " + (hasColorDisplay ? "colour" : "monochrome"));
    }
    setText("RSASupport_0", supportsRSA ? "Yes" : "No");
    setText("PadType_0", getReadableType(padType));
    setText("SerialNumber_0", obj.TOKEN_PARAM_SERIAL);

    loadBackgroundImage(profile.imageId);

    searchState = searchStates.getVersion;
    api_search_for_pads();
}

function onGetVersionResponse(obj) {
    if (failed(obj, "failed to get the device version")) {
        return;
    }

    setText("FirmwareVersion_0", obj.TOKEN_PARAM_VERSION);
    searchState = searchStates.setPadType;

    api_device_open();
}

/**
 * Caches the per-model template PNG (border, title, button graphics) as
 * base64. Undo always composites onto this pristine copy, so repeated undos
 * never accumulate or double-draw anything.
 */
function loadBackgroundImage(imageId) {
    var element = byId(imageId);
    if (element === null) {
        logMessage("!! background image element '" + imageId + "' not found");
        return;
    }

    var img = new Image();
    img.setAttribute("crossOrigin", "anonymous");

    img.onload = function () {
        try {
            var canvas = document.createElement("canvas");
            canvas.width = this.width;
            canvas.height = this.height;
            canvas.getContext("2d").drawImage(this, 0, 0);

            backgroundImage = stripDataUrlPrefix(canvas.toDataURL("image/png"));
            backgroundImageWidth = canvas.width;
            backgroundImageHeight = canvas.height;

            logMessage("-- background template '" + imageId + "' loaded (" +
                canvas.width + "x" + canvas.height + ")");
        } catch (e) {
            logMessage("!! background template '" + imageId + "' failed: " + e);
        }
    };

    img.onerror = function () {
        logMessage("!! background template '" + imageId + "' failed to load");
    };

    img.src = element.src;
}

// ---------------------------------------------------------------------------
// Step 2: open the pad and read its geometry
// ---------------------------------------------------------------------------

function api_device_open() {
    var message;

    switch (openState) {
        case openStates.openPad:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_OPEN"' +
                ', "TOKEN_PARAM_INDEX":"' + padIndex + '", "TOKEN_PARAM_ERASE_DISPLAY":"FALSE" }';
            break;

        case openStates.setColor:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_CONFIG_PEN"' +
                ', "TOKEN_PARAM_WIDTH":"' + PAD_PEN_WIDTH +
                '", "TOKEN_PARAM_PEN_COLOR":"' + getSelectedPenColor() + '" }';
            break;

        case openStates.getDisplayWidth:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_GET_WIDTH" }';
            break;

        case openStates.getDisplayHeight:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_GET_HEIGHT" }';
            break;

        case openStates.getResolution:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_GET_RESOLUTION" }';
            break;

        default:
            logMessage("!! invalid openState " + openState);
            resetPipelineState();
            return;
    }

    sendMessage(message);
}

function onDeviceOpenResponse(obj) {
    if (returnCode(obj) < 0) {
        // The pad is not open, so close_pad() would be wrong here.
        logResponseError("failed to open the pad", obj);
        resetPipelineState();
        return;
    }

    padState = padStates.opened;

    openState = openStates.setColor;
    api_device_open();
}

function onConfigPenResponse(obj) {
    if (failed(obj, "failed to configure the pen")) {
        return;
    }
    openState = openStates.getDisplayWidth;
    api_device_open();
}

function onGetDisplayWidthResponse(obj) {
    if (failed(obj, "failed to get the display width")) {
        return;
    }
    sigcanvas.width = returnCode(obj);

    openState = openStates.getDisplayHeight;
    api_device_open();
}

function onGetDisplayHeightResponse(obj) {
    if (failed(obj, "failed to get the display height")) {
        return;
    }
    sigcanvas.height = returnCode(obj);

    openState = openStates.getResolution;
    api_device_open();
}

function onGetResolutionResponse(obj) {
    if (failed(obj, "failed to get the signature resolution")) {
        return;
    }

    // signature coordinates -> display pixels
    scaleFactorX = sigcanvas.width / Number(obj.TOKEN_PARAM_PAD_X_RESOLUTION);
    scaleFactorY = sigcanvas.height / Number(obj.TOKEN_PARAM_PAD_Y_RESOLUTION);

    openState = openStates.openPad;
    api_signature_start();
}

// ---------------------------------------------------------------------------
// Step 3: prepare the pad screen and start capture
// ---------------------------------------------------------------------------
//
// Everything up to setForegroundTarget is rendered into image store 1, which
// switchBuffers then blits onto the live display. Running this sequence again
// mid-session is not safe: it is what the Undo path must never trigger.

function api_signature_start() {
    var profile = getPadProfile();
    if (profile === null) {
        logMessage("!! unsupported pad type " + padType);
        resetPipelineState();
        close_pad();
        return;
    }

    var message;

    switch (preparationState) {
        case preparationStates.setDisplayRotation:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_ROTATION"' +
                ', "TOKEN_PARAM_ROTATION":"0" }';
            break;

        case preparationStates.getDisplayRotation:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_GET_ROTATION" }';
            break;

        case preparationStates.setBackgroundTarget:
            message = displaySetTargetMessage(UNDO_STORE_ID);
            break;

        case preparationStates.setBackgroundImage:
            if (backgroundImage === null) {
                logMessage("!! background template is not loaded yet");
                resetPipelineState();
                close_pad();
                return;
            }
            message = displaySetImageMessage(backgroundImage);
            break;

        case preparationStates.setCancelButton:
            buttonDiff = sigcanvas.width / 3;
            buttonLeft = (buttonDiff - profile.buttonSize) / 2;
            message = addHotSpotMessage(buttonLeft, profile);
            break;

        case preparationStates.setRetryButton:
        case preparationStates.setConfirmButton:
            buttonLeft = buttonLeft + buttonDiff;
            message = addHotSpotMessage(buttonLeft, profile);
            break;

        case preparationStates.setSignRect:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SENSOR_SET_SIGN_RECT"' +
                ', "TOKEN_PARAM_LEFT":"0", "TOKEN_PARAM_TOP":"' + profile.signRectTop +
                '", "TOKEN_PARAM_WIDTH":"0", "TOKEN_PARAM_HEIGHT":"0" }';
            break;

        case preparationStates.setFieldName:
            message = displaySetTextMessage(profile.fieldNameRect, PAD_FIELD_NAME_TEXT);
            break;

        case preparationStates.setCustomText:
            message = displaySetTextMessage(profile.customTextRect, PAD_CUSTOM_TEXT);
            break;

        case preparationStates.setForegroundTarget:
            message = displaySetTargetMessage(0);
            break;

        case preparationStates.switchBuffers:
            message = displaySetImageFromStoreMessage(UNDO_STORE_ID);
            break;

        case preparationStates.startSignature:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_START" }';
            break;

        default:
            logMessage("!! invalid preparationState " + preparationState);
            resetPipelineState();
            return;
    }

    sendMessage(message);
}

function addHotSpotMessage(left, profile) {
    return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT"' +
        ', "TOKEN_PARAM_LEFT":"' + Math.round(left) +
        '", "TOKEN_PARAM_TOP":"' + profile.buttonTop +
        '", "TOKEN_PARAM_WIDTH":"' + profile.buttonSize +
        '", "TOKEN_PARAM_HEIGHT":"' + profile.buttonSize + '" }';
}

function onSetRotationResponse(obj) {
    if (failed(obj, "failed to set the display rotation")) {
        return;
    }
    preparationState = preparationStates.getDisplayRotation;
    api_signature_start();
}

function onGetRotationResponse(obj) {
    if (failed(obj, "failed to get the display rotation")) {
        return;
    }
    preparationState = preparationStates.setBackgroundTarget;
    api_signature_start();
}

function onSetTargetResponse(obj) {
    if (failed(obj, "failed to set the display target")) {
        return;
    }

    switch (preparationState) {
        case preparationStates.setBackgroundTarget:
            preparationState = preparationStates.setBackgroundImage;
            break;

        case preparationStates.setForegroundTarget:
            preparationState = preparationStates.switchBuffers;
            break;

        default:
            logMessage("!! unexpected SET_TARGET response in state " + preparationState);
            return;
    }

    api_signature_start();
}

function onSetImageResponse(obj) {
    if (failed(obj, "failed to set the background image")) {
        return;
    }
    if (preparationState !== preparationStates.setBackgroundImage) {
        logMessage("!! unexpected SET_IMAGE response in state " + preparationState);
        return;
    }

    preparationState = preparationStates.setCancelButton;
    api_signature_start();
}

function onAddHotSpotResponse(obj) {
    if (failed(obj, "failed to add a hot spot")) {
        return;
    }

    var id = Number(obj.TOKEN_PARAM_RETURN_CODE);

    switch (preparationState) {
        case preparationStates.setCancelButton:
            cancelButton = id;
            preparationState = preparationStates.setRetryButton;
            break;

        case preparationStates.setRetryButton:
            retryButton = id;
            preparationState = preparationStates.setConfirmButton;
            break;

        case preparationStates.setConfirmButton:
            confirmButton = id;
            preparationState = preparationStates.setSignRect;
            break;

        default:
            logMessage("!! unexpected ADD_HOT_SPOT response in state " + preparationState);
            return;
    }

    api_signature_start();
}

function onSetSignRectResponse(obj) {
    if (failed(obj, "failed to set the signature rectangle")) {
        return;
    }
    preparationState = preparationStates.setFieldName;
    api_signature_start();
}

function onSetTextInRectResponse(obj) {
    if (failed(obj, "failed to set a text")) {
        return;
    }

    switch (preparationState) {
        case preparationStates.setFieldName:
            preparationState = preparationStates.setCustomText;
            break;

        case preparationStates.setCustomText:
            preparationState = preparationStates.setForegroundTarget;
            break;

        default:
            logMessage("!! unexpected SET_TEXT_IN_RECT response in state " + preparationState);
            return;
    }

    api_signature_start();
}

function onSetImageFromStoreResponse(obj) {
    if (failed(obj, "failed to blit the image store")) {
        return;
    }
    preparationState = preparationStates.startSignature;
    api_signature_start();
}

function onSignatureStartResponse(obj) {
    if (failed(obj, "failed to start the signing process")) {
        return;
    }

    preparationState = preparationStates.setDisplayRotation;
    logMessage("-- ready for signing");
}

// ---------------------------------------------------------------------------
// Pad buttons
// ---------------------------------------------------------------------------

function api_sensor_hot_spot_pressed_send(rawButton) {
    // ids come back as JSON strings; a switch compares strictly
    var button = Number(rawButton);

    switch (button) {
        case cancelButton:
            signature_cancel_send();
            break;

        // was a full clear, now removes the last stroke only
        case retryButton:
            undo_last_stroke_send();
            break;

        case confirmButton:
            signature_confirm_send();
            break;

        default:
            logMessage("!! unknown hot spot id " + button +
                " (cancel=" + cancelButton + ", retry=" + retryButton +
                ", confirm=" + confirmButton + ")");
    }
}

// --- Confirm ---------------------------------------------------------------

function signature_confirm_send() {
    sendMessage('{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_CONFIRM" }');
}

function onConfirmResponse(obj) {
    if (failed(obj, "failed to confirm the signature")) {
        return;
    }
    signature_image_from_canvas();
}

/**
 * Produces the final PNG from sigCanvas.
 *
 * Not from TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX or
 * TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA: both read the pad's own internal
 * buffer, which still contains any stroke that was undone. This system has no
 * legal or biometric use for SignData, so the canvas is the correct source.
 */
function signature_image_from_canvas() {
    lastSignatureImage = (sigcanvas === null) ? null : sigcanvas.toDataURL("image/png");

    if (typeof window !== "undefined") {
        window.lastSignatureImage = lastSignatureImage;
    }

    // hand the image to the surrounding application
    var target = byId("SignatureImageData");
    if (target !== null) {
        target.value = lastSignatureImage;
    }

    logMessage("-- signature confirmed with " + signatureStrokes.length + " stroke(s)");

    clickIfPresent("#signDoc1");
    clickIfPresent("#fa-close2");

    close_pad();
}

// --- Cancel ----------------------------------------------------------------

function signature_cancel_send() {
    hideOverlay();
    sendMessage('{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_CANCEL"' +
        ', "TOKEN_PARAM_ERASE":"0" }');
}

function onCancelResponse(obj) {
    if (failed(obj, "failed to cancel the signing process")) {
        return;
    }
    resetSignature();
    close_pad();
}

// --- jQuery helpers, guarded so a missing element never breaks signing -----

function clickIfPresent(selector) {
    try {
        if (typeof $ === "function") {
            $(selector).click();
        }
    } catch (e) {
        logMessage("!! click on " + selector + " failed: " + e);
    }
}

function hideOverlay() {
    try {
        if (typeof $ === "function") {
            $(".Main_overlay").fadeOut("slow");
        }
    } catch (e) { /* the overlay is optional */ }
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

function close_pad() {
    // drop any queued re-sync first, so undoSync_finish() cannot start a new
    // repaint while the pad is on its way out
    undoResyncPending = false;
    undoSync_finish();

    if (padState !== padStates.opened) {
        return;
    }

    sendMessage('{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_CLOSE"' +
        ', "TOKEN_PARAM_INDEX":"' + padIndex + '" }');
}

function onDeviceCloseResponse(obj) {
    resetPipelineState();

    if (returnCode(obj) < 0) {
        logResponseError("failed to close the pad", obj);
    }

    padState = padStates.closed;
}

// ---------------------------------------------------------------------------
// Events pushed by the pad
// ---------------------------------------------------------------------------

function disconnect_send(index) {
    logMessage("!! the pad (index " + index + ") has been disconnected");

    resetPipelineState();
    undoResyncPending = false;
    undoSync_finish();
    padState = padStates.closed;
}

function error_send(context, returnCode, description) {
    logMessage("!! pad error | context=" + context +
        " | TOKEN_PARAM_RETURN_CODE=" + returnCode +
        " | TOKEN_PARAM_ERROR_DESCRIPTION=" + description);
}

function api_display_scroll_pos_changed_send(xPos, yPos) {
    logMessage("-- scroll position " + xPos + "," + yPos);
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------
//
// Each response goes to exactly one handler. The old code ran every handler
// for every response, which is how the Undo repaint's replies ended up
// restarting the preparation sequence and closing the pad.

var responseHandlers = {
    TOKEN_CMD_API_DEVICE_SET_COM_PORT: onSetComPortResponse,
    TOKEN_CMD_API_DEVICE_GET_COUNT: onGetCountResponse,
    TOKEN_CMD_API_DEVICE_GET_INFO: onGetInfoResponse,
    TOKEN_CMD_API_DEVICE_GET_VERSION: onGetVersionResponse,

    TOKEN_CMD_API_DEVICE_OPEN: onDeviceOpenResponse,
    TOKEN_CMD_API_DISPLAY_CONFIG_PEN: onConfigPenResponse,
    TOKEN_CMD_API_DISPLAY_GET_WIDTH: onGetDisplayWidthResponse,
    TOKEN_CMD_API_DISPLAY_GET_HEIGHT: onGetDisplayHeightResponse,
    TOKEN_CMD_API_SIGNATURE_GET_RESOLUTION: onGetResolutionResponse,

    TOKEN_CMD_API_DISPLAY_SET_ROTATION: onSetRotationResponse,
    TOKEN_CMD_API_DISPLAY_GET_ROTATION: onGetRotationResponse,
    TOKEN_CMD_API_DISPLAY_SET_TARGET: onSetTargetResponse,
    TOKEN_CMD_API_DISPLAY_SET_IMAGE: onSetImageResponse,
    TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT: onAddHotSpotResponse,
    TOKEN_CMD_API_SENSOR_SET_SIGN_RECT: onSetSignRectResponse,
    TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT: onSetTextInRectResponse,
    TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE: onSetImageFromStoreResponse,
    TOKEN_CMD_API_SIGNATURE_START: onSignatureStartResponse,

    TOKEN_CMD_API_SIGNATURE_CONFIRM: onConfirmResponse,
    TOKEN_CMD_API_SIGNATURE_CANCEL: onCancelResponse,
    TOKEN_CMD_API_DEVICE_CLOSE: onDeviceCloseResponse
};

function onMessage(event) {
    logMessage("<< " + event.data);

    var obj;
    try {
        obj = JSON.parse(event.data);
    } catch (e) {
        logMessage("!! could not parse the message: " + e);
        return;
    }

    if (obj.TOKEN_TYPE === "TOKEN_TYPE_SEND") {
        handleSendEvent(obj);
    } else if (obj.TOKEN_TYPE === "TOKEN_TYPE_RESPONSE") {
        handleResponse(obj);
    } else {
        logMessage("!! unknown TOKEN_TYPE " + obj.TOKEN_TYPE);
    }
}

function handleResponse(obj) {
    // The Undo state machine gets first refusal, so its own SET_TARGET /
    // SET_IMAGE / SET_TEXT_IN_RECT replies never reach the preparation
    // handlers above.
    if (undoSync_handleResponse(obj)) {
        return;
    }

    var handler = responseHandlers[obj.TOKEN_CMD_ORIGIN];
    if (handler === undefined) {
        logMessage("!! unhandled response " + obj.TOKEN_CMD_ORIGIN);
        return;
    }

    handler(obj);
}

function handleSendEvent(obj) {
    switch (obj.TOKEN_CMD) {
        case "TOKEN_CMD_SIGNATURE_POINT":
            signature_point_send(obj.TOKEN_PARAM_POINT.x,
                                 obj.TOKEN_PARAM_POINT.y,
                                 obj.TOKEN_PARAM_POINT.p);
            break;

        case "TOKEN_CMD_API_SENSOR_HOT_SPOT_PRESSED":
            api_sensor_hot_spot_pressed_send(obj.TOKEN_PARAM_HOTSPOT_ID);
            break;

        case "TOKEN_CMD_API_DISPLAY_SCROLL_POS_CHANGED":
            api_display_scroll_pos_changed_send(obj.TOKEN_PARAM_X_POS, obj.TOKEN_PARAM_Y_POS);
            break;

        case "TOKEN_CMD_DISCONNECT":
            disconnect_send(obj.TOKEN_PARAM_PAD_INDEX);
            break;

        case "TOKEN_CMD_ERROR":
            error_send(obj.TOKEN_PARAM_ERROR_CONTEXT,
                       obj.TOKEN_PARAM_RETURN_CODE,
                       obj.TOKEN_PARAM_ERROR_DESCRIPTION);
            break;

        // Sent by the pad's own dialog buttons rather than our hot spots.
        // They should not occur in API mode; mapped anyway so a firmware that
        // does send them still behaves correctly.
        case "TOKEN_CMD_SIGNATURE_CONFIRM":
            signature_confirm_send();
            break;

        case "TOKEN_CMD_SIGNATURE_RETRY":
            undo_last_stroke_send();
            break;

        case "TOKEN_CMD_SIGNATURE_CANCEL":
            signature_cancel_send();
            break;

        default:
            logMessage("!! unknown send event " + obj.TOKEN_CMD);
    }
}

// ---------------------------------------------------------------------------
// Compatibility with the surrounding page
// ---------------------------------------------------------------------------
//
// This file no longer implements the pad's Default mode: the whole pipeline
// runs through the API commands, the mode selector is gone, and the Default
// mode selection dialog is unused. The entry points below are kept because
// the HTML may still reference them from inline handlers, and an undefined
// function there would raise a script error.

function clearSignature() {
    resetSignature();
}

/** Selection dialog fields; Default mode only, so nothing is shown. */
function check_boxes_selectedElements_onchange() {
    var select = byId("check_boxes_selectedElements");
    if (select === null) {
        return;
    }

    var prefixes = ["fieldNumber", "fieldID", "fieldText", "fieldChecked", "fieldRequired"];
    var count = select.childElementCount;

    for (var i = 1; i < count; i++) {
        for (var p = 0; p < prefixes.length; p++) {
            var el = byId(prefixes[p] + i);
            if (el !== null) {
                el.style.visibility = "hidden";
            }
        }
    }
}

/** The pad always runs in API mode now; kept as a no-op for inline handlers. */
function ModeListName_onchange() {
    var penColorSelect = byId("signaturePenColorSelect");
    if (penColorSelect !== null) {
        penColorSelect.disabled = false;
    }
}

// Elements the page starts with hidden.
(function hideOptionalElements() {
    try {
        if (typeof $ !== "function") {
            return;
        }
        $("#verify").hide();
        $("#certificateName").hide();
        $("#barCode").hide();
        $("#signNow").hide();
    } catch (e) { /* these elements are optional */ }
}());
