/*
 * AES-128-ECB / ZeroPadding, hex 输入输出。
 * 与 Panabit portal 前端 pa_aes_encode / pa_aes_decode 完全一致:
 *   - key: "Panabit@1024_key" (16 字节, AES-128)
 *   - mode: ECB, padding: ZeroPadding
 * S 盒由 GF(2^8) 逆元 + 仿射变换在加载时生成, 避免手写表打错。
 */

var SBOX = null
var INV_SBOX = null
var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

function gfMul(a, b) {
  var p = 0
  for (var i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    var hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p
}

function rotl8(x, n) {
  return ((x << n) | (x >>> (8 - n))) & 0xff
}

function buildTables() {
  if (SBOX) return
  SBOX = new Array(256)
  INV_SBOX = new Array(256)
  var i, j
  for (i = 0; i < 256; i++) {
    var inv = 0
    if (i !== 0) {
      for (j = 1; j < 256; j++) {
        if (gfMul(i, j) === 1) {
          inv = j
          break
        }
      }
    }
    var s = inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63
    s = s & 0xff
    SBOX[i] = s
    INV_SBOX[s] = i
  }
}

/* state: 16 字节, 按列主序 (state[c*4+r] 对应 AES 矩阵 r 行 c 列) */
function keyExpansion(keyBytes) {
  buildTables()
  var w = []
  var i
  for (i = 0; i < 4; i++) {
    w.push([keyBytes[i * 4], keyBytes[i * 4 + 1], keyBytes[i * 4 + 2], keyBytes[i * 4 + 3]])
  }
  for (i = 4; i < 44; i++) {
    var t = w[i - 1].slice()
    if (i % 4 === 0) {
      // RotWord + SubWord + Rcon
      t = [
        SBOX[t[1]] ^ RCON[i / 4 - 1],
        SBOX[t[2]],
        SBOX[t[3]],
        SBOX[t[0]],
      ]
    }
    var prev = w[i - 4]
    w.push([prev[0] ^ t[0], prev[1] ^ t[1], prev[2] ^ t[2], prev[3] ^ t[3]])
  }
  var roundKeys = []
  for (i = 0; i < 11; i++) {
    var rk = []
    for (var c = 0; c < 4; c++) {
      var word = w[i * 4 + c]
      rk.push(word[0], word[1], word[2], word[3])
    }
    roundKeys.push(rk)
  }
  return roundKeys
}

function addRoundKey(state, rk) {
  for (var i = 0; i < 16; i++) state[i] ^= rk[i]
}

function subBytes(state) {
  for (var i = 0; i < 16; i++) state[i] = SBOX[state[i]]
}

function invSubBytes(state) {
  for (var i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]]
}

function shiftRows(state) {
  var t
  // row1 左移1
  t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t
  // row2 左移2
  t = state[2]; state[2] = state[10]; state[10] = t
  t = state[6]; state[6] = state[14]; state[14] = t
  // row3 左移3
  t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t
}

function invShiftRows(state) {
  var t
  t = state[13]; state[13] = state[9]; state[9] = state[5]; state[5] = state[1]; state[1] = t
  t = state[2]; state[2] = state[10]; state[10] = t
  t = state[6]; state[6] = state[14]; state[14] = t
  t = state[3]; state[3] = state[7]; state[7] = state[11]; state[11] = state[15]; state[15] = t
}

function mixColumns(state) {
  for (var c = 0; c < 4; c++) {
    var i = c * 4
    var a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3]
    state[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3
    state[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3
    state[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3)
    state[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2)
  }
}

function invMixColumns(state) {
  for (var c = 0; c < 4; c++) {
    var i = c * 4
    var a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3]
    state[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9)
    state[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13)
    state[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11)
    state[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14)
  }
}

function encryptBlock(input, roundKeys) {
  var state = input.slice()
  addRoundKey(state, roundKeys[0])
  for (var r = 1; r < 10; r++) {
    subBytes(state)
    shiftRows(state)
    mixColumns(state)
    addRoundKey(state, roundKeys[r])
  }
  subBytes(state)
  shiftRows(state)
  addRoundKey(state, roundKeys[10])
  return state
}

function decryptBlock(input, roundKeys) {
  var state = input.slice()
  addRoundKey(state, roundKeys[10])
  for (var r = 9; r >= 1; r--) {
    invShiftRows(state)
    invSubBytes(state)
    addRoundKey(state, roundKeys[r])
    invMixColumns(state)
  }
  invShiftRows(state)
  invSubBytes(state)
  addRoundKey(state, roundKeys[0])
  return state
}

export function utf8Encode(str) {
  var out = []
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        )
        i++
      } else {
        out.push(0xef, 0xbf, 0xbd)
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return out
}

export function utf8Decode(bytes) {
  var out = ''
  var i = 0
  while (i < bytes.length) {
    var b = bytes[i]
    var cp
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i++
    } else if ((b & 0xe0) === 0xc0 && i + 1 < bytes.length) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
      out += String.fromCharCode(cp)
      i += 2
    } else if ((b & 0xf0) === 0xe0 && i + 2 < bytes.length) {
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      out += String.fromCharCode(cp)
      i += 3
    } else if ((b & 0xf8) === 0xf0 && i + 3 < bytes.length) {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f)
      cp -= 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      i += 4
    } else {
      out += '\ufffd'
      i++
    }
  }
  return out
}

function toHex(bytes) {
  var hex = ''
  for (var i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  }
  return hex
}

function fromHex(hex) {
  var out = []
  for (var i = 0; i + 1 < hex.length; i += 2) {
    out.push(parseInt(hex.substr(i, 2), 16))
  }
  return out
}

var KEY_BYTES = utf8Encode('Panabit@1024_key')
var CACHED_ROUND_KEYS = null

function roundKeys() {
  if (!CACHED_ROUND_KEYS) CACHED_ROUND_KEYS = keyExpansion(KEY_BYTES)
  return CACHED_ROUND_KEYS
}

/* pa_aes_encode 等价: AES-128-ECB ZeroPadding -> hex */
export function paAesEncode(text) {
  var rk = roundKeys()
  var data = utf8Encode(String(text == null ? '' : text))
  var padded = data.slice()
  var rem = padded.length % 16
  if (rem !== 0) {
    for (var i = 0; i < 16 - rem; i++) padded.push(0)
  }
  var hex = ''
  for (var off = 0; off < padded.length; off += 16) {
    var enc = encryptBlock(padded.slice(off, off + 16), rk)
    hex += toHex(enc)
  }
  return hex
}

/* pa_aes_decode 等价: hex -> AES-128-ECB 解密, 去零填充 */
export function paAesDecode(hex) {
  var rk = roundKeys()
  var data = fromHex(String(hex || ''))
  if (data.length === 0 || data.length % 16 !== 0) return ''
  var plain = []
  for (var off = 0; off < data.length; off += 16) {
    var dec = decryptBlock(data.slice(off, off + 16), rk)
    plain = plain.concat(dec)
  }
  var end = plain.length
  while (end > 0 && plain[end - 1] === 0) end--
  return utf8Decode(plain.slice(0, end))
}
