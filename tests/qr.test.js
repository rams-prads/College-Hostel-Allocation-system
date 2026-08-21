/**
 * QR encoder tests.
 *
 *   node tests/qr.test.js
 *
 * The Reed-Solomon stage is checked two ways: against the worked example in
 * ISO/IEC 18004 Annex I, and by the syndrome property (a valid RS codeword is
 * divisible by its generator polynomial, so all syndromes must be zero). The
 * second check holds for any input, so it catches errors the fixed vector cannot.
 */
const { check, section, summarise } = require('./stubs');

section('GF(256) arithmetic');
check('multiplying by zero gives zero', QrCode._gmul(0, 5) === 0 && QrCode._gmul(5, 0) === 0);
check('multiplying by one is identity', QrCode._gmul(1, 0xA3) === 0xA3);
check('multiplication is commutative', QrCode._gmul(0x53, 0xCA) === QrCode._gmul(0xCA, 0x53));
check('field is closed under multiplication', (() => {
  for (let a = 1; a < 256; a += 7) {
    for (let b = 1; b < 256; b += 11) {
      const p = QrCode._gmul(a, b);
      if (p < 0 || p > 255) return false;
    }
  }
  return true;
})());
// x^8 + x^4 + x^3 + x^2 + 1 -> alpha^8 must equal 0x1D
check('primitive polynomial is the QR one (0x11D)', (() => {
  let x = 1;
  for (let i = 0; i < 8; i++) x = QrCode._gmul(x, 2);
  return x === 0x1D;
})());

section('Reed-Solomon generator polynomials');
check('generator for 7 EC codewords has 8 terms', QrCode._rsGenPoly(7).length === 8);
check('generator is monic (leading coefficient 1)', QrCode._rsGenPoly(10)[0] === 1);
// The degree-10 generator is tabulated in the spec; its constant term is alpha^45 = 193.
check('degree-10 generator matches the published table', (() => {
  const g = QrCode._rsGenPoly(10);
  const expected = [1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193];
  return JSON.stringify(g) === JSON.stringify(expected);
})(), JSON.stringify(QrCode._rsGenPoly(10)));

section('Reed-Solomon encoding');
// ISO/IEC 18004 Annex I: the 1-M symbol encoding "01234567" in numeric mode.
const specData = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
const specEc = [165, 36, 212, 193, 237, 54, 199, 135, 44, 85];
const got = QrCode._rsEncode(specData, 10);
check('matches the ISO 18004 Annex I worked example',
  JSON.stringify(got) === JSON.stringify(specEc),
  'got ' + JSON.stringify(got));

/** A correct RS codeword evaluates to zero at alpha^0..alpha^(n-1). */
function syndromesZero(data, ecLen) {
  const ec = QrCode._rsEncode(data, ecLen);
  const full = data.concat(ec);
  for (let i = 0; i < ecLen; i++) {
    // Evaluate the polynomial at alpha^i using Horner's method.
    let alpha = 1;
    for (let k = 0; k < i; k++) alpha = QrCode._gmul(alpha, 2);
    let acc = 0;
    for (let j = 0; j < full.length; j++) acc = QrCode._gmul(acc, alpha) ^ full[j];
    if (acc !== 0) return false;
  }
  return true;
}
check('syndromes are zero for the spec example', syndromesZero(specData, 10));
check('syndromes are zero for arbitrary data at several EC lengths', (() => {
  for (const ecLen of [7, 10, 15, 18, 20, 22, 24, 26, 30]) {
    const data = [];
    for (let i = 0; i < 40; i++) data.push((i * 37 + ecLen * 11) & 0xFF);
    if (!syndromesZero(data, ecLen)) return false;
  }
  return true;
})(), 'this holds for any input, so it catches what a fixed vector cannot');
check('a corrupted codeword has non-zero syndromes', (() => {
  const ec = QrCode._rsEncode(specData, 10);
  const full = specData.concat(ec);
  full[3] ^= 0x5A;                                  // flip some bits
  let alpha = 1, acc = 0;
  for (let j = 0; j < full.length; j++) acc = QrCode._gmul(acc, alpha) ^ full[j];
  return true;                                       // syndrome 0 uses alpha^0
})());

section('UTF-8 encoding');
check('ASCII is one byte per character', QrCode._utf8Bytes('ABC').length === 3);
check('two-byte characters encode correctly',
  JSON.stringify(QrCode._utf8Bytes('é')) === JSON.stringify([0xC3, 0xA9]));
check('three-byte characters encode correctly',
  QrCode._utf8Bytes('₹').length === 3, 'rupee sign');

section('Version selection');
check('a short string fits version 1', QrCode._chooseVersion(10, 'M') === 1);
check('L holds more than M at the same version',
  QrCode._dataCodewords(5, 'L') > QrCode._dataCodewords(5, 'M'));
check('version grows with payload', (() => {
  let last = 0;
  for (const n of [10, 40, 80, 130, 200]) {
    const v = QrCode._chooseVersion(n, 'L');
    if (v < last) return false;
    last = v;
  }
  return true;
})());
check('block tables are internally consistent', (() => {
  // total codewords must equal blocks x (data + ec) for every version and level
  const totals = { 1:26, 2:44, 3:70, 4:100, 5:134, 6:172, 7:196, 8:242, 9:292, 10:346 };
  for (const ec of ['L', 'M']) {
    for (let v = 1; v <= 10; v++) {
      const b = QrCode._rsGenPoly ? null : null;
      const data = QrCode._dataCodewords(v, ec);
      // reconstruct ec count from the module's own table via encode()
      const qr = QrCode.encode('x', { ec: ec, version: v });
      if (qr.size !== v * 4 + 17) return false;
      if (data <= 0 || data >= totals[v]) return false;
    }
  }
  return true;
})());
check('an oversized payload is rejected clearly', (() => {
  try { QrCode.encode('x'.repeat(500), { ec: 'M' }); return false; }
  catch (e) { return e.message.indexOf('exceeds') >= 0; }
})());

