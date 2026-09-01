// Simulated signotec pad + minimal DOM, driving signotec_final.js end to end.
//
//   node test/simulate-pad.js
//
// Covers preparation, stroke capture, Undo (including a pad that rejects a
// command, one that never answers, and two presses in quick succession),
// Confirm, Cancel, and malformed input. Exits non-zero on any failure.
//
// This is not a substitute for testing on real hardware: it verifies the
// command sequences and the state machine, not the firmware's reaction.
const fs = require('fs');
const PATH = require('path').join(__dirname, '..', 'signotec_final.js');

let sent = [], deviceOpen = false, failAt = null, dropReplyFor = null;
let hideCanvas = false;
const elements = {};
const el = (id, extra) => (elements[id] ||= Object.assign({
  id, value: '', src: id + '.png', checked: false, disabled: false,
  innerHTML: '', className: '', style: {}, selectedIndex: 0,
  childElementCount: 3, scrollTop: 0, scrollHeight: 0,
  appendChild(){}, click(){}
}, extra || {}));

const ctxStub = () => new Proxy({}, {
  get: (t,k) => (k in t ? t[k] : () => {}),
  set: (t,k,v) => { t[k] = v; return true; }
});
const canvasStub = () => ({ width: 640, height: 480, getContext: ctxStub,
                            toDataURL: () => 'data:image/png;base64,Q09NUE9TSVRF' });

global.document = {
  getElementById: (id) => (id === 'sigCanvas'
    ? (hideCanvas ? null : el(id, canvasStub()))
    : el(id)),
  createElement: (t) => (t === 'canvas' ? canvasStub() : { textContent:'', appendChild(){}, style:{} })
};
global.window = { WebSocket: function(){} };
global.Image = class {
  setAttribute(){}
  set src(v){ this._src = v; setTimeout(() => this.onload && this.onload.call({width:640,height:480}), 0); }
  get src(){ return this._src; }
};
let jqCalls = [];
global.$ = (sel) => ({ hide(){}, click(){ jqCalls.push(sel); }, fadeOut(){ jqCalls.push(sel); } });

const realLog = console.log.bind(console);
let logLines = [];
global.console = { log: (m) => { logLines.push(String(m)); } };

let socketOpenDelay = 0;
global.WebSocket = class {
  constructor(){
    this.readyState = 0;                       // CONNECTING
    setTimeout(() => { this.readyState = 1;    // OPEN
      this.onopen && this.onopen({ target:{ url:'wss://x' } }); }, socketOpenDelay);
  }
  send(msg){ const o = JSON.parse(msg); sent.push(o.TOKEN_CMD); setTimeout(() => respond(o), 0); }
};

let src = fs.readFileSync(PATH, 'utf8');
src += '\n;globalThis.__peek = () => ({ signatureStrokes, lastSignatureImage, backgroundImage });\n';
(0, eval)(src);
const peek = () => __peek();

const reply = (origin, extra) => onMessage({ data: JSON.stringify(
  Object.assign({ TOKEN_TYPE:'TOKEN_TYPE_RESPONSE', TOKEN_CMD_ORIGIN:origin,
                  TOKEN_PARAM_RETURN_CODE:0 }, extra || {})) });

let hotspotId = 0;
function respond(o) {
  const c = o.TOKEN_CMD;
  if (dropReplyFor === c) { dropReplyFor = null; return; }          // simulate a lost reply
  if (failAt === c) { failAt = null;
    return reply(c, { TOKEN_PARAM_RETURN_CODE:-42, TOKEN_PARAM_ERROR_DESCRIPTION:'simulated failure' }); }
  switch (c) {
    case 'TOKEN_CMD_API_DEVICE_GET_COUNT':   return reply(c, { TOKEN_PARAM_RETURN_CODE:1 });
    case 'TOKEN_CMD_API_DEVICE_GET_INFO':    return reply(c, { TOKEN_PARAM_TYPE:'11', TOKEN_PARAM_SERIAL:'SN-1',
                                                               TOKEN_PARAM_CAPABILITIES:0x40 });
    case 'TOKEN_CMD_API_DEVICE_GET_VERSION': return reply(c, { TOKEN_PARAM_VERSION:'2.3.1' });
    case 'TOKEN_CMD_API_DEVICE_OPEN':        deviceOpen = true; return reply(c);
    case 'TOKEN_CMD_API_DISPLAY_GET_WIDTH':  return reply(c, { TOKEN_PARAM_RETURN_CODE:640 });
    case 'TOKEN_CMD_API_DISPLAY_GET_HEIGHT': return reply(c, { TOKEN_PARAM_RETURN_CODE:480 });
    case 'TOKEN_CMD_API_SIGNATURE_GET_RESOLUTION':
      return reply(c, { TOKEN_PARAM_PAD_X_RESOLUTION:2540, TOKEN_PARAM_PAD_Y_RESOLUTION:2540 });
    case 'TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT': return reply(c, { TOKEN_PARAM_RETURN_CODE:hotspotId++ });
    case 'TOKEN_CMD_API_DEVICE_CLOSE':       deviceOpen = false; return reply(c);
    default: return reply(c);
  }
}

