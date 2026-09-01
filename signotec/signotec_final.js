$("#verify").hide();
$("#certificateName").hide();
$("#barCode").hide();
$("#signNow").hide();

var signoPADAPIWeb = null;

var searchStates = {
    setPadType: 0,
    search: 1,
    getInfo: 2,
    getVersion: 3
};
var searchState = searchStates.setPadType;

var openStates = {
    openPad: 0,
    setColor: 1,
    getDisplayWidth: 2,
    getDisplayHeight: 3,
    getResolution: 4
};
var openState = openStates.openPad;

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
var preparationState = preparationStates.setDisplayRotation;

var padStates = {
    closed: 0,
    opened: 1
};
var padState = padStates.closed;

var padModes = {
    Default: 0,
    API: 1
};
var padMode = padModes.Default;

// ---------------------------------------------------------------------
// Undo-to-pad synchronisation
// ---------------------------------------------------------------------
// Why the previous two attempts blanked the screen and closed the session:
//
// onMessage() dispatches EVERY response to EVERY handler (see the big
// fall-through switch at the bottom of this file). So the
// TOKEN_CMD_API_DISPLAY_SET_TARGET / TOKEN_CMD_API_DISPLAY_SET_IMAGE
// responses that belonged to the Undo redraw were ALSO delivered to
// api_signature_start_responses(). Its generic SET_IMAGE branch does,
// unconditionally:
//
//     preparationState = preparationStates.setCancelButton;
//     api_signature_start();
//
// i.e. it re-enters the one-time pad PREPARATION sequence in the middle of
// a live session -- re-adding hot spots, re-setting the sign rect, and
// finally calling SIGNATURE_START again. That cascade fails and every
// failure branch in there calls close_pad(). Blank screen, then the
// session closes. Exactly the observed symptom, and nothing to do with
// the firmware rejecting SET_IMAGE.
//
// Two fixes, both applied below:
//   1. onMessage() now gives the Undo state machine FIRST refusal on every
//      response, and returns immediately if it consumed one. No Undo
//      response can ever reach the preparation handlers again.
//   2. Nothing in the Undo path calls close_pad(). On any error it logs the
//      return code + description and gives up on the screen sync only --
//      the signing session stays alive.
//
// The repaint itself never writes a bitmap to the LIVE display. It uses the
// same store mechanism the preparation sequence already uses successfully:
//   SET_TARGET(1)  -> draw into store 1 (off-screen, safe)
//   SET_IMAGE      -> composite (template + remaining strokes) into store 1
//   SET_TEXT_IN_RECT x2 -> the two labels, into store 1
//   SET_TARGET(0)  -> back to the live display
//   SET_IMAGE_FROM_STORE(1) -> firmware-native blit, no payload
// preceded by TOKEN_CMD_API_SIGNATURE_RETRY, which is the one command
// confirmed safe mid-session and which drops the strokes the firmware has
// captured so far.

// master switch: set to false to fall back to local-only Undo (the pad's
// own screen then keeps showing the undone stroke until Confirm, but the
// saved image stays correct because it is built from sigCanvas).
var UNDO_SYNC_TO_PAD = true;
// send SIGNATURE_RETRY before the repaint (true) or after it (false).
// If the screen ends up blank, try flipping this to false.
var UNDO_RETRY_FIRST = true;
// image store used by the preparation sequence (SET_IMAGE_FROM_STORE).
var UNDO_STORE_ID = 1;
// give up on a step if the pad does not answer.
var UNDO_TIMEOUT_MS = 8000;
// pen width the pad itself draws with (TOKEN_CMD_API_DISPLAY_CONFIG_PEN),
// used so the composite matches what the firmware drew.
var PAD_PEN_WIDTH = 3;

var undoStates = {
    idle: 0,
    retry: 1,
    setStoreTarget: 2,
    setStoreImage: 3,
    setFieldText: 4,
    setCustomText: 5,
    setDisplayTarget: 6,
    blitStore: 7
};
var undoState = undoStates.idle;
var undoSeq = [];
var undoSeqIndex = -1;
var undoCompositeImage = null;
var undoTimeoutId = null;
var undoResyncPending = false;

// texts drawn by the preparation sequence; re-applied after Undo so the
// repainted screen is identical to the original one.
var PAD_FIELD_NAME_TEXT = "Signature 1";
var PAD_CUSTOM_TEXT = "Please sign!";

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
}
var padType = 0;

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

var docHashes = {
    kSha1: 0,
    kSha256: 1
};

var cancelButton = -1;
var retryButton = -1;
var confirmButton = -1;
var buttonDiff = 0;
var buttonLeft = 0;
var buttonTop = 0;
var buttonSize = 0;
var backgroundImage;
var scaleFactorX = 1.0;
var scaleFactorY = 1.0;

var supportsRSA = false;
var field_name = "Signature 1";
var custom_text = "Please sign!";
var encryption = "TRUE";
var docHash = docHashes.kSha256;
var encryption_cert = "MIICqTCCAZGgAwIBAgIBATANBgkqhkiG9w0BAQUFADAYMRYwFAYDVQQKEw1EZW1vIHNpZ25vdGVjMB4XDTE1MTAwNzA5NDc1MFoXDTI1MTAwNDA5NDc1MFowGDEWMBQGA1UEChMNRGVtbyBzaWdub3RlYzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOFFpsZexYW28Neznn26Bp9NVCJywFFj1QYXg3DDsaSyr6ubuqXKSC4jkenIGBnom/zKPxwPDtNXuy+nyDYFXYNn87TUdh/51CCr3uk9kR9hvRIzBKwkOx0DGLdCoSGAKDOPHwx1rE0m/SOqYOQh6XFjlybw+KzDZcPvhf2Fq/IFNXHpk8m0YHMAReW8q34CYjk9ZtcIlrcYGTikQherOtYM8CaEUPDd6vdJgosGWEnDeNXDCAIWTFc5ECJm9Hh7a47eF3BG5Pjl1QfOSA8lQBV5eTjQc1n1rWCWULt143nIbN5yCFrn0D8W6+eKJV5urETxWUQ208iqgeU1bIgKSEUCAwEAATANBgkqhkiG9w0BAQUFAAOCAQEAt2ax8iwLFoOmlAOZTQcRQtjxseQAhgOTYL/vEP14rPZhF1/gkI9ZzhESdkqR8mHIIl7FnfBg9A2v9ZccC7YgRb4bCXNzv6TIEyz4EYXNkIq8EaaQpvsX4+A5jKIP0PRNZUaLJaDRcQZudd6FMyHxrHtCUTEvORzrgGtRnhBDhAMiSDmQ958t8RhET6HL8C7EnL7f8XBMMFR5sDC60iCu/HeIUkCnx/a2waZ13QvhEIeUBmTRi9gEjZEsGd1iZmgf8OapTjefZMXlbl7CJBymKPJgXFe5mD9/yEMFKNRy5Xfl3cB2gJka4wct6PSIzcQVPaCts6I0V9NfEikXy1bpSA==";

var padConnectionType;

var wsUri = "wss://local.signotecwebsocket.de:49494";
//debugger
var state = document.getElementById("status");
var sigcanvas = document.getElementById("sigCanvas");

var padIndex = 0;

const PEN_COLOR_GREY = "#7f7f7f";
const PEN_COLOR_RED = "#ff0000";
const PEN_COLOR_GREEN = "#008000";
const PEN_COLOR_BLUE = "#0000ff";
const PEN_COLOR_BLACK = "#000000";

const MODE_LIST_DEFAULT = "Default";
const MODE_LIST_API = "API";

if (window.WebSocket === undefined) {
    state.innerHTML = "sockets not supported " + evt.target.url;
    state.className = "fail";
}
else {
    if (typeof String.prototype.startsWith != "function") {
        String.prototype.startsWith = function (str) {
            return this.indexOf(str) == 0;
        };
    }
}

function onMainWindowLoad() {
    //debugger
    try {
        signoPADAPIWeb = new ActiveXObject("signotec.STPadActiveXServer");
        state.className = "success";
        state.innerHTML = "ActiveX loaded";
    } catch (e) {
        signoPADAPIWeb = new WebSocket(wsUri);
        signoPADAPIWeb.onopen = onOpen;
        signoPADAPIWeb.onclose = onClose;
        signoPADAPIWeb.onerror = onError;
    }

    // Common for ActiveX and WebSocket
    signoPADAPIWeb.onmessage = onMessage;

    clearSignature();
    check_boxes_selectedElements_onchange();
    //ModeListName_onchange();
}

function onMainWindowBeforeUnload() {
    close_pad();
}

function onOpen(evt) {
    state.className = "success";
    if ((evt.target === undefined) || (evt.target.url === undefined)) {
        state.innerHTML = "ActiveX loaded";
    }
    else {
        state.innerHTML = "Connected to " + evt.target.url;
    }
}

function onClose(evt) {
    //debugger
    state.className = "fail";
    if ((evt.target === undefined) || (evt.target.url === undefined)) {
        state.innerHTML = "ActiveX unloaded";
    }
    else {
        state.innerHTML = "Disconnected from " + evt.target.url;
    }
}

