// Verifies the image that actually gets sent to the pad after an Undo.
//
//   node test/verify-pad-image.js
//
// The simulate-pad.js suite checks the command sequence. This one checks the
// pixels: it runs signotec_final.js in a real browser with a real canvas,
// draws three strokes in three separate bands of the signature area, presses
// the Retry hot spot, captures the base64 PNG the code puts in
// TOKEN_PARAM_BITMAP, and counts the ink in each band.
//
// The last stroke's band must be empty and the other two must be untouched.
//
// It also writes the captured images to test/output/ so the repaint can be
// looked at directly:
//
//   pad-before-undo.png   what the pad shows after three strokes
//   pad-after-undo.png    what this code sends to the pad after Undo
//
// This does not prove the firmware accepts the image. It proves the image is
// correct.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const FILE = path.join(__dirname, '..', 'signotec_final.js');
const OUT = path.join(__dirname, 'output');

const DISPLAY_W = 640;
const DISPLAY_H = 480;
const RES_X = 2540;
const RES_Y = Math.round(2540 * DISPLAY_H / DISPLAY_W);
const SIGN_TOP = 56;          // matches the Omega profile's signRectTop

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + name +
                (ok ? '' : '\n        ' + detail));
    if (!ok) failures++;
}

const PAGE = `
<canvas id="sigCanvas"></canvas>
<div id="status"></div>
<ul id="log"></ul>
<select id="signaturePenColorSelect"><option value="#FF0000" selected>red</option></select>
<img id="Omega">
<script>
// ---- a template that looks like the real one: white, framed, with a
// ---- signature box, so the composite has something to preserve
(function () {
    const c = document.createElement('canvas');
    c.width = ${DISPLAY_W}; c.height = ${DISPLAY_H};
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = '#000000'; x.lineWidth = 2;
    x.strokeRect(8, ${SIGN_TOP}, c.width - 16, c.height - ${SIGN_TOP} - 8);
    x.fillStyle = '#000000'; x.fillRect(10, 10, 40, 30);   // a button graphic
    document.getElementById('Omega').src = c.toDataURL('image/png');
}());

// ---- a fake pad on the other end of the socket
window.capturedBitmaps = [];
window.sentCommands = [];
let hotspotId = 0;

window.WebSocket = class {
    constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen({ target: { url: 'wss://fake' } }); }, 0); }
    send(raw) {
        const o = JSON.parse(raw);
        window.sentCommands.push(o.TOKEN_CMD);
        if (o.TOKEN_CMD === 'TOKEN_CMD_API_DISPLAY_SET_IMAGE') {
            window.capturedBitmaps.push(o.TOKEN_PARAM_BITMAP);
        }
        setTimeout(() => this.reply(o.TOKEN_CMD), 0);
    }
    reply(cmd) {
        // every numeric field as a string, exactly as the hardware sends them.
        // a switch, not an object literal: the literal would run hotspotId++
        // for every response, whatever the command.
        let extra = {};
        switch (cmd) {
            case 'TOKEN_CMD_API_DEVICE_GET_COUNT':   extra = { TOKEN_PARAM_RETURN_CODE: '1' }; break;
            case 'TOKEN_CMD_API_DEVICE_GET_INFO':    extra = { TOKEN_PARAM_TYPE: '11', TOKEN_PARAM_SERIAL: 'SN' }; break;
            case 'TOKEN_CMD_API_DEVICE_GET_VERSION': extra = { TOKEN_PARAM_VERSION: '1.0' }; break;
            case 'TOKEN_CMD_API_DISPLAY_GET_WIDTH':  extra = { TOKEN_PARAM_RETURN_CODE: '${DISPLAY_W}' }; break;
            case 'TOKEN_CMD_API_DISPLAY_GET_HEIGHT': extra = { TOKEN_PARAM_RETURN_CODE: '${DISPLAY_H}' }; break;
            case 'TOKEN_CMD_API_SIGNATURE_GET_RESOLUTION':
                extra = { TOKEN_PARAM_PAD_X_RESOLUTION: '${RES_X}', TOKEN_PARAM_PAD_Y_RESOLUTION: '${RES_Y}' }; break;
            case 'TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT':
                extra = { TOKEN_PARAM_RETURN_CODE: String(hotspotId++) }; break;
        }

        this.onmessage({ data: JSON.stringify(Object.assign(
            { TOKEN_TYPE: 'TOKEN_TYPE_RESPONSE', TOKEN_CMD_ORIGIN: cmd, TOKEN_PARAM_RETURN_CODE: '0' },
            extra)) });
    }
};

// ---- helpers the test driver calls
window.penDown = (x, y) => onMessage({ data: JSON.stringify({ TOKEN_TYPE: 'TOKEN_TYPE_SEND',
    TOKEN_CMD: 'TOKEN_CMD_SIGNATURE_POINT', TOKEN_PARAM_POINT: { x: String(x), y: String(y), p: '0' } }) });
window.penMove = (x, y) => onMessage({ data: JSON.stringify({ TOKEN_TYPE: 'TOKEN_TYPE_SEND',
    TOKEN_CMD: 'TOKEN_CMD_SIGNATURE_POINT', TOKEN_PARAM_POINT: { x: String(x), y: String(y), p: '512' } }) });
window.pressHotSpot = (id) => onMessage({ data: JSON.stringify({ TOKEN_TYPE: 'TOKEN_TYPE_SEND',
    TOKEN_CMD: 'TOKEN_CMD_API_SENSOR_HOT_SPOT_PRESSED', TOKEN_PARAM_HOTSPOT_ID: String(id) }) });

// display pixels -> the signature coordinates the pad reports.
// x and y have their own scale factors, exactly as the code computes them.
window.toSignatureX = (px) => Math.round(px / (${DISPLAY_W} / ${RES_X}));
window.toSignatureY = (px) => Math.round(px / (${DISPLAY_H} / ${RES_Y}));

// counts non-white pixels per horizontal band of a base64 PNG
window.inkPerBand = (base64, bands) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const counts = bands.map(([top, bottom]) => {
            const d = x.getImageData(0, top, c.width, bottom - top).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
            }
            return n;
        });
        resolve({ width: img.width, height: img.height, counts });
    };
    img.src = 'data:image/png;base64,' + base64;
});
</script>
`;

