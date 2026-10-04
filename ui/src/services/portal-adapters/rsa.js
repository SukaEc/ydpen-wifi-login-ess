/*
 * 华为 ESS RSA-1024 加密（纯 JS 大整数实现）。
 * 复现认证页 common_user_auth_login.js 的 encryptedString:
 *   - 密码字符按 16 位打包进 BigInt digits（小端序）
 *   - chunkSize = 2 * biHighIndex(m)，补零到 chunkSize 的整数倍
 *   - 每块 block^e mod m，hex 输出，空格分隔
 * 大整数用十进制字符串模拟（乘法/取模/模幂），QuickJS 可运行。
 */

/* ---------- 十进制字符串大整数 ---------- */
function trim(s) {
  s = String(s).replace(/^0+/, '')
  return s === '' ? '0' : s
}

/* base-10000 分块乘法，避免 JS Number 溢出（2^53 安全） */
function mul(a, b) {
  a = trim(a); b = trim(b)
  var BASE = 10000
  // 转成 base-10000 块（小端序）
  function toBlocks(s) {
    var blocks = []
    for (var i = s.length; i > 0; i -= 4) {
      var start = i - 4 < 0 ? 0 : i - 4
      blocks.push(parseInt(s.substring(start, i), 10))
    }
    return blocks
  }
  var A = toBlocks(a), B = toBlocks(b)
  var res = new Array(A.length + B.length)
  for (var i = 0; i < A.length + B.length; i++) res[i] = 0
  for (var i = 0; i < A.length; i++) {
    var carry = 0
    for (var j = 0; j < B.length; j++) {
      var tmp = res[i + j] + A[i] * B[j] + carry
      res[i + j] = tmp % BASE
      carry = Math.floor(tmp / BASE)
    }
    res[i + B.length] += carry
  }
  // 组装回十进制字符串
  var out = ''
  var started = false
  for (var i = res.length - 1; i >= 0; i--) {
    var v = res[i]
    if (!started) {
      if (v === 0) continue
      out += v
      started = true
    } else {
      var s = String(v)
      while (s.length < 4) s = '0' + s
      out += s
    }
  }
  return out === '' ? '0' : out
}

function sub(a, b) {
  a = trim(a); b = trim(b)
  var la = a.length, lb = b.length
  var borrow = 0, out = ''
  for (var i = 0; i < la; i++) {
    var da = a.charCodeAt(la - 1 - i) - 48
    var db = i < lb ? b.charCodeAt(lb - 1 - i) - 48 : 0
    var diff = da - db - borrow
    if (diff < 0) { diff += 10; borrow = 1 } else { borrow = 0 }
    out = diff + out
  }
  return trim(out)
}

/* 分块取模：每 4 位一块，rem = (rem*10000 + chunk) mod m
 * rem*10000 = 字符串追加 "0000"，避免乘法 */
function mod(a, m) {
  a = trim(a); m = trim(m)
  if (a.length < m.length || (a.length === m.length && a < m)) return a
  var lm = m.length
  var rem = '0'
  var first = a.length % 4
  var start = 0
  if (first > 0) {
    rem = a.substring(0, first)
    start = first
  }
  for (var i = start; i < a.length; i += 4) {
    rem = trim(rem + '0000')
    rem = addDec(rem, a.substring(i, i + 4))
    // 倍减取模：一次减 m*10^diff，减少循环次数
    while (rem.length > lm || (rem.length === lm && rem >= m)) {
      var diff = rem.length - lm
      if (diff > 0) {
        var m2 = m
        for (var k = 0; k < diff; k++) m2 += '0'
        if (rem.length < m2.length || (rem.length === m2.length && rem < m2)) {
          diff--
          m2 = m
          for (var k = 0; k < diff; k++) m2 += '0'
        }
        rem = sub(rem, m2)
      } else {
        rem = sub(rem, m)
      }
    }
  }
  return rem
}

function div2(n) {
  n = trim(n)
  var carry = 0, out = ''
  for (var i = 0; i < n.length; i++) {
    var digit = carry * 10 + (n.charCodeAt(i) - 48)
    out += Math.floor(digit / 2)
    carry = digit % 2
  }
  return trim(out)
}