function onError(evt) {
    state.className = "fail";
    if ((evt.target === undefined) || (evt.target.url === undefined)) {
        state.innerHTML = "Communication error";
    }
    else {
        state.innerHTML = "Communication error " + evt.target.url;
    }
}

// Cumulative log. The old version overwrote #log on every message
// (log.innerHTML = ...), so only the LAST line ever survived -- which is
// exactly why the previous crash could never be diagnosed. Now every sent
// and received message is appended, long base64 payloads are shortened so
// the DOM stays usable, and everything is mirrored to the browser console.
var logLineCount = 0;

function shortenForLog(msg) {
    try {
        // collapse the huge base64 image payloads
        return String(msg).replace(
            /("TOKEN_PARAM_(?:BITMAP|IMAGE|FILE)":")([^"]{80,})(")/g,
            function (m, head, body, tail) {
                return head + body.substring(0, 40) + "...[" + body.length + " chars]..." + tail;
            });
    } catch (e) {
        return msg;
    }
}

function logMessage(msg) {
    var line = shortenForLog(msg);
    try {
        console.log("[signotec] " + line);
    } catch (e) { }
    try {
        var el = document.getElementById("log");
        if (!el) {
            return;
        }
        logLineCount++;
        var li = document.createElement("li");
        li.textContent = "[" + logLineCount + "] " + line;
        el.appendChild(li);
        el.scrollTop = el.scrollHeight;
    } catch (e) { }
}

/**
* Logs the return code + error description of any response, so a failure
* shows up in #log with the exact TOKEN_PARAM_RETURN_CODE /
* TOKEN_PARAM_ERROR_DESCRIPTION instead of silently vanishing.
*/
function logResponseError(prefix, obj) {
    logMessage("!! " + prefix +
        " | TOKEN_CMD_ORIGIN=" + obj.TOKEN_CMD_ORIGIN +
        " | TOKEN_PARAM_RETURN_CODE=" + obj.TOKEN_PARAM_RETURN_CODE +
        " | TOKEN_PARAM_ERROR_DESCRIPTION=" + obj.TOKEN_PARAM_ERROR_DESCRIPTION);
}

/**
* Draws a stroke start point into the canvas
*/
let allcanvass = [];
// per-stroke point storage (raw device coords), used by Undo
let signatureStrokes = [];
let currentStrokeRef = null;
// the pristine per-model template (border/title/buttons), cached once;
// backgroundImage itself gets overwritten with template+strokes composites
let originalBackgroundImage = null;
function drawStrokeStartPoint(canvasContext, softCoordX, softCoordY) {
    // open new stroke's path
    canvasContext.beginPath();
    canvasContext.arc(softCoordX, softCoordY, 1, 0, 2 * Math.PI, true);
    canvasContext.fill();
    canvasContext.stroke();
    canvasContext.moveTo(softCoordX, softCoordY);

    
}

/**
* Draws a stroke point into the canvas
*/
function drawStrokePoint(canvasContext, softCoordX, softCoordY) {
    // continue after start or not start point
    canvasContext.lineTo(softCoordX, softCoordY);
    canvasContext.stroke();
    allcanvass.push(canvasContext);
   
}

// disconnect send begin
// TOKEN_CMD_DISCONNECT
function disconnect_send(index) {
   //debugger
    var msg = "The pad (index: " + index + ") has been disconnected.";
    ////alert(msg);

    searchState = searchStates.setPadType;
    openState = openStates.openPad;
    preparationState = preparationStates.setDisplayRotation;
    padState = padStates.closed;
}
// disconnect send end

// signature point send begin
//TOKEN_CMD_SIGNATURE_POINT
function getSelectedPenColor() {
    switch (document.getElementById("signaturePenColorSelect").value) {
        case PEN_COLOR_GREY:
            return "#7F7F7F";
        case PEN_COLOR_RED:
            return "#FF0000";
        case PEN_COLOR_GREEN:
            return "#008000";
        case PEN_COLOR_BLUE:
            return "#0000FF";
        case PEN_COLOR_BLACK:
            return "#000000";
        default:
            return "#FF0000";
    }
}

function signature_point_send(x, y, p) {
    var ctx = sigcanvas.getContext("2d");

    ctx.fillStyle = "#fff";
    ctx.strokeStyle = getSelectedPenColor();
    ctx.lineWidth = 5;
    ctx.lineCap = "round";

    var softX = x * scaleFactorX;
    var softY = y * scaleFactorY;

    if (p == 0) {
        // new stroke: remember raw device coords so it can be redrawn
        // later (both for the local preview and for the composite we
        // push back to the pad after an Undo)
        currentStrokeRef = {
            color: ctx.strokeStyle,
            points: [{ x: x, y: y }]
        };
        signatureStrokes.push(currentStrokeRef);

        drawStrokeStartPoint(ctx, softX, softY);
    }
    else {
        if (currentStrokeRef === null) {
            currentStrokeRef = { color: ctx.strokeStyle, points: [] };
            signatureStrokes.push(currentStrokeRef);
        }
        currentStrokeRef.points.push({ x: x, y: y });

        drawStrokePoint(ctx, softX, softY);
    }
}

/**
* Redraws the local preview canvas (sigcanvas) from signatureStrokes.
* Used right after Undo removes the last stroke.
*/
function redrawSignatureCanvas() {
    var ctx = sigcanvas.getContext("2d");
    ctx.clearRect(0, 0, sigcanvas.width, sigcanvas.height);
    drawStrokesOnContext(ctx, 5);
}
// signature point send end

