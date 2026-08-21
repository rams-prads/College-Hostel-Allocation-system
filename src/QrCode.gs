/**
 * QrCode.gs - a complete QR encoder in plain JavaScript.
 *
 * WHY THIS EXISTS: every hosted QR service is either a paid API, an external
 * request the demo can fail on, or both. The problem statement asks for a system
 * with no paid licences and no servers, so the allotment letter generates its
 * own QR code offline. Nothing here calls out to anything.
 *
 * Implements ISO/IEC 18004 byte mode for versions 1-10 at error-correction
 * levels L and M, which covers a Google Apps Script web app URL comfortably.
 *
 * The output is a boolean matrix. Letters.gs renders it as a grid of coloured
 * table cells, which is the one image-free representation that survives Apps
 * Script's HTML-to-PDF conversion intact.
 */

var QrCode = (function () {

  // ------------------------------------------------- GF(256) arithmetic
  // Galois field with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D),
  // as specified for QR. EXP is doubled so we can index up to 510 without a mod.
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** Generator polynomial for `n` error-correction codewords. */
  function rsGenPoly(n) {
    var p = [1];
    for (var i = 0; i < n; i++) {
      var np = [];
      for (var k = 0; k <= p.length; k++) np[k] = 0;
      for (var j = 0; j < p.length; j++) {
        np[j] ^= p[j];                       // p(x) * x
        np[j + 1] ^= gmul(p[j], EXP[i]);     // p(x) * alpha^i
      }
      p = np;
    }
    return p;
  }

  /** Reed-Solomon error-correction codewords for one block. */
  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = data.slice();
    for (var p = 0; p < ecLen; p++) res.push(0);
    for (var i = 0; i < data.length; i++) {
      var coef = res[i];
      if (coef !== 0) {
        for (var j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
      }
    }
    return res.slice(data.length);
  }

  // ------------------------------------------------------- version tables
  // [ecCodewordsPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
  var BLOCKS = {
    L: {
      1:  [7,  1,  19, 0, 0],   2:  [10, 1,  34, 0, 0],   3:  [15, 1,  55, 0, 0],
      4:  [20, 1,  80, 0, 0],   5:  [26, 1, 108, 0, 0],   6:  [18, 2,  68, 0, 0],
      7:  [20, 2,  78, 0, 0],   8:  [24, 2,  97, 0, 0],   9:  [30, 2, 116, 0, 0],
      10: [18, 2,  68, 2, 69]
    },
    M: {
      1:  [10, 1,  16, 0, 0],   2:  [16, 1,  28, 0, 0],   3:  [26, 1,  44, 0, 0],
      4:  [18, 2,  32, 0, 0],   5:  [24, 2,  43, 0, 0],   6:  [16, 4,  27, 0, 0],
      7:  [18, 4,  31, 0, 0],   8:  [22, 2,  38, 2, 39],  9:  [22, 3,  36, 2, 37],
      10: [26, 4,  43, 1, 44]
    }
  };

  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  // Remainder bits appended after the interleaved codewords.
  function remainderBits(version) {
    if (version === 1) return 0;
    if (version <= 6) return 7;
    return 0;                                  // versions 7-13
  }

  var EC_BITS = { L: 1, M: 0 };                // format-info encoding of the level

  function dataCodewords(version, ec) {
    var b = BLOCKS[ec][version];
    return b[1] * b[2] + b[3] * b[4];
  }

  function size(version) { return version * 4 + 17; }

  /** Smallest version that fits `byteLen` bytes at this EC level. */
  function chooseVersion(byteLen, ec) {
    for (var v = 1; v <= 10; v++) {
      var capacityBits = dataCodewords(v, ec) * 8;
      var needed = 4 + 8 + byteLen * 8;        // mode + 8-bit count + payload
      if (needed <= capacityBits) return v;
    }
    throw new Error('QrCode: ' + byteLen + ' bytes exceeds version 10 capacity at level ' + ec);
  }

  // ------------------------------------------------------------ bit buffer
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.toBytes = function () {
    var out = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      out.push(b);
    }
    return out;
  };

  /** UTF-8 bytes of a string. */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  // ------------------------------------------------------------- codewords
  function buildCodewords(text, version, ec) {
    var bytes = utf8Bytes(text);
    var totalData = dataCodewords(version, ec);

    var buf = new BitBuffer();
    buf.put(4, 4);                             // byte mode
    buf.put(bytes.length, 8);                  // 8-bit count for versions 1-9
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    // Terminator, then pad to a byte boundary.
    var capacity = totalData * 8;
    var term = Math.min(4, capacity - buf.bits.length);
    buf.put(0, term);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    var data = buf.toBytes();
    var pad = [0xEC, 0x11], k = 0;
    while (data.length < totalData) data.push(pad[k++ % 2]);

    // Split into blocks, error-correct each, then interleave.
    var b = BLOCKS[ec][version];
    var ecLen = b[0];
    var blocks = [], pos = 0;
    for (var g = 0; g < b[1]; g++) { blocks.push(data.slice(pos, pos + b[2])); pos += b[2]; }
    for (var h = 0; h < b[3]; h++) { blocks.push(data.slice(pos, pos + b[4])); pos += b[4]; }

    var ecBlocks = blocks.map(function (blk) { return rsEncode(blk, ecLen); });

    var out = [];
    var maxData = Math.max.apply(null, blocks.map(function (x) { return x.length; }));
    for (var c = 0; c < maxData; c++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (c < blocks[bi].length) out.push(blocks[bi][c]);
      }
    }
    for (var e = 0; e < ecLen; e++) {
      for (var bj = 0; bj < ecBlocks.length; bj++) out.push(ecBlocks[bj][e]);
    }
    return out;
  }

  // ---------------------------------------------------------------- matrix
  function blankMatrix(n) {
    var m = [];
    for (var r = 0; r < n; r++) {
      m[r] = [];
      for (var c = 0; c < n; c++) m[r][c] = null;
    }
    return m;
  }

  function placeFinder(m, reserved, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr][cc] = on;
        reserved[rr][cc] = true;
      }
    }
  }

  function placeAlignment(m, reserved, version) {
    var centers = ALIGN[version];
    var n = m.length;
    for (var i = 0; i < centers.length; i++) {
      for (var j = 0; j < centers.length; j++) {
        var row = centers[i], col = centers[j];
        // Skip the three positions that collide with finder patterns.
        if ((row <= 8 && col <= 8) ||
            (row <= 8 && col >= n - 9) ||
            (row >= n - 9 && col <= 8)) continue;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            m[row + r][col + c] = on;
            reserved[row + r][col + c] = true;
          }
        }
      }
    }
  }

  function placeTiming(m, reserved) {
    var n = m.length;
    for (var i = 8; i < n - 8; i++) {
      var on = i % 2 === 0;
      if (!reserved[6][i]) { m[6][i] = on; reserved[6][i] = true; }
      if (!reserved[i][6]) { m[i][6] = on; reserved[i][6] = true; }
    }
  }

  function reserveFormat(m, reserved, version) {
    var n = m.length;
    for (var i = 0; i < 9; i++) {
      if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
    }
    // The two format copies are NOT symmetric: the column below the top-right
    // finder holds 8 modules (the last of which is the dark module), while the
    // row beside the bottom-left finder holds only 7. Reserving 8 in both left
    // one module reserved but never written, which showed up as a null cell.
    for (var j = 0; j < 8; j++) reserved[n - 1 - j][8] = true;
    for (var k = 0; k < 7; k++) reserved[8][n - 1 - k] = true;

    m[n - 8][8] = true;                       // dark module, always set
    reserved[n - 8][8] = true;
    reserved[6][8] = true; reserved[8][6] = true;
  }

  /**
   * Version information: 18 bits carried twice, required from version 7 up.
   * Without these blocks a scanner cannot determine the symbol version and
   * simply refuses to read the code.
   */
  function versionBits(version) {
    var rem = version << 12;
    for (var i = 5; i >= 0; i--) {
      if ((rem >>> (i + 12)) & 1) rem ^= 0x1F25 << i;
    }
    return (version << 12) | rem;
  }

  function placeVersion(m, reserved, version) {
    if (version < 7) return;
    var n = m.length;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var on = ((bits >>> i) & 1) === 1;
      var a = Math.floor(i / 3), b = i % 3;
      m[a][n - 11 + b] = on;  reserved[a][n - 11 + b] = true;   // top right
      m[n - 11 + b][a] = on;  reserved[n - 11 + b][a] = true;   // bottom left
    }
  }

  /** Zigzag data placement, right to left, skipping the vertical timing column. */
  function placeData(m, reserved, codewords) {
    var n = m.length;
    var bitIndex = 0, byteIndex = 0;
    var upward = true;

    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;              // column 6 is timing, step over it
      for (var vert = 0; vert < n; vert++) {
        var row = upward ? (n - 1 - vert) : vert;
        for (var c = 0; c < 2; c++) {
          var col = right - c;
          if (reserved[row][col]) continue;
          var dark = false;
          if (byteIndex < codewords.length) {
            dark = ((codewords[byteIndex] >>> (7 - bitIndex)) & 1) === 1;
          }
          m[row][col] = dark;
          bitIndex++;
          if (bitIndex === 8) { bitIndex = 0; byteIndex++; }
        }
      }
      upward = !upward;
    }
  }

  function maskFn(pattern, row, col) {
    switch (pattern) {
      case 0: return (row + col) % 2 === 0;
      case 1: return row % 2 === 0;
      case 2: return col % 3 === 0;
      case 3: return (row + col) % 3 === 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    }
    return false;
  }

  function applyMask(m, reserved, pattern) {
    var out = m.map(function (row) { return row.slice(); });
    for (var r = 0; r < m.length; r++) {
      for (var c = 0; c < m.length; c++) {
        if (!reserved[r][c] && maskFn(pattern, r, c)) out[r][c] = !out[r][c];
      }
    }
    return out;
  }

  /** BCH(15,5) format information, masked with 0x5412 as the spec requires. */
  function formatBits(ec, mask) {
    var data = (EC_BITS[ec] << 3) | mask;
    var rem = data << 10;
    for (var i = 4; i >= 0; i--) {
      if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function placeFormat(m, ec, mask) {
    var n = m.length;
    var bits = formatBits(ec, mask);
    for (var i = 0; i < 15; i++) {
      var on = ((bits >>> i) & 1) === 1;
      // Copy 1: around the top-left finder.
      if (i < 6)       m[8][i] = on;
      else if (i === 6) m[8][7] = on;
      else if (i === 7) m[8][8] = on;
      else if (i === 8) m[7][8] = on;
      else              m[14 - i][8] = on;
      // Copy 2: split between the other two finders.
      if (i < 8)  m[n - 1 - i][8] = on;
      else        m[8][n - 15 + i] = on;
    }
    m[n - 8][8] = true;                         // dark module, always
  }

  // -------------------------------------------------------------- penalty
  function penalty(m) {
    var n = m.length, score = 0, r, c, i;

    // Rule 1: runs of five or more identical modules in a row or column.
    for (r = 0; r < n; r++) {
      var runH = 1, runV = 1;
      for (c = 1; c < n; c++) {
        runH = m[r][c] === m[r][c - 1] ? runH + 1 : 1;
        if (runH === 5) score += 3; else if (runH > 5) score += 1;
        runV = m[c][r] === m[c - 1][r] ? runV + 1 : 1;
        if (runV === 5) score += 3; else if (runV > 5) score += 1;
      }
    }

    // Rule 2: 2x2 blocks of one colour.
    for (r = 0; r < n - 1; r++) {
      for (c = 0; c < n - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns, which confuse scanners.
    var p1 = [true, false, true, true, true, false, true, false, false, false, false];
    var p2 = [false, false, false, false, true, false, true, true, true, false, true];
    function matches(get, start, pat) {
      for (var k = 0; k < pat.length; k++) if (get(start + k) !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < n; r++) {
      for (c = 0; c + 11 <= n; c++) {
        var rowGet = (function (rr) { return function (x) { return m[rr][x]; }; })(r);
        if (matches(rowGet, c, p1) || matches(rowGet, c, p2)) score += 40;
        var colGet = (function (cc) { return function (x) { return m[x][cc]; }; })(r);
        if (matches(colGet, c, p1) || matches(colGet, c, p2)) score += 40;
      }
    }

    // Rule 4: deviation from an even balance of dark and light.
    var dark = 0;
    for (r = 0; r < n; r++) for (c = 0; c < n; c++) if (m[r][c]) dark++;
    var pct = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  // ----------------------------------------------------------------- API

  /**
   * Encode text as a QR matrix.
   * @param {string} text
   * @param {{ec?: string}} opts  error-correction level 'L' or 'M' (default M)
   * @return {{size: number, version: number, ec: string, mask: number,
   *           modules: Array<Array<boolean>>}}
   */
  function encode(text, opts) {
    opts = opts || {};
    var ec = opts.ec || 'M';
    if (!BLOCKS[ec]) throw new Error('QrCode: unsupported EC level ' + ec);

    var byteLen = utf8Bytes(text).length;
    var version = opts.version || chooseVersion(byteLen, ec);
    var n = size(version);

    var base = blankMatrix(n);
    var reserved = blankMatrix(n);
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) reserved[r][c] = false;

    placeFinder(base, reserved, 0, 0);
    placeFinder(base, reserved, 0, n - 7);
    placeFinder(base, reserved, n - 7, 0);
    placeAlignment(base, reserved, version);
    placeTiming(base, reserved);
    reserveFormat(base, reserved, version);
    placeVersion(base, reserved, version);

    var codewords = buildCodewords(text, version, ec);
    // Remainder bits are already zero because the matrix starts blank.
    placeData(base, reserved, codewords);

    // Try all eight masks and keep the least penalised, as the spec requires.
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = applyMask(base, reserved, mask);
      placeFormat(candidate, ec, mask);
      var p = penalty(candidate);
      if (!best || p < best.penalty) best = { modules: candidate, mask: mask, penalty: p };
    }

    return {
      size: n, version: version, ec: ec, mask: best.mask,
      penalty: best.penalty, modules: best.modules
    };
  }

  /**
   * Render a matrix as an HTML table of coloured cells.
   *
   * A cell grid rather than an image is deliberate: Apps Script's HTML-to-PDF
   * conversion drops inline SVG and data-URI images, but renders table cell
   * backgrounds reliably.
   */
  function toHtmlTable(qr, cellPx, quietZone) {
    cellPx = cellPx || 4;
    quietZone = quietZone === undefined ? 4 : quietZone;
    var n = qr.size, total = n + quietZone * 2;
    var rows = [];

    for (var r = -quietZone; r < n + quietZone; r++) {
      var cells = [];
      for (var c = -quietZone; c < n + quietZone; c++) {
        var inside = r >= 0 && r < n && c >= 0 && c < n;
        var dark = inside && qr.modules[r][c];
        cells.push('<td style="background:' + (dark ? '#000' : '#fff') + '"></td>');
      }
      rows.push('<tr>' + cells.join('') + '</tr>');
    }

    return '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;' +
      'width:' + (total * cellPx) + 'px;height:' + (total * cellPx) + 'px;' +
      'table-layout:fixed;background:#fff">' +
      '<colgroup>' + repeat_('<col style="width:' + cellPx + 'px">', total) + '</colgroup>' +
      '<tbody style="line-height:0">' + rows.join('') + '</tbody></table>';
  }

  function repeat_(s, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += s;
    return out;
  }

  // ------------------------------------------------------------------ PNG
  //
  // A real image, built byte by byte. The first version of this drew the QR as
  // a grid of coloured table cells, which looked right in a browser and then
  // vanished entirely from the PDF - Google's HTML-to-PDF converter discards
  // background colours on empty cells. An <img> with a data URI survives.
  //
  // The PNG is 8-bit greyscale with no compression (zlib "stored" blocks), so
  // there is no deflate implementation to get wrong. A QR is tiny, so the size
  // cost does not matter.

  var CRC_TABLE = null;
  function crcTable_() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }

  function crc32_(bytes) {
    var t = crcTable_(), c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32_(bytes) {
    var a = 1, b = 0;
    for (var i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return (((b << 16) | a) >>> 0);
  }

  function u32_(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }

  function chunk_(type, data) {
    var body = [];
    for (var i = 0; i < type.length; i++) body.push(type.charCodeAt(i));
    body = body.concat(data);
    return u32_(data.length).concat(body).concat(u32_(crc32_(body)));
  }

  /**
   * Encode the matrix as PNG bytes.
   * @param {Object} qr      result of encode()
   * @param {number} scale   pixels per module
   * @param {number} quiet   quiet-zone width in modules (4 is the spec minimum)
   */
  function toPngBytes(qr, scale, quiet) {
    scale = scale || 4;
    quiet = quiet === undefined ? 4 : quiet;
    var n = qr.size;
    var dim = (n + quiet * 2) * scale;

    // Raw scanlines: one filter byte (0 = none) then one byte per pixel.
    var raw = [];
    for (var y = 0; y < dim; y++) {
      raw.push(0);
      var my = Math.floor(y / scale) - quiet;
      for (var x = 0; x < dim; x++) {
        var mx = Math.floor(x / scale) - quiet;
        var dark = my >= 0 && my < n && mx >= 0 && mx < n && qr.modules[my][mx];
        raw.push(dark ? 0 : 255);
      }
    }

    // zlib stream using stored (uncompressed) deflate blocks.
    var z = [0x78, 0x01];
    var pos = 0;
    while (pos < raw.length) {
      var len = Math.min(65535, raw.length - pos);
      var last = (pos + len >= raw.length) ? 1 : 0;
      z.push(last);
      z.push(len & 255, (len >>> 8) & 255);
      z.push((~len) & 255, ((~len) >>> 8) & 255);
      for (var i = 0; i < len; i++) z.push(raw[pos + i]);
      pos += len;
    }
    z = z.concat(u32_(adler32_(raw)));

    var ihdr = u32_(dim).concat(u32_(dim)).concat([8, 0, 0, 0, 0]);  // 8-bit greyscale
    return [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
      .concat(chunk_('IHDR', ihdr))
      .concat(chunk_('IDAT', z))
      .concat(chunk_('IEND', []));
  }

  /** The same PNG as a data URI, ready to drop into an <img src>. */
  function toPngDataUri(qr, scale, quiet) {
    var bytes = toPngBytes(qr, scale, quiet);
    return 'data:image/png;base64,' + Utilities.base64Encode(bytes);
  }

  /** Text rendering, used by tests and for eyeballing output in logs. */
  function toText(qr) {
    return qr.modules.map(function (row) {
      return row.map(function (v) { return v ? '##' : '  '; }).join('');
    }).join('\n');
  }

  return {
    encode: encode,
    toHtmlTable: toHtmlTable,
    toPngBytes: toPngBytes,
    toPngDataUri: toPngDataUri,
    toText: toText,
    // exposed for tests
    _rsEncode: rsEncode,
    _rsGenPoly: rsGenPoly,
    _gmul: gmul,
    _utf8Bytes: utf8Bytes,
    _chooseVersion: chooseVersion,
    _dataCodewords: dataCodewords,
    _formatBits: formatBits,
    _versionBits: versionBits,
    _penalty: penalty
  };
})();
