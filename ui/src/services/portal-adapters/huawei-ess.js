/*
 * 华为 ESS 上网认证 Portal 适配器。
 * 协议从认证页 (ess/commonauth) 提取:
 *   - 端点: http://<portal服务器>[:端口]/ess/commonauth
 *   - 登录: POST kind=preLogin, 密码 RSA-1024 加密 (exponent=10001 + module)
 *   - 页面下发 RSA 公钥 (module/exponent) 与会话参数 (mac/userIp/ssid/nasIp 等)
 *   - 响应: HTML, 含"认证成功/认证失败"标记
 *
 * 自动识别特征 (match): URL 含 /ess/commonauth 或 wlanuserip 参数,
 * 页面含 sccpEncrytKey / commonauth 等 ESS 特征。
 */
import { request, describeErr } from '../net.js'
import { encryptedString } from './rsa.js'
import { qs, sanitize } from './adapter-api.js'

/* 从认证页 HTML 提取隐藏字段 */
function fieldOf(html, name) {
  if (!html) return ''
  var m = html.match(new RegExp('name="' + name + '"[^>]*value="([^"]*)"'))
  if (m) return m[1]
  m = html.match(new RegExp('id="' + name + '"[^>]*value="([^"]*)"'))
  return m ? m[1] : ''
}

/* 发请求 + 归一化: 永不 throw */
async function httpGet(url) {
  var r = await request({ url: url, timeout: 8 })
  if (!r.ok) {
    return { ok: false, msg: r.error || '无法连接认证服务器' }
  }
  return { ok: true, statusCode: r.statusCode, text: r.text, headers: r.headers }
}

async function httpPost(url, form) {
  // 构造 x-www-form-urlencoded body（华为 ESS 需要 POST form）
  var body = qs(form)
  var r = await request({ url: url, method: 'POST', timeout: 8, body: body })
  if (!r.ok) {
    return { ok: false, msg: r.error || '无法连接认证服务器' }
  }
  return { ok: true, statusCode: r.statusCode, text: r.text }
}

/*
 * loadConf: GET 认证页，提取 RSA 公钥与会话参数。
 * 返回 ready（可登录）或 free（已认证）。
 */
async function loadConf(serverBase, p, state) {
  // 认证页 URL：优先用检测到的 portalPage（含 wlanuserip 等参数）
  var url = serverBase + '/ess/commonauth'
  if (p && p.portalPage) {
    url = p.portalPage
  }
  var res = await httpGet(url)
  if (!res.ok) {
    return { status: 'manual', msg: res.msg }
  }
  var html = res.text
  var module = fieldOf(html, 'module')
  var exponent = fieldOf(html, 'exponent')
  if (!module || !exponent) {
    // 可能已认证（返回非认证页）
    if (/认证成功|success/i.test(html)) {
      return { status: 'free', code: 200 }
    }
    return { status: 'error', msg: '未找到 RSA 公钥，页面可能不是 ESS 认证页' }
  }
  if (state) {
    state.module = module
    state.exponent = exponent
    state.mac = fieldOf(html, 'mac')
    state.userIp = fieldOf(html, 'userIp')
    state.ssid = fieldOf(html, 'ssid')
    state.nasIp = fieldOf(html, 'nasIp')
    state.encryptIp = fieldOf(html, 'encryptIp')
    state.urlBeforeLogon = fieldOf(html, 'urlBeforeLogon')
    state.sccpTimestamp = fieldOf(html, 'sccpTimestamp')
    state.sccpEncrytKey = fieldOf(html, 'sccpEncrytKey')
    state.sccpEncrytIV = fieldOf(html, 'sccpEncrytIV')
    state.sccpServerIp = fieldOf(html, 'sccpServerIp')
    state.sccpServerPort = fieldOf(html, 'sccpServerPort')
    state.sccpClientPort = fieldOf(html, 'sccpClientPort')
    state.loginActionName = fieldOf(html, 'loginActionName')
    state.findPswUrl = fieldOf(html, 'findPswUrl')
    state.t = fieldOf(html, 't')
    state.port = fieldOf(html, 'port')
    state.vid = fieldOf(html, 'vid')
    state.apmac = fieldOf(html, 'apmac')
    state.enableNormalUserLogin = fieldOf(html, 'enableNormalUserLogin')
    state.normalUserNotifyMd5Cookie = fieldOf(html, 'normalUserNotifyMd5Cookie')
    state.lastUserId = fieldOf(html, 'lastUserId')
    state.readPasswordFromCookie = fieldOf(html, 'readPasswordFromCookie')
    state.passwordInCookie = fieldOf(html, 'passwordInCookie')
    state.userIdInCookie = fieldOf(html, 'userIdInCookie')
    state.commonDisclaimerEnable = fieldOf(html, 'commonDisclaimerEnable')
    state.disclaimerTitle = fieldOf(html, 'disclaimerTitle')
    state.disclaimerLoginBtn = fieldOf(html, 'disclaimerLoginBtn')
    state.loginUrl = fieldOf(html, 'loginUrl')
    state.isEnableNickNameAuth = fieldOf(html, 'isEnableNickNameAuth')
  }
  return { status: 'ready', code: 0 }
}