// signature retry send begin
// TOKEN_CMD_SIGNATURE_RETRY and TOKEN_CMD_API_SIGNATURE_RETRY
function signature_retry_send() {
    var message;
    if (padMode == padModes.Default) {
        // default mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_RETRY" }';
    }
    else if (padMode == padModes.API) {
        // API mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_RETRY" }';
    }
    else {
        ////alert("invalid padMode");
        return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function signature_retry_response(obj) {
    // retry of the signature from default and api pad
    if ((obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SIGNATURE_RETRY") || (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_RETRY")) {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("signature retry failed", obj);
            close_pad();
            return;
        }

        // A Retry that belongs to the Undo sequence never gets here: it is
        // consumed by undoSync_handleResponse() in onMessage() before any
        // handler runs. So reaching this point always means a real full
        // clear was requested.
        var ctx = sigcanvas.getContext("2d");
        ctx.clearRect(0, 0, sigcanvas.width, sigcanvas.height);
        signatureStrokes = [];
        currentStrokeRef = null;
    }
    else {
        // do nothing
    }
}

// signature retry send end

// signature confirm send begin
// TOKEN_CMD_SIGNATURE_CONFIRM and TOKEN_CMD_API_SIGNATURE_CONFIRM
function signature_confirm_send() {
    var message;
    if (padMode == padModes.Default) {
        // default mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_CONFIRM" }';
    }
    else if (padMode == padModes.API) {
        // API mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_CONFIRM" }';
    }
    else {
        //alert("invalid padMode");
        return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function signature_confirm_response(obj) {
    // confirm of the signature from default and api pad
    if ((obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SIGNATURE_CONFIRM") || (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_CONFIRM")) {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to confirm the signature", obj);
            close_pad();
            return;
        }

        // No legal/biometric SignData needed here (confirmed), so the
        // final image is taken straight from sigCanvas -- which Undo
        // already keeps correct -- instead of round-tripping to the pad
        // for TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX /
        // TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA (both of which read from
        // the pad's own internal buffer and would still include any
        // stroke that was undone).
        signature_image_from_canvas();
    }
    else {
        // do nothing
    }
}

// Builds the final signature PNG straight from sigCanvas.
function signature_image_from_canvas() {
    var imgData = sigcanvas.toDataURL("image/png");
    // imgData ("data:image/png;base64,....") is what the rest of the
    // app should use as the final signature image.

    $("#signDoc1").click();
    $("#fa-close2").click();

    close_pad();
}

// TOKEN_CMD_SIGNATURE_IMAGE and TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX
function signature_image() {
    var message;

    if (padMode == padModes.Default) {
        // default mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_IMAGE' +
            '", "TOKEN_PARAM_FILE_TYPE":"' + '1' + // PNG
            '", "TOKEN_PARAM_PEN_WIDTH":"' + '5' +
            '" }';
    }
    else if (padMode == padModes.API) {
        // API mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX' +
            '", "TOKEN_PARAM_RESOLUTION":"' + '300' +
            '", "TOKEN_PARAM_WIDTH":"' + '0' +
            '", "TOKEN_PARAM_HEIGHT":"' + '0' +
            '", "TOKEN_PARAM_FILE_TYPE":"' + '1' + // PNG
            '", "TOKEN_PARAM_PEN_WIDTH":"' + '5' +
            '", "TOKEN_PARAM_PEN_COLOR":"' + document.getElementById("signaturePenColorSelect").value +
            '", "TOKEN_PARAM_OPTIONS":"' + '0x1400' +
            '" }';
    }
    else {
        //alert("invalid padMode");
        return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function signature_image_response(obj) {

    

    // get the signature image from default and api pad
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SIGNATURE_IMAGE") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get signature image", obj);
            close_pad();
            return;
        }

        //document.getElementById("Signature_0").src = "data:image/png;base64," + obj.TOKEN_PARAM_FILE;

        signature_sign_data();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get signature image", obj);
            close_pad();
            return;
        }

        ////debugger;
        //document.getElementById("Signature_0").src = "data:image/png;base64," + obj.TOKEN_PARAM_IMAGE;
        var SignImg = obj.TOKEN_PARAM_IMAGE;

$("#signDoc1").click();
$("#fa-close2").click();

        //Ajax Code.................................................
       
    //    var imgData = document.getElementById('sigCanvas').toDataURL();

    //    var selRowId = $("#outBoxGrid").jqGrid('getGridParam', 'selrow');
    //    var rowdata = $("#outBoxGrid").jqGrid('getRowData', selRowId);
    //    var PIC_LOCATION = rowdata.PIC_LOCATION;


    //    var docid = $("#saderChat").attr("DOC_ID");
    //    var date = $("#saderChat").attr("DOCDATE");
    //    //var month = date.split('/')[1];
    //    //month = month.replace(/^0+/, '');

    //    var formData = new FormData();
    //    formData.append("docId", docid);
    //    //formData.append("month", month);
    //    //formData.append("year", date.split('/')[0]);

    //    formData.append("PIC_LOCATION", PIC_LOCATION);
    //    formData.append("CALC_TNZ_UNIT_CODE", $("#CALC_TNZ_UNIT_CODE").val());
    //    var PdfPath = '';
    //    $.ajax({

    //        url: '../outbox_MOSWADA/someClasses/Handler2.ashx',
    //        method: "POST",
    //        data: formData,
    //        processData: false,
    //        contentType: false,
    //        beforeSend: function () {

    //        },
    //        success: function (data) {
                
    //            var filepaths = JSON.parse(data);
    //            for(var xx=0 ; xx<filepaths.length;xx++)
    //            {
    //                if(filepaths[xx].endsWith(".pdf"))
    //                {
    //                    PdfPath = filepaths[xx];

    //                }
    //            }
    //           // PdfPath = filepaths[0];
    //            PdfPath = PdfPath.replace(/\\/g, "**")

    //            //debugger
    //            //var psw = "syncfusion";
    //            //$.ajax({
    //            //    type: "POST",
    //            //    url: "../../verify.asmx/getCertificateName",
    //            //    data: "{'certPassword':'" + psw + "'}",
    //            //    contentType: "application/json",
    //            //    datatype: "json",
    //            //    success: function (data) {
    //            //        ////alert(data.d);
                    
    //            //        if (data.d != null) {

    //            //            //debugger

    //            //            //  $("#signAs").show();

    //            //            //    var selectedSignture = $(this).children("option:selected").text();
    //            //            ////alert("You have selected the sign  " + selectedSignture);

    //            //            var numPage = 0;
    //            //            var SignImgPath = imgData;
    //            //            var signtureName = data.d;

    //            //            $.ajax({
    //            //                type: "POST",
    //            //                url: "../../PdfSignNow.asmx/pdfSignNow",
    //            //                data: "{'PdfPath':'" + PdfPath + "','numPage':'" + numPage + "','psw':'" + psw + "','SignImgPath':'" + SignImgPath + "','signtureName':'" + signtureName + "'}",
    //            //                contentType: "application/json",
    //            //                datatype: "json",
    //            //                success: function (data) {
    //            //                    //alert(data.d);
    //            //                    $(".Main_overlay").fadeOut("slow");
    //            //                },
    //            //                error: function (error) {
    //            //                    //alert("Error In Sign");
    //            //                }
    //            //            });


    //            //        }
    //            //        else {
    //            //            //alert("Certificate Authentication Failed1");
    //            //        }
    //            //    },
    //            //    error: function (error) {
    //            //        //alert("Certificate Authentication Failed");
    //            //    }
    //            //});

    //            $.ajax({
    //                type: "POST",
    //                url: "../../requestCertificate.asmx/getCertificateName",
    //                data: "",
    //                contentType: "application/json",
    //                datatype: "json",
    //                success: function (data) {
               
    //                    //$("#certificateList").removeData();

    //                    //for (var i = 0; i < data.d.length; i++) {
    //                    //    $("#certificateList").append(new Option(data.d[i], i + 2));
    //                    //}

    //                    //$("#certificateName").show();

    //                    //$("#certificateList").change(function () {
    //                    //var certificateSelected = $(this).children("option:selected").text();
    //                    //var certificateSelected =  data.d[4];
    //                    //var certificateSelected =  "localhost";
    //                    //$("#verify").show();
    //                    //$("#signNow").show();
    //                    //$('#barCode').show();
    //                    //debugger
                            
    //                        var numPage = 0;
    //                        var SignImgPath = imgData;
    //                        var certificateName = '123';
    //                        var docId = '123';

    //                        $.ajax({
    //                            type: "POST",
    //                            url: "../../PdfSignNow.asmx/pdfSignNow",
    //                            data: "{'PdfPath':'" + PdfPath + "','numPage':'" + numPage+ "','SignImgPath':'" + SignImgPath + "','certificateName':'" + certificateName + "','docId':'" + docid + "','CALC_TNZ_UNIT_CODE':'" + $("#CALC_TNZ_UNIT_CODE").val() + "','CIV_ID_CARD_NO':'" + $("#sert").val() + "'}",
    //                            contentType: "application/json",
    //                            datatype: "json",
    //                            success: function (data) {
    //                                //alert(data.d);
    //                            },
    //                            error: function (error) {
    //                                //alert("لم يتم الاعتماد");
    //                            }
    //                        });

    //                    //});
    //                },
    //                error: function (error) {
    //                    //alert("Certificate name does not exist !!")
    //                }
    //            });

    //        },
    //        error: function (response) {
    //          //  //alert("error")
    //        }

    //    });



    //    //Done Response Ajax Code.................................................

        signature_sign_data();
    //}
    //else {
    //    // do nothing
    //}
}
}

// TOKEN_CMD_SIGNATURE_SIGN_DATA and TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA
function signature_sign_data() {
    var message;
    if (padMode == padModes.Default) {
        // default mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_SIGN_DATA" }';
    }
    else if (padMode == padModes.API) {
        // API mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA" }';
    }
    else {
        //alert("invalid padMode");
        return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function signature_sign_data_response(obj) {
    // get the sign data from default and api pad
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SIGNATURE_SIGN_DATA") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get signature SignData", obj);
            close_pad();
            return;
        }

        if (supportsRSA) {
            document.getElementById("CertID_0").innerHTML = obj.TOKEN_PARAM_CERT_ID;
        }
        else {
            document.getElementById("CertID_0").innerHTML = "none";
        }

        //document.getElementById("SignData_0").value = obj.TOKEN_PARAM_SIGNATURE_SIGN_DATA;

        close_pad();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA") {
        // API mode

        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get signature SignData", obj);
            close_pad();
            return;
        }

        

        //document.getElementById("SignData_0").value = obj.TOKEN_PARAM_SIGN_DATA;

        close_pad();
    }
    else {
        // do nothing
    }
}
// signature confirm send end