(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    // this environment ships its own Chromium; PLAYWRIGHT_CHROMIUM can point
    // elsewhere, and an unset path falls back to Playwright's own download
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM ||
        (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    const browser = await chromium.launch(executablePath ? { executablePath } : {});
    const page = await browser.newPage();

    page.on('pageerror', (e) => { console.log('  \x1b[31mPAGE ERROR\x1b[0m ' + e.message); failures++; });

    await page.setContent(PAGE);
    await page.addScriptTag({ path: FILE });
    await page.waitForFunction(() => document.getElementById('Omega').complete);

    await page.evaluate(() => { onMainWindowLoad(); getSignature(); });
    await page.waitForFunction(() => window.sentCommands.includes('TOKEN_CMD_API_SIGNATURE_START'),
                               null, { timeout: 5000 });

    console.log('\n\x1b[1mPreparation\x1b[0m');
    const prep = await page.evaluate(() => ({
        strokes: signatureStrokes.length,
        retry: retryButton,
        canvas: [sigcanvas.width, sigcanvas.height],
        template: [backgroundImageWidth, backgroundImageHeight],
        bitmaps: window.capturedBitmaps.length
    }));
    check('canvas sized to the display', prep.canvas.join('x') === `${DISPLAY_W}x${DISPLAY_H}`, prep.canvas.join('x'));
    check('template matches the display', prep.template.join('x') === `${DISPLAY_W}x${DISPLAY_H}`, prep.template.join('x'));
    const counts = await page.evaluate(() => ({
        addHotSpot: window.sentCommands.filter((c) => c === 'TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT').length,
        starts:     window.sentCommands.filter((c) => c === 'TOKEN_CMD_API_SIGNATURE_START').length,
        all:        window.sentCommands.length
    }));
    check('preparation ran exactly once',
          counts.addHotSpot === 3 && counts.starts === 1,
          counts.addHotSpot + ' hot spots, ' + counts.starts + ' SIGNATURE_START, ' +
          counts.all + ' commands total');
    check('retry is the middle hot spot', prep.retry === 1, String(prep.retry));

    const bandHeight = Math.floor((DISPLAY_H - SIGN_TOP) / 3);
    const bands = [0, 1, 2].map((i) => [SIGN_TOP + i * bandHeight + 10,
                                        SIGN_TOP + (i + 1) * bandHeight - 10]);

    // the template's own ink per band: the frame runs through every band, so
    // an "erased" band still contains that much and not zero
    const baseline = await page.evaluate(({ bands }) => new Promise((resolve) => {
        buildCompositeImage((b64) => window.inkPerBand(b64, bands).then(resolve));
    }), { bands });

    // three strokes, one per band of the signature area

    await page.evaluate(({ bands }) => {
        bands.forEach(([top, bottom]) => {
            const y = Math.round((top + bottom) / 2);
            window.penDown(window.toSignatureX(100), window.toSignatureY(y));
            for (let x = 120; x <= 520; x += 20) {
                window.penMove(window.toSignatureX(x), window.toSignatureY(y));
            }
        });
    }, { bands });

    console.log('\n\x1b[1mThree strokes captured\x1b[0m');
    const drawn = await page.evaluate(() => signatureStrokes.map((s) => s.points.length));
    check('three separate strokes', drawn.length === 3, 'got ' + drawn.length + ': ' + drawn.join('/'));
    check('every stroke kept its points', drawn.every((n) => n === 22), drawn.join('/'));

    // the state before undo, rendered the same way the pad would see it
    const before = await page.evaluate(({ bands }) => new Promise((resolve) => {
        buildCompositeImage((b64) => window.inkPerBand(b64, bands).then((r) => resolve({ b64, r })));
    }), { bands });
    fs.writeFileSync(path.join(OUT, 'pad-before-undo.png'), Buffer.from(before.b64, 'base64'));

    check('each band gained a stroke over the bare template',
          before.r.counts.every((n, i) => n - baseline.counts[i] > 1000),
          'template ' + baseline.counts.join('/') + ' -> drawn ' + before.r.counts.join('/'));

    // ---- Undo -------------------------------------------------------------
    await page.evaluate(() => { window.capturedBitmaps = []; window.pressHotSpot(retryButton); });
    await page.waitForFunction(() => undoState === undoStates.idle && window.capturedBitmaps.length > 0,
                               null, { timeout: 5000 });

    console.log('\n\x1b[1mAfter pressing Retry\x1b[0m');
    const after = await page.evaluate(({ bands }) => window
        .inkPerBand(window.capturedBitmaps[window.capturedBitmaps.length - 1], bands)
        .then((r) => ({ r, strokes: signatureStrokes.length,
                        bitmap: window.capturedBitmaps[window.capturedBitmaps.length - 1],
                        commands: window.sentCommands.slice(-6) })), { bands });
    fs.writeFileSync(path.join(OUT, 'pad-after-undo.png'), Buffer.from(after.bitmap, 'base64'));

    check('two strokes left in memory', after.strokes === 2, 'got ' + after.strokes);
    check('an image was sent to the pad', after.r.width === DISPLAY_W && after.r.height === DISPLAY_H,
          after.r.width + 'x' + after.r.height);

    const [b1, b2, b3] = after.r.counts;
    const [o1, o2, o3] = before.r.counts;

    check('band 3 is back to the bare template: the last stroke is gone',
          b3 === baseline.counts[2], 'template has ' + baseline.counts[2] + ', image has ' + b3);
    check('band 1 (first stroke) is untouched', b1 === o1, o1 + ' -> ' + b1);
    check('band 2 (second stroke) is untouched', b2 === o2, o2 + ' -> ' + b2);

    // the frame and button graphics from the template must survive the repaint
    const chrome = await page.evaluate((b64) => window.inkPerBand(b64, [[0, 56]]), after.bitmap);
    check('template chrome preserved', chrome.counts[0] > 0, 'the header area came back blank');

    console.log('\n\x1b[1mInk per band\x1b[0m');
    console.log('  bare template:  ' + baseline.counts.join('  |  '));
    console.log('  three strokes:  ' + before.r.counts.join('  |  '));
    console.log('  after undo:     ' + after.r.counts.join('  |  '));
    console.log('\n  images written to ' + path.relative(process.cwd(), OUT));

    await browser.close();

    console.log('\n' + (failures === 0
        ? '\x1b[32mALL CHECKS PASSED\x1b[0m'
        : '\x1b[31m' + failures + ' CHECK(S) FAILED\x1b[0m'));
    process.exit(failures ? 1 : 0);
})();