/*
 * 账号密码登录。
 * POST 到 /ess/commonauth，kind=preLogin，密码 RSA 加密。
 */
async function login(serverBase, o) {
  var p = o.params || {}
  var state = o.state || {}
  // 确保已 loadConf（拿到 RSA 公钥）
  if (!state.module) {
    var conf = await loadConf(serverBase, p, state)
    if (conf.status !== 'ready') {
      return { ok: false, msg: conf.msg || '无法获取认证配置' }
    }
  }
  var password = o.password || ''
  var encPwd
  try {
    encPwd = encryptedString(state.module, state.exponent || '10001', password)
  } catch (e) {
    return { ok: false, msg: '密码加密失败: ' + describeErr(e) }
  }

  var form = {
    kind: 'preLogin',
    isSavePwd: 'true',
    isEnableNickNameAuth: state.isEnableNickNameAuth || '',
    mac: state.mac || p.clientmac || '',
    port: state.port || '0',
    urlBeforeLogon: state.urlBeforeLogon || 'http://1.2.3.4/',
    vid: state.vid || '',
    ssid: state.ssid || '',
    apmac: state.apmac || '',
    userIp: state.userIp || p.wlanuserip || '',
    t: state.t || 'wireless-v2',
    nasIp: state.nasIp || '',
    enableNormalUserLogin: state.enableNormalUserLogin || 'true',
    normalUserNotifyMd5Cookie: state.normalUserNotifyMd5Cookie || '',
    findPswUrl: state.findPswUrl || '',
    lastUserId: state.lastUserId || '',
    readPasswordFromCookie: state.readPasswordFromCookie || '',
    passwordInCookie: state.passwordInCookie || '',
    userIdInCookie: state.userIdInCookie || '',
    sccpServerPort: state.sccpServerPort || '53',
    sccpEncrytKey: state.sccpEncrytKey || '',
    sccpEncrytIV: state.sccpEncrytIV || '',
    sccpClientPort: state.sccpClientPort || '138',
    sccpServerIp: state.sccpServerIp || '',
    sccpTimestamp: state.sccpTimestamp || '',
    commonDisclaimerEnable: state.commonDisclaimerEnable || 'false',
    disclaimerTitle: state.disclaimerTitle || '',
    disclaimerLoginBtn: state.disclaimerLoginBtn || '',
    loginUrl: state.loginUrl || 'commonauth',
    loginActionName: state.loginActionName || serverBase + '/ess/commonauth',
    isSubmit: '1',
    exponent: state.exponent || '10001',
    module: state.module,
    isFromCookie: 'false',
    encryptIp: state.encryptIp || '',
    userId: o.username || '',
    password: encPwd,
    enableCookie: 'true',
  }

  var action = state.loginActionName || serverBase + '/ess/commonauth'
  if (action.indexOf('http') !== 0) {
    action = serverBase + '/' + action.replace(/^\.?\//, '')
  }
  var res = await httpPost(action, form)
  if (!res.ok) {
    return { ok: false, msg: res.msg }
  }
  var text = sanitize(res.text)
  if (/认证失败|failure|用户不存在|密码错误/i.test(text)) {
    return { ok: false, msg: '认证失败：用户名或密码错误' }
  }
  if (/认证成功|success/i.test(text)) {
    return { ok: true, code: 0 }
  }
  // 无法判断，返回原始片段
  return { ok: false, msg: '认证结果未知: ' + text.slice(0, 100) }
}

/* 认证状态查询: 重新 GET 认证页，若返回非认证页则已认证 */
async function queryStat(serverBase, o) {
  var p = (o && o.params) || {}
  var url = serverBase + '/ess/commonauth'
  if (p && p.portalPage) url = p.portalPage
  var res = await httpGet(url)
  if (!res.ok) return { ok: false }
  var html = res.text
  var module = fieldOf(html, 'module')
  if (!module) {
    // 无 RSA 公钥 = 已认证或非认证页
    return { ok: true, stat: 1 }
  }
  return { ok: true, stat: 0 }
}

/* 下线: ESS 无标准 API，返回不支持 */
async function logout(serverBase, o) {
  return { ok: false, msg: 'ESS 不支持 API 下线' }
}

/*
 * 自动识别评分 (0-100):
 *   URL 含 /ess/commonauth (60 分)
 *   URL 含 wlanuserip 参数 (20 分)
 *   页面含 sccpEncrytKey / commonauth (20 分)
 */
function match(ctx) {
  var score = 0
  var u = String((ctx && ctx.portalPage) || '')
  var text = String((ctx && ctx.snippet) || '') + ' ' + String((ctx && ctx.pageTitle) || '')
  if (/\/ess\/commonauth/i.test(u)) score += 60
  if (/wlanuserip=/i.test(u)) score += 20
  if (/sccpEncrytKey|commonauth|ess/i.test(text)) score += 20
  return Math.min(score, 100)
}

export const huaweiEss = {
  id: 'huawei-ess',
  name: '华为 ESS 认证',
  match: match,
  loadConf: loadConf,
  login: login,
  queryStat: queryStat,
  logout: logout,
}