const wait  = (ms=80) => new Promise(r => setTimeout(r, ms));
const point = (x,y,p) => onMessage({ data: JSON.stringify({ TOKEN_TYPE:'TOKEN_TYPE_SEND',
  TOKEN_CMD:'TOKEN_CMD_SIGNATURE_POINT', TOKEN_PARAM_POINT:{x,y,p} }) });
const strokeOf = (n, base) => { for (let i=0;i<n;i++) point(base+i, base+i, i===0?0:100); };
const press = (id) => onMessage({ data: JSON.stringify({ TOKEN_TYPE:'TOKEN_TYPE_SEND',
  TOKEN_CMD:'TOKEN_CMD_API_SENSOR_HOT_SPOT_PRESSED', TOKEN_PARAM_HOTSPOT_ID:id }) });

let fails = 0, group = '';
const section = (t) => { group = t; realLog('\n\x1b[1m' + t + '\x1b[0m'); };
function check(name, cond, detail) {
  realLog((cond ? '  \x1b[32mPASS\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + name +
          (cond ? '' : '\n        ' + detail));
  if (!cond) fails++;
}
const seq = () => JSON.stringify(sent);
const UNDO_SEQ = JSON.stringify([
  'TOKEN_CMD_API_SIGNATURE_RETRY', 'TOKEN_CMD_API_DISPLAY_SET_TARGET',
  'TOKEN_CMD_API_DISPLAY_SET_IMAGE', 'TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT',
  'TOKEN_CMD_API_DISPLAY_SET_TEXT_IN_RECT', 'TOKEN_CMD_API_DISPLAY_SET_TARGET',
  'TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE']);

async function fullSession() {
  sent = []; hotspotId = 0; logLines = []; jqCalls = [];
  signoPADAPIWeb = null;
  onMainWindowLoad(); await wait();
  getSignature();     await wait(500);
}

(async () => {
  const T = setTimeout(() => { realLog('\n\x1b[31mHUNG\x1b[0m in section: ' + group); process.exit(2); }, 45000);
  section('Preparation');
  await fullSession();
  check('pad opened',            deviceOpen && padState === padStates.opened, 'padState=' + padState);
  check('SIGNATURE_START sent',  sent.includes('TOKEN_CMD_API_SIGNATURE_START'), seq());
  check('background loaded',     peek().backgroundImage !== null, 'null');
  check('hot spot ids assigned', cancelButton===0 && retryButton===1 && confirmButton===2,
        `${cancelButton}/${retryButton}/${confirmButton}`);
  check('no errors logged',      !logLines.some(l => l.includes('!!')),
        logLines.filter(l => l.includes('!!')).join('\n        '));
  const prepState = preparationState;

  section('Undo removes one stroke and repaints the pad');
  strokeOf(5,100); strokeOf(5,200); strokeOf(5,300);
  check('3 strokes captured', peek().signatureStrokes.length === 3, 'got ' + peek().signatureStrokes.length);
  sent = []; press(retryButton); await wait(400);
  check('one stroke removed',        peek().signatureStrokes.length === 2, 'got ' + peek().signatureStrokes.length);
  check('exact 7-command sequence',  seq() === UNDO_SEQ, seq());
  const targets = logLines.filter(l => l.startsWith('[signotec] >>') && l.includes('DISPLAY_SET_TARGET'))
                          .map(l => l.match(/TARGET":"(\d)"/)[1]);
  check('undo writes to store 1, then back to display 0',
        targets.slice(-2).join('') === '10', 'targets seen: ' + targets.join(''));
  check('preparation never re-entered',
        preparationState === prepState && !sent.includes('TOKEN_CMD_API_SENSOR_ADD_HOT_SPOT'), 'state moved');
  check('session still open',        deviceOpen && !sent.includes('TOKEN_CMD_API_DEVICE_CLOSE'), 'closed');
  check('machine back to idle',      undoState === undoStates.idle, 'undoState=' + undoState);

  section('Pad rejects SET_IMAGE mid-undo');
  sent = []; failAt = 'TOKEN_CMD_API_DISPLAY_SET_IMAGE';
  press(retryButton); await wait(400);
  check('stroke still removed locally', peek().signatureStrokes.length === 1, 'got ' + peek().signatureStrokes.length);
  check('session survives',             deviceOpen && !sent.includes('TOKEN_CMD_API_DEVICE_CLOSE'), 'pad closed!');
  check('error has code + description',
        logLines.some(l => l.includes('RETURN_CODE=-42') && l.includes('simulated failure')), 'not logged');
  check('machine reset',                undoState === undoStates.idle, 'undoState=' + undoState);

  section('Pad never answers (timeout)');
  const savedTimeout = UNDO_TIMEOUT_MS; UNDO_TIMEOUT_MS = 120;
  strokeOf(4,400); sent = []; dropReplyFor = 'TOKEN_CMD_API_SIGNATURE_RETRY';
  press(retryButton); await wait(400);
  check('aborts on timeout',  undoState === undoStates.idle, 'undoState=' + undoState);
  check('timeout is logged',  logLines.some(l => l.includes('timed out')), 'no timeout line');
  check('session survives',   deviceOpen && padState === padStates.opened, 'pad closed');
  UNDO_TIMEOUT_MS = savedTimeout;

  section('Rapid double press coalesces');
  strokeOf(3,500); strokeOf(3,600);
  const before = peek().signatureStrokes.length;
  sent = []; press(retryButton); press(retryButton); await wait(600);
  check('both strokes removed', peek().signatureStrokes.length === before - 2, 'got ' + peek().signatureStrokes.length);
  check('two syncs ran, serialised',
        sent.filter(c => c === 'TOKEN_CMD_API_DISPLAY_SET_IMAGE_FROM_STORE').length === 2, seq());
  check('idle afterwards', undoState === undoStates.idle, 'undoState=' + undoState);

  section('Undo down to empty');
  let guard = 0;
  while (peek().signatureStrokes.length > 0 && guard++ < 20) { press(retryButton); await wait(300); }
  check('drained to empty', peek().signatureStrokes.length === 0, 'stuck at ' + peek().signatureStrokes.length);
  sent = []; logLines = []; press(retryButton); await wait(150);
  check('no-op on empty', sent.length === 0 && logLines.some(l => l.includes('no strokes')), seq());

  section('Confirm');
  strokeOf(6,700);
  sent = []; jqCalls = []; press(confirmButton); await wait(300);
  check('CONFIRM then CLOSE', sent[0] === 'TOKEN_CMD_API_SIGNATURE_CONFIRM' &&
                              sent.includes('TOKEN_CMD_API_DEVICE_CLOSE'), seq());
  check('no SignData / stream round trip',
        !sent.includes('TOKEN_CMD_API_SIGNATURE_GET_SIGN_DATA') &&
        !sent.includes('TOKEN_CMD_API_SIGNATURE_SAVE_AS_STREAM_EX'), seq());
  check('image captured from canvas', /^data:image\/png;base64,/.test(peek().lastSignatureImage || ''),
        String(peek().lastSignatureImage));
  check('exposed on window',   window.lastSignatureImage === peek().lastSignatureImage, 'missing');
  check('app hooks clicked',   jqCalls.includes('#signDoc1') && jqCalls.includes('#fa-close2'), jqCalls.join(','));
  check('pad closed',          !deviceOpen && padState === padStates.closed, 'still open');

  section('Cancel');
  await fullSession();
  strokeOf(4,100);
  sent = []; press(cancelButton); await wait(300);
  check('CANCEL then CLOSE', sent[0] === 'TOKEN_CMD_API_SIGNATURE_CANCEL' &&
                             sent.includes('TOKEN_CMD_API_DEVICE_CLOSE'), seq());
  check('strokes cleared',   peek().signatureStrokes.length === 0, 'got ' + peek().signatureStrokes.length);
  check('pad closed',        !deviceOpen && padState === padStates.closed, 'still open');

  section('Robustness');
  logLines = [];
  onMessage({ data: 'not json at all' });
  check('malformed JSON survived', logLines.some(l => l.includes('could not parse')), 'no log');
  logLines = [];
  reply('TOKEN_CMD_SOMETHING_NEW');
  check('unknown response survived', logLines.some(l => l.includes('unhandled response')), 'no log');
  logLines = [];
  onMessage({ data: JSON.stringify({ TOKEN_TYPE:'TOKEN_TYPE_SEND', TOKEN_CMD:'TOKEN_CMD_ERROR',
    TOKEN_PARAM_ERROR_CONTEXT:'ctx', TOKEN_PARAM_RETURN_CODE:-7, TOKEN_PARAM_ERROR_DESCRIPTION:'boom' }) });
  check('pad error logged in full', logLines.some(l => l.includes('ctx') && l.includes('-7') && l.includes('boom')), 'no log');
  check('base64 shortened in log',
        logLines.length >= 0 && !logLines.some(l => l.length > 4000), 'a log line is enormous');

  section('Failure during preparation still closes cleanly');
  await fullSession();
  const okOpen = deviceOpen;
  sent = []; failAt = 'TOKEN_CMD_API_SIGNATURE_CANCEL';
  press(cancelButton); await wait(300);
  check('pad closed after a failed command', okOpen && !deviceOpen, 'deviceOpen=' + deviceOpen);

  clearTimeout(T);
  section('Connection is opened lazily and sends are queued');
  signoPADAPIWeb = null; sent = []; hotspotId = 0; logLines = []; socketOpenDelay = 60;
  // getSignature() without onMainWindowLoad(), and while the socket is still CONNECTING
  getSignature();
  check('nothing sent while connecting', sent.length === 0, seq());
  check('first command was queued', logLines.some(l => l.includes('queued until the connection')), 'not queued');
  await wait(600);
  check('session completes after the socket opens',
        deviceOpen && sent.includes('TOKEN_CMD_API_SIGNATURE_START'), seq());
  socketOpenDelay = 0;
  press(confirmButton); await wait(300);

  section('Missing #sigCanvas at load is not fatal');
  signoPADAPIWeb = null; sent = []; logLines = []; hideCanvas = true;
  onMainWindowLoad(); await wait();
  check('connection still created', signoPADAPIWeb !== null, 'null');
  check('absence is noted, not fatal', logLines.some(l => l.includes('will look again')), 'no note');
  getSignature(); await wait(100);
  check('getSignature reports the missing canvas',
        logLines.some(l => l.includes('cannot capture a signature')), 'no error');
  hideCanvas = false;
  sent = []; hotspotId = 0;
  getSignature(); await wait(500);
  check('works once the canvas appears',
        deviceOpen && sent.includes('TOKEN_CMD_API_SIGNATURE_START'), seq());

  section('Diagnostics');
  const diag = signotecDiagnostics();
  check('reports an open connection', diag.connection === 'OPEN', diag.connection);
  check('reports the pad profile',    diag.padProfile === 'Omega', diag.padProfile);
  check('reports the pad as opened',  diag.padState === 'opened', diag.padState);

  section('Server drops the connection mid-session');
  strokeOf(4, 900);
  signoPADAPIWeb.readyState = 3; signoPADAPIWeb.onclose({ target:{ url:'wss://x' } });
  check('state reset on close', padState === padStates.closed && undoState === undoStates.idle,
        'padState=' + padState);
  sent = []; press(retryButton); await wait(200);
  check('no sends on a closed socket', !sent.length, seq());

  realLog('\n' + (fails === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : '\x1b[31m' + fails + ' CHECK(S) FAILED\x1b[0m'));
  process.exit(fails ? 1 : 0);
})();