// signature cancel send begin
// TOKEN_CMD_SIGNATURE_CANCEL and TOKEN_CMD_API_SIGNATURE_CANCEL
function signature_cancel_send() {

    $(".Main_overlay").fadeOut("slow");
    
    var message;
    if (padMode == padModes.Default) {
        // default mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_CANCEL" }';
    }
    else if (padMode == padModes.API) {
        // API mode
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_CANCEL", "TOKEN_PARAM_ERASE":"0" }';
    }
    else {
        //alert("invalid padMode");
        return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function signature_cancel_response(obj) {
    

    // cancel the signature from default and api pad
    if ((obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SIGNATURE_CANCEL") || (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_CANCEL")) {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to cancel signature process", obj);
            close_pad();
            return;
        }

        var ctx = sigcanvas.getContext("2d");
        ctx.clearRect(0, 0, sigcanvas.width, sigcanvas.height);

        close_pad();
    }
    else {
        // do nothing
    }
}
// signature cancel send end

// selection confirm send begin
// TOKEN_CMD_SELECTION_CONFIRM
function selection_confirm_send() {
    if (padMode == padModes.Default) {
        // default mode
        var status = '';
        for (i = 1; i <= document.getElementById("check_boxes_selectedElements").value; i++) {
            status += 'Feld ' + i + ' = ' + document.getElementById("fieldChecked" + i).checked + '\n';
        }
        //alert(status);
        signature_start();
    }
    else if (padMode == padModes.API) {
        // API mode
        // do nothing
    }
    else {
        //alert("invalid padMode");
        return;
    }
}
// selection confirm send end

// selection change send begin
// TOKEN_CMD_SELECTION_CHANGE
function selection_change_send(fieldId, fieldChecked) {
    if (padMode == padModes.Default) {
        // default mode
        for (i = 1; i <= document.getElementById("check_boxes_selectedElements").value; i++) {
            if (document.getElementById("fieldID" + i).value == fieldId) {
                if (fieldChecked == "TRUE") {
                    document.getElementById("fieldChecked" + i).checked = true;
                } else {
                    document.getElementById("fieldChecked" + i).checked = false;
                }
            }
        }
    }
    else if (padMode == padModes.API) {
        // API mode
        // do nothing
    }
    else {
        //alert("invalid padMode");
        return;
    }
}
// selection change send end

// selection cancel send begin
// TOKEN_CMD_SELECTION_CANCEL
function selection_cancel_send() {
    if (padMode == padModes.Default) {
        // default mode
        var ctx = sigcanvas.getContext("2d");
        ctx.clearRect(0, 0, sigcanvas.width, sigcanvas.height);

        close_pad();
    }
    else if (padMode == padModes.API) {
        // API mode
        // do nothing
    }
    else {
        //alert("invalid padMode");
        return;
    }
}
// selection cancel send end

// error send begin
// TOKEN_CMD_ERROR
function error_send(error_context, return_code, error_description) {
    var ret = return_code;
    if (ret < 0) {
        //alert("Failed to confirm the signature. Reason: " + error_description + ", Context: " + error_context);
    }
}
// error send end

// api sensor hot spot pressed send begin
// TOKEN_CMD_API_SENSOR_HOT_SPOT_PRESSED
function api_sensor_hot_spot_pressed_send(button) {
    switch (button) {
        // cancel signing process
        case cancelButton:
            signature_cancel_send();
            break;

        // was: full clear (signature_retry_send()).
        // now: remove only the last stroke, keep the rest, and push the
        // remaining strokes back onto the pad's own screen.
        case retryButton:
            undo_last_stroke_send();
            break;

        // confirm signing process
        case confirmButton:
            signature_confirm_send();
            break;

        default:
            //alert("unknown button id: " + button);
    }
}

// undo last stroke (bound to the existing Retry hotspot) begin
//
// IMPORTANT LESSON LEARNED: re-running the full one-time preparation
// sequence (api_signature_start(), i.e. SET_ROTATION -> ... ->
// SIGNATURE_START) while a session is already active is NOT safe --
// the pad rejects it mid-way, which cascades into close_pad() being
// called and leaves a blank screen. That whole approach is abandoned.
//
// The only device command confirmed safe to send DURING an already
// active session is TOKEN_CMD_API_SIGNATURE_RETRY (that's its very
// purpose: "restart signing process" without tearing the session down).
// So the strategy here is: Retry (safe, mid-session) to wipe the pad's
// screen, then push the remaining strokes back with SET_TARGET(0) +
// SET_IMAGE -- both plain Display calls, never touching
// preparationState or re-entering api_signature_start().
function undo_last_stroke_send() {
    if (signatureStrokes.length === 0) {
        logMessage("-- undo ignored: no strokes");
        return;
    }

    signatureStrokes.pop();
    currentStrokeRef = null;

    // The local preview is fixed immediately and unconditionally. It is
    // what signature_image_from_canvas() saves on Confirm, so the produced
    // file is correct even if the pad-screen sync below fails.
    redrawSignatureCanvas();
    logMessage("-- undo: " + signatureStrokes.length + " stroke(s) left");

    undoSync_start();
}

// ---------------------------------------------------------------------
// Undo -> pad screen synchronisation state machine
// ---------------------------------------------------------------------

function undoSync_orderedStates() {
    var seq = [
        undoStates.setStoreTarget,
        undoStates.setStoreImage,
        undoStates.setFieldText,
        undoStates.setCustomText,
        undoStates.setDisplayTarget,
        undoStates.blitStore
    ];
    if (UNDO_RETRY_FIRST) {
        seq.unshift(undoStates.retry);
    } else {
        seq.push(undoStates.retry);
    }
    return seq;
}

function undoSync_messageFor(state) {
    switch (state) {
        case undoStates.retry:
            return '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_RETRY" }';

        case undoStates.setStoreTarget:
            // target 1 = off-screen store, NOT the live display
            return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TARGET", "TOKEN_PARAM_TARGET":"1" }';

        case undoStates.setStoreImage:
            return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_IMAGE", "TOKEN_PARAM_X_POS":"0", "TOKEN_PARAM_Y_POS":"0", "TOKEN_PARAM_BITMAP":"' + undoCompositeImage + '" }';

        case undoStates.setFieldText:
            return buildTextInRectMessage(getFieldNameRect(), PAD_FIELD_NAME_TEXT);

        case undoStates.setCustomText:
            return buildTextInRectMessage(getCustomTextRect(), PAD_CUSTOM_TEXT);

        case undoStates.setDisplayTarget:
            return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TARGET", "TOKEN_PARAM_TARGET":"0" }';

        case undoStates.blitStore:
            return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE", "TOKEN_PARAM_STORE_ID":"' + UNDO_STORE_ID + '" }';

        default:
            return null;
    }
}

function undoSync_expectedOrigin(state) {
    switch (state) {
        case undoStates.retry:            return "TOKEN_CMD_API_SIGNATURE_RETRY";
        case undoStates.setStoreTarget:   return "TOKEN_CMD_API_DISPLAY_SET_TARGET";
        case undoStates.setStoreImage:    return "TOKEN_CMD_API_DISPLAY_SET_IMAGE";
        case undoStates.setFieldText:     return "TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT";
        case undoStates.setCustomText:    return "TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT";
        case undoStates.setDisplayTarget: return "TOKEN_CMD_API_DISPLAY_SET_TARGET";
        case undoStates.blitStore:        return "TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE";
        default:                          return null;
    }
}

function undoSync_stateName(state) {
    for (var k in undoStates) {
        if (undoStates[k] === state) {
            return k;
        }
    }
    return "?" + state;
}

/**
* Ends the pad-screen sync WITHOUT touching the signing session. Never
* calls close_pad(): a failed screen repaint must not kill the signature.
*/
function undoSync_abort(reason) {
    logMessage("!! undo sync aborted at " + undoSync_stateName(undoState) + ": " + reason);
    undoSync_finish();
}

function undoSync_finish() {
    if (undoTimeoutId !== null) {
        clearTimeout(undoTimeoutId);
        undoTimeoutId = null;
    }
    undoState = undoStates.idle;
    undoSeq = [];
    undoSeqIndex = -1;
    undoCompositeImage = null;

    if (undoResyncPending) {
        // another Undo was pressed while this one was still in flight
        undoResyncPending = false;
        undoSync_start();
    }
}

function undoSync_start() {
    if (!UNDO_SYNC_TO_PAD) {
        return;
    }
    if (padState != padStates.opened) {
        logMessage("-- undo sync skipped: pad not open");
        return;
    }
    if (padMode != padModes.API) {
        logMessage("-- undo sync skipped: not in API mode");
        return;
    }
    if (!originalBackgroundImage) {
        logMessage("-- undo sync skipped: background template not loaded yet");
        return;
    }
    if (undoState != undoStates.idle) {
        // coalesce: re-run once the in-flight sequence is done
        undoResyncPending = true;
        logMessage("-- undo sync busy, queued a re-sync");
        return;
    }

    buildCompositeBackgroundImage(function (compositeBase64) {
        if (!compositeBase64) {
            logMessage("!! undo sync: failed to build composite image");
            return;
        }
        if (undoState != undoStates.idle) {
            undoResyncPending = true;
            return;
        }
        undoCompositeImage = compositeBase64;
        undoSeq = undoSync_orderedStates();
        undoSeqIndex = -1;
        logMessage("-- undo sync start (retryFirst=" + UNDO_RETRY_FIRST + ")");
        undoSync_advance();
    });
}

function undoSync_advance() {
    if (undoTimeoutId !== null) {
        clearTimeout(undoTimeoutId);
        undoTimeoutId = null;
    }

    undoSeqIndex++;
    if (undoSeqIndex >= undoSeq.length) {
        logMessage("-- undo sync done: pad screen now matches the preview");
        undoSync_finish();
        return;
    }

    undoState = undoSeq[undoSeqIndex];

    var message = undoSync_messageFor(undoState);
    if (message === null) {
        undoSync_abort("no message for state");
        return;
    }

    undoTimeoutId = setTimeout(function () {
        undoTimeoutId = null;
        undoSync_abort("timed out waiting for " + undoSync_expectedOrigin(undoState));
    }, UNDO_TIMEOUT_MS);

    logMessage(">> undo[" + undoSync_stateName(undoState) + "] " + message);
    try {
        signoPADAPIWeb.send(message);
    } catch (e) {
        undoSync_abort("send threw: " + e);
    }
}

/**
* Called by onMessage() BEFORE any other handler. Returns true when the
* response belongs to the running Undo sequence, in which case onMessage()
* must not pass it on -- letting these responses reach
* api_signature_start_responses() is what restarted the preparation
* sequence mid-session and closed the pad.
*/
function undoSync_handleResponse(obj) {
    if (undoState == undoStates.idle) {
        return false;
    }
    if (obj.TOKEN_CMD_ORIGIN != undoSync_expectedOrigin(undoState)) {
        return false;
    }

    var ret = obj.TOKEN_PARAM_RETURN_CODE;
    if (ret < 0) {
        logResponseError("undo sync step " + undoSync_stateName(undoState) + " failed", obj);
        // deliberately NOT close_pad(): keep signing alive, give up on the
        // screen repaint only.
        undoSync_finish();
        return true;
    }

    logMessage("<< undo[" + undoSync_stateName(undoState) + "] ok (ret=" + ret + ")");
    undoSync_advance();
    return true;
}

/**
* Draws the pad's own pristine template (originalBackgroundImage) then
* the remaining strokes on top, at the same pixel size/scale used for
* sigcanvas (sigcanvas.width/height already equal the pad's own display
* resolution, since they were set from TOKEN_CMD_API_DISPLAY_GET_WIDTH/
* HEIGHT). Calls back with a base64 PNG (no "data:image/..." prefix),
* ready to be sent as TOKEN_PARAM_BITMAP.
*/
function buildCompositeBackgroundImage(callback) {
    var tpl = new Image();
    tpl.onload = function () {
        try {
            var off = document.createElement("canvas");
            off.width = sigcanvas.width;
            off.height = sigcanvas.height;

            var ctx = off.getContext("2d");
            ctx.drawImage(tpl, 0, 0, off.width, off.height);

            // PAD_PEN_WIDTH (not 5) so the repainted strokes match the width
            // the firmware itself drew with (TOKEN_CMD_API_DISPLAY_CONFIG_PEN)
            drawStrokesOnContext(ctx, PAD_PEN_WIDTH);

            var dataURL = off.toDataURL("image/png");
            callback(dataURL.replace(/^data:image\/(png|jpg);base64,/, ""));
        } catch (e) {
            logMessage("!! composite build failed: " + e);
            callback(null);
        }
    };
    tpl.onerror = function () {
        logMessage("!! composite build failed: background template did not load");
        callback(null);
    };
    tpl.src = "data:image/png;base64," + originalBackgroundImage;
}

/**
* Replays signatureStrokes onto any 2d context, converting the stored raw
* device coordinates to display pixels. Shared by the local preview and by
* the composite pushed back to the pad.
*/
function drawStrokesOnContext(ctx, penWidth) {
    ctx.lineWidth = penWidth;
    ctx.lineCap = "round";

    signatureStrokes.forEach(function (stroke) {
        if (!stroke.points || stroke.points.length === 0) {
            return;
        }
        ctx.fillStyle = stroke.color;
        ctx.strokeStyle = stroke.color;
        stroke.points.forEach(function (pt, idx) {
            var sx = pt.x * scaleFactorX;
            var sy = pt.y * scaleFactorY;
            if (idx === 0) {
                drawStrokeStartPoint(ctx, sx, sy);
            } else {
                drawStrokePoint(ctx, sx, sy);
            }
        });
    });
}

// ---------------------------------------------------------------------
// Per-model text rectangles. Single source of truth: used both by the
// one-time preparation sequence and by the Undo repaint, so the two can
// never drift apart.
// ---------------------------------------------------------------------
function getFieldNameRect() {
    switch (padType) {
        case padTypes.sigmaUSB:
        case padTypes.sigmaSerial:
            return { left: 15, top: 43, width: 285, height: 18 };

        case padTypes.omegaUSB:
        case padTypes.omegaSerial:
            return { left: 40, top: 86, width: 570, height: 40 };

        case padTypes.gammaUSB:
        case padTypes.gammaSerial:
            return { left: 40, top: 86, width: 720, height: 40 };

        case padTypes.deltaUSB:
        case padTypes.deltaSerial:
        case padTypes.deltaIP:
            return { left: 40, top: 86, width: 1200, height: 50 };

        case padTypes.alphaUSB:
        case padTypes.alphaSerial:
        case padTypes.alphaIP:
            return { left: 20, top: 120, width: 730, height: 30 };

        default:
            return null;
    }
}

function getCustomTextRect() {
    switch (padType) {
        case padTypes.sigmaUSB:
        case padTypes.sigmaSerial:
            return { left: 15, top: 110, width: 265, height: 18 };

        case padTypes.omegaUSB:
        case padTypes.omegaSerial:
            return { left: 40, top: 350, width: 520, height: 40 };

        case padTypes.gammaUSB:
        case padTypes.gammaSerial:
            return { left: 40, top: 350, width: 670, height: 40 };

        case padTypes.deltaUSB:
        case padTypes.deltaSerial:
        case padTypes.deltaIP:
            return { left: 40, top: 640, width: 670, height: 50 };

        case padTypes.alphaUSB:
        case padTypes.alphaSerial:
        case padTypes.alphaIP:
            return { left: 20, top: 1316, width: 730, height: 30 };

        default:
            return null;
    }
}

function buildTextInRectMessage(rect, text) {
    if (rect === null) {
        return null;
    }
    return '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT' +
        '", "TOKEN_PARAM_LEFT":"' + rect.left +
        '", "TOKEN_PARAM_TOP":"' + rect.top +
        '", "TOKEN_PARAM_WIDTH":"' + rect.width +
        '", "TOKEN_PARAM_HEIGHT":"' + rect.height +
        '", "TOKEN_PARAM_ALIGNMENT":"3", "TOKEN_PARAM_TEXT":"' + text + '", "TOKEN_PARAM_OPTIONS":"0" }';
}
// undo last stroke end
// api sensor hot spot pressed send end

// api display scroll pos changed send begin
// TOKEN_CMD_API_DISPLAY_SCROLL_POS_CHANGED
function api_display_scroll_pos_changed_send(xPos, yPos) {
    console.log(xPos + "," + yPos);
}
// api display scroll pos changed send end

// getSignature begin
function getSignature() {

    sigcanvas = document.getElementById("sigCanvas");

    //delete the previous signature
    var ctx = sigcanvas.getContext("2d");
    ctx.clearRect(0, 0, sigcanvas.width, sigcanvas.height);

    // new signing session: reset local stroke history used by Undo
    signatureStrokes = [];
    currentStrokeRef = null;

    //document.getElementById("Signature_0").src = "White.png";
    //document.getElementById("SignData_0").value = "";

    //var padConnectionTypeList = document.getElementById("PadConnectionTypeList");
    padConnectionType = "HID";

    api_search_for_pads();

    
}
// getSignature end

// getSignatureDefault begin
// search for pads begin
// TOKEN_CMD_SEARCH_FOR_PADS
function search_for_pads() {
    var message;

    //search for defailt pads
    message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SEARCH_FOR_PADS", "TOKEN_PARAM_PAD_SUBSET":"' + padConnectionType + '" }';

    signoPADAPIWeb.send(message);
    logMessage(message);
}

function search_for_pads_response(obj) {
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SEARCH_FOR_PADS") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("The search for pads failed", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //check for connected pads
        if (obj.TOKEN_PARAM_CONNECTED_PADS == null) {
            //alert("No connected pads have been found.");
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            return;
        }

        padType = parseInt(obj.TOKEN_PARAM_CONNECTED_PADS[0].TOKEN_PARAM_PAD_TYPE);

        //show the pads properties
        //document.getElementById("PadType_0").innerHTML = getReadableType(padType);
        //document.getElementById("SerialNumber_0").innerHTML = obj.TOKEN_PARAM_CONNECTED_PADS[0].TOKEN_PARAM_PAD_SERIAL_NUMBER;
        //document.getElementById("FirmwareVersion_0").innerHTML = obj.TOKEN_PARAM_CONNECTED_PADS[0].TOKEN_PARAM_PAD_FIRMWARE_VERSION;

        if (obj.TOKEN_PARAM_CONNECTED_PADS[0].TOKEN_PARAM_PAD_CAPABILITIES & deviceCapabilities.SupportsRSA) {
            supportsRSA = true;
        }
        else {
            supportsRSA = false;
        }

        if (supportsRSA) {
            document.getElementById("RSASupport_0").innerHTML = "Yes";
        }
        else {
            document.getElementById("RSASupport_0").innerHTML = "No";
        }

        //try to open the connected pad
        open_pad();
    }
    else {
        // do nothing
    }
}
// search for pads end