function dec2bin(n) {
  n = trim(n)
  var out = ''
  while (n !== '0') {
    out = ((n.charCodeAt(n.length - 1) - 48) % 2) + out
    n = div2(n)
  }
  return out === '' ? '0' : out
}

function div16(n) {
  n = trim(n)
  var carry = 0, out = ''
  for (var i = 0; i < n.length; i++) {
    var digit = carry * 10 + (n.charCodeAt(i) - 48)
    out += Math.floor(digit / 16)
    carry = digit % 16
  }
  return trim(out)
}

function dec2hex(n) {
  n = trim(n)
  var out = ''
  var hexChars = '0123456789abcdef'
  while (n !== '0') {
    // n % 16：逐位求余
    var carry = 0
    for (var i = 0; i < n.length; i++) {
      carry = (carry * 10 + (n.charCodeAt(i) - 48)) % 16
    }
    out = hexChars.charAt(carry) + out
    n = div16(n)
  }
  return out === '' ? '0' : out
}

function hex2dec(h) {
  h = String(h).toLowerCase()
  var dec = '0'
  for (var i = 0; i < h.length; i++) {
    dec = mul(dec, '16')
    var v = h.charCodeAt(i)
    var d = v >= 48 && v <= 57 ? v - 48 : v >= 97 && v <= 102 ? v - 87 : 0
    dec = addDigit(dec, d)
  }
  return dec
}

function addDigit(a, d) {
  a = trim(a)
  var carry = d, out = ''
  for (var i = 0; i < a.length || carry; i++) {
    var da = i < a.length ? a.charCodeAt(a.length - 1 - i) - 48 : 0
    var sum = da + carry
    out = (sum % 10) + out
    carry = Math.floor(sum / 10)
  }
  return out
}

/* 十进制字符串加法 */
function addDec(a, b) {
  a = trim(a); b = trim(b)
  var la = a.length, lb = b.length
  var carry = 0, out = ''
  var i = 0
  while (i < la || i < lb || carry) {
    var da = i < la ? a.charCodeAt(la - 1 - i) - 48 : 0
    var db = i < lb ? b.charCodeAt(lb - 1 - i) - 48 : 0
    var sum = da + db + carry
    out = (sum % 10) + out
    carry = Math.floor(sum / 10)
    i++
  }
  return out
}

/* 模幂: a^e mod m（e 为十进制字符串） */
function powMod(a, e, m) {
  var result = '1'
  var base = mod(a, m)
  var bin = dec2bin(e)
  for (var i = 0; i < bin.length; i++) {
    result = mod(mul(result, result), m)
    if (bin.charAt(i) === '1') {
      result = mod(mul(result, base), m)
    }
  }
  return result
}

/*
 * 复现 JS encryptedString:
 *   chunkSize = 2 * biHighIndex(m)，biHighIndex = (bit_len-1)/16
 *   字符 charCode 数组，补 0 到 chunkSize 整数倍
 *   每 chunkSize 个字符打包：digits[j] = a[k] | (a[k+1] << 8)
 *   输出 hex，空格分隔
 */
export function encryptedString(modulusHex, exponentHex, password) {
  var m = hex2dec(modulusHex)
  var e = hex2dec(exponentHex)
  var bitLen = modulusHex.length * 4
  var chunkSize = 2 * Math.floor((bitLen - 1) / 16)

  var a = []
  for (var i = 0; i < password.length; i++) a.push(password.charCodeAt(i))
  while (a.length % chunkSize !== 0) a.push(0)

  var result = []
  for (var off = 0; off < a.length; off += chunkSize) {
    var block = '0'
    // Horner 从最高 word 开始：block = ((w_k * 65536 + w_{k-1}) * 65536 + ...)
    for (var j = chunkSize - 2; j >= 0; j -= 2) {
      var word = a[off + j] | (a[off + j + 1] << 8)
      block = addDec(mul(block, '65536'), String(word))
    }
    var crypt = powMod(block, e, m)
    result.push(dec2hex(crypt))
  }
  return result.join(' ')
}