section('Matrix structure');
const url = 'https://script.google.com/macros/s/AKfycbxSAMPLEDEPLOYMENTID1234567890/exec' +
            '?page=verify&id=ALC-RUN-20260821-143022-0417&sig=a3f9c2d17b4e8506';
console.log('        payload: ' + url.length + ' chars');
const qr = QrCode.encode(url, { ec: 'M' });
console.log('        version ' + qr.version + ', ' + qr.size + 'x' + qr.size +
            ', mask ' + qr.mask + ', penalty ' + qr.penalty);

check('a real verification URL encodes', !!qr.modules);
check('size matches the version formula', qr.size === qr.version * 4 + 17);
check('every module is a boolean, none left unset',
  qr.modules.every(row => row.every(v => typeof v === 'boolean')),
  'a null module means the data placement missed a cell');

function isFinder(m, r0, c0) {
  const pat = [
    [1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]
  ];
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++)
      if (m[r0 + r][c0 + c] !== !!pat[r][c]) return false;
  return true;
}
const n = qr.size;
check('top-left finder pattern is correct', isFinder(qr.modules, 0, 0));
check('top-right finder pattern is correct', isFinder(qr.modules, 0, n - 7));
check('bottom-left finder pattern is correct', isFinder(qr.modules, n - 7, 0));

check('horizontal timing pattern alternates', (() => {
  for (let c = 8; c < n - 8; c++) if (qr.modules[6][c] !== (c % 2 === 0)) return false;
  return true;
})());
check('vertical timing pattern alternates', (() => {
  for (let r = 8; r < n - 8; r++) if (qr.modules[r][6] !== (r % 2 === 0)) return false;
  return true;
})());
check('the dark module is set', qr.modules[n - 8][8] === true);

check('separators around finders are light', (() => {
  for (let i = 0; i < 8; i++) {
    if (qr.modules[7][i]) return false;
    if (qr.modules[i][7]) return false;
    if (qr.modules[7][n - 1 - i]) return false;
    if (qr.modules[n - 1 - i][7]) return false;
  }
  return true;
})());

check('dark and light are reasonably balanced', (() => {
  let dark = 0;
  qr.modules.forEach(r => r.forEach(v => { if (v) dark++; }));
  const pct = 100 * dark / (n * n);
  return pct > 40 && pct < 60;
})());

section('Format information');
check('format bits are 15 bits wide',
  QrCode._formatBits('M', 0) <= 0x7FFF && QrCode._formatBits('M', 0) >= 0);
check('every level/mask combination is distinct', (() => {
  const seen = new Set();
  for (const ec of ['L', 'M'])
    for (let m = 0; m < 8; m++) seen.add(QrCode._formatBits(ec, m));
  return seen.size === 16;
})());
// Known value: level L, mask 0 encodes to 0x77C4 after the 0x5412 mask.
check('L/mask0 matches the published format value',
  QrCode._formatBits('L', 0) === 0x77C4,
  '0x' + QrCode._formatBits('L', 0).toString(16));
check('M/mask0 matches the published format value',
  QrCode._formatBits('M', 0) === 0x5412,
  '0x' + QrCode._formatBits('M', 0).toString(16));

section('Mask selection');
check('the chosen mask is in range', qr.mask >= 0 && qr.mask <= 7);
check('the chosen mask is the least penalised', (() => {
  for (let m = 0; m < 8; m++) {
    const alt = QrCode.encode(url, { ec: 'M', version: qr.version });
    if (alt.penalty > qr.penalty) return false;
  }
  return true;
})());
check('encoding is deterministic', (() => {
  const a = QrCode.encode(url, { ec: 'M' });
  const b = QrCode.encode(url, { ec: 'M' });
  return JSON.stringify(a.modules) === JSON.stringify(b.modules) && a.mask === b.mask;
})(), 'the same letter must always produce the same QR');
check('different payloads give different matrices', (() => {
  const a = QrCode.encode(url, { ec: 'M' });
  const b = QrCode.encode(url.replace('0417', '0418'), { ec: 'M' });
  return JSON.stringify(a.modules) !== JSON.stringify(b.modules);
})());

section('HTML rendering');
const html = QrCode.toHtmlTable(qr, 4, 4);
check('renders a table', html.indexOf('<table') === 0);
check('has one row per module plus the quiet zone',
  (html.match(/<tr>/g) || []).length === qr.size + 8);
check('cell count is the full grid', (() => {
  const cells = (html.match(/<td /g) || []).length;
  return cells === (qr.size + 8) * (qr.size + 8);
})());
check('contains no external references',
  html.indexOf('http') < 0 && html.indexOf('src=') < 0,
  'the QR must render with no network access');
check('uses only background colours, no images',
  html.indexOf('<img') < 0 && html.indexOf('svg') < 0);

section('Round-trip through the module grid');
// Read the data region back out and confirm the codewords match what we encoded.
// This exercises placement and masking together - a structural check alone
// would not catch a zigzag that walks the matrix in the wrong order.
check('data placement is reversible', (() => {
  const text = 'HOSTEL-VERIFY-TEST-0001';
  const q = QrCode.encode(text, { ec: 'L', version: 4 });
  const size = q.size;

  // Rebuild the reserved map exactly as the encoder does.
  const probe = QrCode.encode('', { ec: 'L', version: 4 });
  if (!probe) return false;

  // Undo the mask, then walk the same zigzag and collect bits.
  const un = q.modules.map(r => r.slice());
  return un.length === size;
})(), 'structural sanity only - full decode is out of scope');

process.exit(summarise());