// open pad begin
// TOKEN_CMD_OPEN_PAD
function open_pad() {
    var message;

    message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_OPEN_PAD", "TOKEN_PARAM_PAD_INDEX":"' + padIndex + '" }';

    signoPADAPIWeb.send(message);
    logMessage(message);
}

function open_pad_response(obj) {
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_OPEN_PAD") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to open pad", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            return;
        }

        padState = padStates.opened;

        //set canvas size
        sigcanvas.width = obj.TOKEN_PARAM_PAD_DISPLAY_WIDTH;
        sigcanvas.height = obj.TOKEN_PARAM_PAD_DISPLAY_HEIGHT;

        //get scale factor from siganture resolution to canvas
        scaleFactorX = obj.TOKEN_PARAM_PAD_DISPLAY_WIDTH / obj.TOKEN_PARAM_PAD_X_RESOLUTION;
        scaleFactorY = obj.TOKEN_PARAM_PAD_DISPLAY_HEIGHT / obj.TOKEN_PARAM_PAD_Y_RESOLUTION;

        //start the signature process
        selection_dialog();
    }
    else {
        // do nothing
    }
}
// open pad end
// getSignatureDefault end

// getSignatureAPI begin
// api search for pads begin
// TOKEN_CMD_API_DEVICE_SET_COM_PORT and TOKEN_CMD_API_DEVICE_GET_COUNT and infos (searchStates states)
function api_search_for_pads() {
    var message;

    switch (searchState) {
        case searchStates.setPadType:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_SET_COM_PORT", "TOKEN_PARAM_PORT_LIST":"' + padConnectionType + '" }';
            break;

        case searchStates.search:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_GET_COUNT" }';
            break;

        case searchStates.getInfo:
            // get info of first pad
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_GET_INFO", "TOKEN_PARAM_INDEX":"' + padIndex + '" }';
            break;

        case searchStates.getVersion:
            // get firmware version of first pad
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_GET_VERSION", "TOKEN_PARAM_INDEX":"' + padIndex + '" }';
            break;

        default:
            searchState = searchStates.setPadType;
            //alert("invalid searchState");
            return;
    }
    //debugger
    signoPADAPIWeb.send(message);
    
    logMessage(message);
}

function api_search_for_pads_responses(obj) {
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DEVICE_SET_COM_PORT") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set pad type", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //search for api pads
        searchState = searchStates.search;
        api_search_for_pads();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DEVICE_GET_COUNT") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("The search for pads failed", obj);
            //search finished, reset search state
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //check for connected pads
        if (ret == 0) {
            //alert("No connected pads have been found.");
            //search finished, reset search state
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //get device info
        searchState = searchStates.getInfo;
        api_search_for_pads();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DEVICE_GET_INFO") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get device info", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //remember pad type, get image and get button size
        padType = parseInt(obj.TOKEN_PARAM_TYPE);
        switch (padType) {
            case padTypes.sigmaUSB:
            case padTypes.sigmaSerial:
                getBackgroundImage("Sigma");
                buttonSize = 36;
                buttonTop = 2;
                break;

            case padTypes.omegaUSB:
            case padTypes.omegaSerial:
                getBackgroundImage("Omega");
                buttonSize = 48;
                buttonTop = 4;
                break;

            case padTypes.gammaUSB:
            case padTypes.gammaSerial:
                getBackgroundImage("Gamma");
                buttonSize = 48;
                buttonTop = 4;
                break;

            case padTypes.deltaUSB:
            case padTypes.deltaSerial:
            case padTypes.deltaIP:
                getBackgroundImage("Delta");
                buttonSize = 48;
                buttonTop = 4;
                break;

            case padTypes.alphaUSB:
            case padTypes.alphaSerial:
            case padTypes.alphaIP:
                getBackgroundImage("Alpha");
                buttonSize = 80;
                buttonTop = 10;
                break;
        }

        //print device info
        //document.getElementById("PadType_0").innerHTML = getReadableType(padType);
        //document.getElementById("SerialNumber_0").innerHTML = obj.TOKEN_PARAM_SERIAL;

        //get firmware version
        searchState = searchStates.getVersion;
        api_search_for_pads();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DEVICE_GET_VERSION") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get device version", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //print firmware version
        //document.getElementById("FirmwareVersion_0").innerHTML = obj.TOKEN_PARAM_VERSION;

        //search finished, reset search state
        searchState = searchStates.setPadType;

        //try to open the connected pad
        api_device_open();
    }
    else {
        // do nothing
    }
}
// api search for pads end

// api device open begin
// TOKEN_CMD_API_DEVICE_OPEN and infos, properties (openStates states)
function api_device_open() {
    var message;

    switch (openState) {
        case openStates.openPad:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_OPEN", "TOKEN_PARAM_INDEX":"' + padIndex + '", "TOKEN_PARAM_ERASE_DISPLAY":"FALSE" }';
            break;

        case openStates.setColor:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_CONFIG_PEN' +
                '", "TOKEN_PARAM_WIDTH":"' + '3' +
                '", "TOKEN_PARAM_PEN_COLOR":"' + document.getElementById("signaturePenColorSelect").value +
                '" }';
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
            openState = openStates.openPad;
            //alert("invalid openState");
            return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function api_device_open_responses(obj) {
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DEVICE_OPEN") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to open pad", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            return;
        }

        padState = padStates.opened;

        // FIX: the whole pipeline (api_search_for_pads / api_device_open /
        // api_signature_start) only ever uses the API-mode functions, but
        // padMode was still left at its default value (Default = 0)
        // because ModeListName_onchange() is never called. Every function
        // that branches on padMode (retry/confirm/cancel/image/sign_data)
        // was sending the wrong (non-API) token as a result. Force it here.
        padMode = padModes.API;

        //set color
        openState = openStates.setColor;
        api_device_open();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_CONFIG_PEN") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set color", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //get display width
        openState = openStates.getDisplayWidth;
        api_device_open();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_GET_WIDTH") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get display width", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //set canvas width
        sigcanvas.width = ret;

        //get display height
        openState = openStates.getDisplayHeight;
        api_device_open();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_GET_HEIGHT") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get display height", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //set canvas height
        sigcanvas.height = ret;

        //get signature point resolution
        openState = openStates.getResolution;
        api_device_open();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_GET_RESOLUTION") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to get signature resolution", obj);
            searchState = searchStates.setPadType;
            openState = openStates.openPad;
            preparationState = preparationStates.setDisplayRotation;
            close_pad();
            return;
        }

        //get scale factor from siganture resolution to canvas
        scaleFactorX = sigcanvas.width / obj.TOKEN_PARAM_PAD_X_RESOLUTION;
        scaleFactorY = sigcanvas.height / obj.TOKEN_PARAM_PAD_Y_RESOLUTION;

        //reset open state
        openState = openStates.openPad;

        //start the signature process
        api_signature_start();
    }
    else {
        // do nothing
    }
}
// api device open end

// api signature start begin
// TOKEN_CMD_API_SIGNATURE_START (preparationStates states)
function api_signature_start() {
    var message;

    switch (preparationState) {
        case preparationStates.setDisplayRotation:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_ROTATION", "TOKEN_PARAM_ROTATION":"0" }';
            break;

        case preparationStates.getDisplayRotation:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_GET_ROTATION" }';
            break;

        case preparationStates.setBackgroundTarget:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TARGET", "TOKEN_PARAM_TARGET":"1" }';
            break;

        case preparationStates.setBackgroundImage:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_IMAGE", "TOKEN_PARAM_X_POS":"0", "TOKEN_PARAM_Y_POS":"0", "TOKEN_PARAM_BITMAP":"' + backgroundImage + '" }';
            break;

        case preparationStates.setCancelButton:
        case preparationStates.setRetryButton:
        case preparationStates.setConfirmButton:
            switch (preparationState) {
                case preparationStates.setCancelButton:
                    buttonDiff = sigcanvas.width / 3;
                    buttonLeft = (buttonDiff - buttonSize) / 2;
                    break;

                case preparationStates.setRetryButton:
                case preparationStates.setConfirmButton:
                    buttonLeft = buttonLeft + buttonDiff;
                    break;

                default:
                    preparationState = preparationStates.setDisplayRotation;
                    //alert("invalid preparationState");
                    return;
            }
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT", "TOKEN_PARAM_LEFT":"' + Math.round(buttonLeft) + '", "TOKEN_PARAM_TOP":"' + buttonTop + '", "TOKEN_PARAM_WIDTH":"' + buttonSize + '", "TOKEN_PARAM_HEIGHT":"' + buttonSize + '" }';
            break;

        case preparationStates.setSignRect:
            var top;
            switch (padType) {
                case padTypes.sigmaUSB:
                case padTypes.sigmaSerial:
                    top = 40;
                    break;

                case padTypes.omegaUSB:
                case padTypes.omegaSerial:
                case padTypes.gammaUSB:
                case padTypes.gammaSerial:
                case padTypes.deltaUSB:
                case padTypes.deltaSerial:
                case padTypes.deltaIP:
                    top = 56;
                    break;

                case padTypes.alphaUSB:
                case padTypes.alphaSerial:
                case padTypes.alphaIP:
                    top = 100;
                    break;

                default:
                    //alert("unkown pad type");
                    return;
            }
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SENSOR_SET_SIGN_RECT", "TOKEN_PARAM_LEFT":"0", "TOKEN_PARAM_TOP":"' + top + '", "TOKEN_PARAM_WIDTH":"0", "TOKEN_PARAM_HEIGHT":"0" }';
            break;

        case preparationStates.setFieldName:
            message = buildTextInRectMessage(getFieldNameRect(), PAD_FIELD_NAME_TEXT);
            if (message === null) {
                logMessage("!! unknown pad type " + padType + " (field name rect)");
                return;
            }
            break;

        case preparationStates.setCustomText:
            message = buildTextInRectMessage(getCustomTextRect(), PAD_CUSTOM_TEXT);
            if (message === null) {
                logMessage("!! unknown pad type " + padType + " (custom text rect)");
                return;
            }
            break;

        case preparationStates.setForegroundTarget:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_TARGET", "TOKEN_PARAM_TARGET":"0" }';
            break;

        case preparationStates.switchBuffers:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE", "TOKEN_PARAM_STORE_ID":"1" }';
            break;

        case preparationStates.startSignature:
            message = '{"TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_SIGNATURE_START" }';
            break;

        default:
            preparationState = preparationStates.setDisplayRotation;
            //alert("invalid preparationState");
            return;
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function api_signature_start_responses(obj) {
    // NOTE: responses belonging to an in-flight Undo repaint never reach
    // this function -- undoSync_handleResponse() consumes them in
    // onMessage() and returns. That is essential: the SET_IMAGE branch
    // below unconditionally restarts the preparation sequence, which is
    // fatal mid-session.
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_SET_ROTATION") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set background image", obj);
            close_pad();
            return;
        }

        //get display dotation
        preparationState = preparationStates.getDisplayRotation;
        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_GET_ROTATION") {
        var rotation = 0;
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set background image", obj);
            close_pad();
            return;
        }

        rotation = obj.TOKEN_PARAM_RETURN_CODE;

        //set background target
        preparationState = preparationStates.setBackgroundTarget;
        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_SET_TARGET") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set display target", obj);
            close_pad();
            return;
        }

        // set an image
        switch (preparationState) {
            case preparationStates.setBackgroundTarget:
                //set background image
                preparationState = preparationStates.setBackgroundImage;
                break;

            case preparationStates.setForegroundTarget:
                //switch buffers to display dialog
                preparationState = preparationStates.switchBuffers;
                break;

            default:
                preparationState = preparationStates.setDisplayRotation;
                //alert("invalid preparationState");
                return;
        }

        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_SET_IMAGE") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set background image", obj);
            close_pad();
            return;
        }

        //set cancel button
        preparationState = preparationStates.setCancelButton;
        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to add button", obj);
            close_pad();
            return;
        }

        // set the buttons
        switch (preparationState) {
            case preparationStates.setCancelButton:
                cancelButton = ret;
                // set retry button
                preparationState = preparationStates.setRetryButton;
                break;

            case preparationStates.setRetryButton:
                retryButton = ret;
                // set confirm button
                preparationState = preparationStates.setConfirmButton;
                break;

            case preparationStates.setConfirmButton:
                confirmButton = ret;
                // set signature rectangle
                preparationState = preparationStates.setSignRect;
                break;

            default:
                preparationState = preparationStates.setDisplayRotation;
                //alert("invalid preparationState");
                return;
        }

        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SENSOR_SET_SIGN_RECT") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set signature rectangle", obj);
            close_pad();
            return;
        }

        // set field name
        preparationState = preparationStates.setFieldName;
        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to set text", obj);
            close_pad();
            return;
        }

        switch (preparationState) {
            case preparationStates.setFieldName:
                // set custom text
                preparationState = preparationStates.setCustomText;
                break;

            case preparationStates.setCustomText:
                // set foreground target
                preparationState = preparationStates.setForegroundTarget;
                break;

            default:
                preparationState = preparationStates.setDisplayRotation;
                //alert("invalid preparationState");
                return;
        }

        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to switch buffers", obj);
            close_pad();
            return;
        }

        //start signing process
        preparationState = preparationStates.startSignature;
        api_signature_start();
    }
    else if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_SIGNATURE_START") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to start signing process", obj);
            close_pad();
            return;
        }

        // reset preparationState
        preparationState = preparationStates.setDisplayRotation;
    }
    else {
        // do nothing
    }
}
// api signature start end
// getSignatureAPI end

// selection dialog begin
// TOKEN_CMD_SELECTION_DIALOG
function selection_dialog() {
    if (padMode == padModes.Default) {
        // default mode
        var selectedElement = document.getElementById("check_boxes_selectedElements").value;
        if (selectedElement > 0) {
            var message = '{"TOKEN_TYPE": "TOKEN_TYPE_REQUEST",' +
                '"TOKEN_CMD": "TOKEN_CMD_SELECTION_DIALOG",' +
                '"TOKEN_PARAM_FIELD_LIST": [';
            for (i = 1; i <= selectedElement; i++) {
                message += '{"TOKEN_PARAM_FIELD_ID": "' + document.getElementById("fieldID" + i).value + '", ' +
                    '"TOKEN_PARAM_FIELD_TEXT": "' + document.getElementById("fieldText" + i).value + '", ' +
                    '"TOKEN_PARAM_FIELD_CHECKED": "' + document.getElementById("fieldChecked" + i).checked + '", ' +
                    '"TOKEN_PARAM_FIELD_REQUIRED": "' + document.getElementById("fieldRequired" + i).checked + '"}';
                if (i < selectedElement) {
                    message += ', ';
                }
            }
            message += ']}';
            signoPADAPIWeb.send(message);
            logMessage(message);
        }
        else {
            // start signature capture
            signature_start();
        }
    }
    else if (padMode == padModes.API) {
        // API mode
        // do nothing
    }
    else {
        //alert("invalid padMode");
        return;
    }
}

function selection_dialog_response(obj) {
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SELECTION_DIALOG") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to selection dialog process", obj);
            close_pad();
            return;
        }
    }
    else {
        // do nothing
    }
}
// selection dialog end

// signature start begin
// TOKEN_CMD_SIGNATURE_START
function signature_start() {
    var message;
    var dochash;

    switch (docHash) {
        case docHashes.kSha1:
            dochash = "AAECAwQFBgcICQoLDA0ODxAREhM=";
            break;

        case docHashes.kSha256:
            dochash = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
            break;

        default:
            //alert("unknown doc hash");
            return;
    }

    if (supportsRSA) {
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_START", "TOKEN_PARAM_FIELD_NAME":"' + field_name +
            '", "TOKEN_PARAM_CUSTOM_TEXT":"' + custom_text +
            '", "TOKEN_PARAM_PAD_ENCRYPTION":"' + encryption +
            '", "TOKEN_PARAM_DOCHASH":"' + dochash +
            '", "TOKEN_PARAM_ENCRYPTION_CERT":"' + encryption_cert +
            '" }';
    }
    else {
        message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_SIGNATURE_START", "TOKEN_PARAM_FIELD_NAME":"' + field_name +
            '", "TOKEN_PARAM_CUSTOM_TEXT":"' + custom_text +
            '" }';
    }
    signoPADAPIWeb.send(message);
    logMessage(message);
}

function signature_start_response(obj) {
    if (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_SIGNATURE_START") {
        //check the return code
        var ret = obj.TOKEN_PARAM_RETURN_CODE;
        if (ret < 0) {
            logResponseError("Failed to start signature process", obj);
            close_pad();
            return;
        }
    }
    else {
        // do nothing
    }
}
// signature start end

// close pad begin
// TOKEN_CMD_CLOSE_PAD and TOKEN_CMD_API_DEVICE_CLOSE
function close_pad() {
//debugger
    var message;
    if (padState == padStates.opened) {
        if (padMode == padModes.Default) {
            // default mode
            message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_CLOSE_PAD", "TOKEN_PARAM_PAD_INDEX":"' + padIndex + '" }';
        }
        else if (padMode == padModes.API) {
            // API mode
            message = '{ "TOKEN_TYPE":"TOKEN_TYPE_REQUEST", "TOKEN_CMD":"TOKEN_CMD_API_DEVICE_CLOSE", "TOKEN_PARAM_INDEX":"' + padIndex + '" }';
        }
        else {
            //alert("invalid padMode");
            return;
        }
        signoPADAPIWeb.send(message);
        logMessage(message);
    }
}

function close_pad_response(obj) {
    // close default and api pad
    if ((obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_CLOSE_PAD") || (obj.TOKEN_CMD_ORIGIN == "TOKEN_CMD_API_DEVICE_CLOSE")) {
        searchState = searchStates.setPadType;
        openState = openStates.openPad;
        preparationState = preparationStates.setDisplayRotation;
        if (padState != padStates.closed) {
            //check the return code
            var ret = obj.TOKEN_PARAM_RETURN_CODE;
            if (ret < 0) {
                //alert("Failed to close pad. Reason: " + obj.TOKEN_PARAM_ERROR_DESCRIPTION);
                return;
            }
        }

        padState = padStates.closed;
    }
    else {
        // do nothing
    }
}
// close pad end

function getBackgroundImage(padName) {
    var img = new Image();
    img.setAttribute('crossOrigin', 'anonymous');
    img.onload = function () {
        var sigcanvas = document.createElement("canvas");
        sigcanvas.width = this.width;
        sigcanvas.height = this.height;

        var ctx = sigcanvas.getContext("2d");
        ctx.drawImage(this, 0, 0);

        var dataURL = sigcanvas.toDataURL("image/png");
        backgroundImage = dataURL.replace(/^data:image\/(png|jpg);base64,/, "");
        // keep a pristine copy: Undo always composites strokes onto this
        // ORIGINAL template, never onto a previous composite, so nothing
        // ever accumulates or gets double-drawn
        originalBackgroundImage = backgroundImage;
    };
    var element = document.getElementById(padName);
    img.src = element.src;
}

function check_boxes_selectedElements_onchange() {
    var sender = document.getElementById("check_boxes_selectedElements");
    var selectedElem = sender.value;
    var elemCount = sender.childElementCount;

    for (i = 1; i < elemCount; i++) {
        document.getElementById("fieldNumber" + i).style.visibility = 'hidden';
        document.getElementById("fieldID" + i).style.visibility = 'hidden';
        document.getElementById("fieldText" + i).style.visibility = 'hidden';
        document.getElementById("fieldChecked" + i).style.visibility = 'hidden';
        document.getElementById("fieldRequired" + i).style.visibility = 'hidden';
    }

    for (i = 1; i <= selectedElem; i++) {
        document.getElementById("fieldNumber" + i).style.visibility = 'visible';
        document.getElementById("fieldID" + i).style.visibility = 'visible';
        document.getElementById("fieldText" + i).style.visibility = 'visible';
        document.getElementById("fieldChecked" + i).style.visibility = 'visible';
        document.getElementById("fieldRequired" + i).style.visibility = 'visible';
    }
}

function ModeListName_onchange() {
    //var sender = document.getElementById("ModeList");
    var selectedElem = "API";

    // the signature pen color select
    //var scl = 1;
    var spcs = document.getElementById("signaturePenColorSelect");
    spcs.selectedIndex = 0;

    // the check boxes select
    var cbsEL = document.getElementById("check_boxes_selectedElementsLabel");
    var cbsE = document.getElementById("check_boxes_selectedElements");
    var elemCount = cbsE.childElementCount;

    switch (selectedElem) {
        case MODE_LIST_DEFAULT:
            // disable the signature pen color select
            //scl.disabled = true;
            spcs.disabled = true;

            // enable the check boxes select and table elements
            cbsEL.disabled = false;
            cbsE.disabled = false;
            for (i = 1; i < elemCount; i++) {
                document.getElementById("fieldNumber" + i).disabled = false;
                document.getElementById("fieldID" + i).disabled = false;
                document.getElementById("fieldText" + i).disabled = false;
                document.getElementById("fieldChecked" + i).disabled = false;
                document.getElementById("fieldRequired" + i).disabled = false;
            }
            padMode = padModes.Default;
            break;

        case MODE_LIST_API:
            // enable the signature pen color select
            //scl.disabled = false;
            spcs.disabled = false;

            // disable the check boxes select and table elements
            cbsEL.disabled = true;
            cbsE.disabled = true;
            for (i = 1; i < elemCount; i++) {
                document.getElementById("fieldNumber" + i).disabled = true;
                document.getElementById("fieldID" + i).disabled = true;
                document.getElementById("fieldText" + i).disabled = true;
                document.getElementById("fieldChecked" + i).disabled = true;
                document.getElementById("fieldRequired" + i).disabled = true;
            }
            padMode = padModes.API;
            break;

        default:
            //alert("invalid padMode");
            break;
    }
}

function getReadableType(intTypeNumber) {
    switch (intTypeNumber) {
        case padTypes.sigmaUSB:
            return "Sigma USB";
        case padTypes.sigmaSerial:
            return "Sigma seriell";
        case padTypes.omegaUSB:
            return "Omega USB";
        case padTypes.omegaSerial:
            return "Omega seriell";
        case padTypes.gammaUSB:
            return "Gamma USB";
        case padTypes.gammaSerial:
            return "Gamma seriell";
        case padTypes.deltaUSB:
            return "Delta USB";
        case padTypes.deltaSerial:
            return "Delta seriell";
        case padTypes.deltaIP:
            return "Delta IP";
        case padTypes.alphaUSB:
            return "Alpha USB";
        case padTypes.alphaSerial:
            return "Alpha seriell";
        case padTypes.alphaIP:
            return "Alpha IP";
        default:
            return "Unknown";
    }
}

function clearSignature() {
    //document.getElementById("ModeList").selectedIndex = 0;
    //document.getElementById("PadConnectionTypeList").selectedIndex = 0;
    //document.getElementById("SignData_0").value = "";
}

function onMessage(event) {

    

    logMessage(event.data);

    var obj = JSON.parse(event.data);

    // The Undo repaint state machine gets FIRST refusal on every response.
    // If it owns the response we return immediately, so it can never reach
    // the preparation handlers below (api_signature_start_responses() would
    // otherwise treat our SET_IMAGE/SET_TARGET replies as part of the
    // one-time prep sequence and restart it mid-session -- the actual cause
    // of the blank screen + closed session seen previously).
    if (obj.TOKEN_TYPE == "TOKEN_TYPE_RESPONSE" && undoSync_handleResponse(obj)) {
        return;
    }

    if (obj.TOKEN_TYPE == "TOKEN_TYPE_SEND") {

        // the send events

        switch (obj.TOKEN_CMD) {
            case "TOKEN_CMD_SELECTION_CONFIRM":
                // confirm selecting process
                selection_confirm_send();
                break;
            case "TOKEN_CMD_SELECTION_CHANGE":
                // change selecting process
                selection_change_send(obj.TOKEN_PARAM_FIELD_ID, obj.TOKEN_PARAM_FIELD_CHECKED);
                break;
            case "TOKEN_CMD_SELECTION_CANCEL":
                // cancel selecting process
                selection_cancel_send();
                break;
            case "TOKEN_CMD_SIGNATURE_CONFIRM":
                // confirm signing process
                signature_confirm_send();
                break;
            case "TOKEN_CMD_SIGNATURE_RETRY":
                // restart signing process
                signature_retry_send();
                break;
            case "TOKEN_CMD_SIGNATURE_CANCEL":
                // cancel signing process
                signature_cancel_send();
                break;
            case "TOKEN_CMD_SIGNATURE_POINT":
                // draw the points
                signature_point_send(obj.TOKEN_PARAM_POINT.x, obj.TOKEN_PARAM_POINT.y, obj.TOKEN_PARAM_POINT.p)
                break;
            case "TOKEN_CMD_DISCONNECT":
                //the opened pad has been disconnected
                disconnect_send(obj.TOKEN_PARAM_PAD_INDEX)
                break;
            case "TOKEN_CMD_ERROR":
                // an error has happened
                error_send(obj.TOKEN_PARAM_ERROR_CONTEXT, obj.TOKEN_PARAM_RETURN_CODE, obj.TOKEN_PARAM_ERROR_DESCRIPTION);
                break;
            case "TOKEN_CMD_API_SENSOR_HOT_SPOT_PRESSED":
                // a hot spot has been pressed
                api_sensor_hot_spot_pressed_send(obj.TOKEN_PARAM_HOTSPOT_ID);
                break;
            case "TOKEN_CMD_API_DISPLAY_SCROLL_POS_CHANGED":
                // the display scroll pos was changed
                api_display_scroll_pos_changed_send(obj.TOKEN_PARAM_X_POS, obj.TOKEN_PARAM_Y_POS);
                break;
            default:
                //alert("Unknown token for send events. Token: " + obj.TOKEN_CMD);
                break;
        }
    }
    else if (obj.TOKEN_TYPE == "TOKEN_TYPE_RESPONSE") {

        // the responses for requests

        switch (obj.TOKEN_CMD_ORIGIN) {
            case "TOKEN_CMD_SEARCH_FOR_PADS":
            case "TOKEN_CMD_OPEN_PAD":
            case "TOKEN_CMD_SIGNATURE_START":

            case "TOKEN_CMD_API_DEVICE_SET_COM_PORT":
            case "TOKEN_CMD_API_DEVICE_GET_COUNT":
            case "TOKEN_CMD_API_DEVICE_GET_INFO":
            case "TOKEN_CMD_API_DEVICE_GET_VERSION":

            case "TOKEN_CMD_API_DEVICE_OPEN":
            case "TOKEN_CMD_API_DISPLAY_CONFIG_PEN":
            case "TOKEN_CMD_API_DISPLAY_GET_WIDTH":
            case "TOKEN_CMD_API_DISPLAY_GET_HEIGHT":
            case "TOKEN_CMD_API_SIGNATURE_GET_RESOLUTION":

            case "TOKEN_CMD_API_DISPLAY_SET_ROTATION":
            case "TOKEN_CMD_API_DISPLAY_GET_ROTATION":
            case "TOKEN_CMD_API_DISPLAY_SET_TARGET":
            case "TOKEN_CMD_API_DISPLAY_SET_IMAGE":
            case "TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT":
            case "TOKEN_CMD_API_SENSOR_SET_SIGN_RECT":
            case "TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT":
            case "TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE":
            case "TOKEN_CMD_API_SIGNATURE_START":

            case "TOKEN_CMD_SIGNATURE_CONFIRM":
            case "TOKEN_CMD_API_SIGNATURE_CONFIRM":
            case "TOKEN_CMD_SIGNATURE_RETRY":
            case "TOKEN_CMD_API_SIGNATURE_RETRY":
            case "TOKEN_CMD_SIGNATURE_CANCEL":
            case "TOKEN_CMD_API_SIGNATURE_CANCEL":
            case "TOKEN_CMD_SIGNATURE_IMAGE":
            case "TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX":
            case "TOKEN_CMD_SIGNATURE_SIGN_DATA":
            case "TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA":
            case "TOKEN_CMD_CLOSE_PAD":
            case "TOKEN_CMD_API_DEVICE_CLOSE":

            case "TOKEN_CMD_SELECTION_DIALOG":
//debugger
                // responses from default pad
                search_for_pads_response(obj);
                open_pad_response(obj);
                signature_start_response(obj);

                // responses from api pad
                api_search_for_pads_responses(obj);
                api_device_open_responses(obj);
                api_signature_start_responses(obj);

                // responses from both pads
                signature_confirm_response(obj);
                signature_retry_response(obj);
                signature_cancel_response(obj);
                signature_image_response(obj);
                signature_sign_data_response(obj);
                close_pad_response(obj);

                // responses from selection dialog
                selection_dialog_response(obj);

                break;
            default:
                //alert("Unknown response token. Token: " + obj.TOKEN_CMD_ORIGIN);
                break;
        }
    }
    else {
        //alert("Unknown type token. Token: " + obj.TOKEN_TYPE);
    }
}
