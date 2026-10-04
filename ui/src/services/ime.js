/*
 * 系统输入法封装 —— skill 的 global.startTextEdit 状态机, 按本机实测修正。
 * 适配要点 (来自 bilibili 工程同固件的实战经验):
 *   - textEditFinished 回调可能携带多个参数: 第一个是会话 UUID (去掉横线的 32 位
 *     hex), 文本在后续参数里; 只读第一个参数会把 UUID 当成输入文本。
 *   - UUID 比对需归一化 (startTextEdit 返回带横线, 回调常不带)。
 *   - shouldCloseOnConfirm:false 不让输入法自行销毁会话, 拿到结果后自己
 *     closeTextEdit, 避免对已失效 UUID 关闭导致原生崩溃。
 *   - finish 回调内禁止对原生 payload 直接 stringify (循环引用会杀死进程),
 *     任何异常都必须消化在回调里。
 *   - 双通道订阅: Global 实例信号 + $falcon 全局事件, on/off 严格配对。
 *   - 关闭后立刻重开会被输入法忽略: 保持 >=600ms 间隔, 失败重试一次。
 */

import globalModule from 'global'

var manager = null

function getManager() {
  if (!manager) manager = new globalModule.Global()
  return manager
}

function safeStringify(v) {
  try {
    return JSON.stringify(v)
  } catch (e) {
    return '[unserializable]'
  }
}

function asObject(payload) {
  var d = payload
  // FalconEvent 包装 {type, timestamp, data}
  if (d && typeof d === 'object' && (d.type === 'textEditFinished' || (d.data !== undefined && d.timestamp !== undefined))) {
    d = d.data
  }
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch (e) {
      return { __raw: d }
    }
  }
  return d
}

function normalizeUuid(s) {
  return typeof s === 'string' ? s.replace(/-/g, '').toLowerCase() : ''
}

function looksLikeUuid(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)
  )
}

function extractText(d) {
  if (typeof d === 'string') return d
  if (!d || typeof d !== 'object') return ''
  var keys = ['value', 'text', 'content', 'result', 'inputText']
  for (var i = 0; i < keys.length; i++) {
    if (typeof d[keys[i]] === 'string') return d[keys[i]]
  }
  if (typeof d.__raw === 'string') return d.__raw
  return ''
}

function extractConfirmed(d) {
  if (!d || typeof d !== 'object') return null
  var keys = ['editConfirmed', 'confirm', 'confirmed', 'ok', 'confirmedResult']
  for (var i = 0; i < keys.length; i++) {
    if (d[keys[i]] === true) return true
    if (d[keys[i]] === false) return false
  }
  return null
}

var REOPEN_GAP_MS = 600

export class SystemIme {
  constructor() {
    this.currentUuid = null
    this.resolver = null
    this.subscribed = false
    this.attached = false
    this.lastCloseAt = 0
    var self = this
    this._finishHandler = function () {
      self.finish.apply(self, arguments)
    }
  }

  subscribe() {
    if (this.subscribed) return
    this.subscribed = true
    try {
      getManager().textEditFinished.on(this._finishHandler)
    } catch (e) {}
    try {
      $falcon.on('textEditFinished', this._finishHandler)
    } catch (e) {}
  }

  unsubscribe() {
    if (!this.subscribed) return
    this.subscribed = false
    try {
      getManager().textEditFinished.off(this._finishHandler)
    } catch (e) {}
    try {
      $falcon.off('textEditFinished', this._finishHandler)
    } catch (e) {}
  }

  closeSession() {
    if (this.currentUuid !== null && this.currentUuid !== undefined) {
      var uuid = this.currentUuid
      this.currentUuid = null
      this.lastCloseAt = Date.now()
      try {
        getManager().closeTextEdit(uuid)
      } catch (e) {}
    }
  }

  finish() {
    // 顶层兜底: 回调内异常一旦逃回原生派发器就是整个进程崩溃
    try {
      if (this.resolver === null) return

      // 收集全部回调参数逐个解析 (UUID 与结果 JSON 可能分参数下发)
      var args = []
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i])

      var myUuid = normalizeUuid(this.currentUuid)
      var cbUuid = null
      var text = ''
      var hasTextKey = false
      var confirmed = null

      for (var k = 0; k < args.length; k++) {
        var d = asObject(args[k])
        if (d === null || d === undefined) continue

        if (typeof d === 'object' && !Array.isArray(d)) {
          if (typeof d.uuid === 'string' && cbUuid === null) cbUuid = d.uuid
          var t = extractText(d)
          var keyed =
            typeof d.value === 'string' ||
            typeof d.text === 'string' ||
            typeof d.content === 'string' ||
            typeof d.result === 'string' ||
            typeof d.inputText === 'string'
          if (t !== '' && normalizeUuid(t) !== myUuid) {
            if (keyed || !hasTextKey) {
              text = t
              hasTextKey = hasTextKey || keyed
            }
          }
          var c = extractConfirmed(d)
          if (c !== null) confirmed = c
        } else if (typeof d === 'string') {
          if (cbUuid === null && looksLikeUuid(d)) cbUuid = normalizeUuid(d)
          if (text === '' && normalizeUuid(d) !== myUuid && !looksLikeUuid(d)) {
            text = d
          }
        }
      }

      // UUID 过滤: 归一化比较, 仅当两边都有值且不匹配时忽略
      if (myUuid && cbUuid && normalizeUuid(cbUuid) !== myUuid) return

      // 无明确确认标志时, 有文本视为确认
      if (confirmed === null) confirmed = text !== ''

      var r = this.resolver
      this.resolver = null
      this.unsubscribe()
      this.closeSession()
      if (r) r(confirmed ? text : null)
    } catch (e) {
      var r2 = this.resolver
      this.resolver = null
      try {
        this.unsubscribe()
      } catch (e2) {}
      try {
        this.closeSession()
      } catch (e2) {}
      if (r2) r2(null)
    }
  }

  /*
   * 打开系统输入法, 返回 Promise<string|null>。
   * opts: { text, placeholder, maxlength, enterButtonText }
   * 确认返回输入文本, 取消/失败返回 null。
   */
  open(opts) {
    var self = this
    this.ensureGap()
    return new Promise(function (resolve) {
      setTimeout(function () {
        self.openNow(opts, resolve, 1)
      }, self.gapWait())
    })
  }

  ensureGap() {
    // 关闭后立刻重开会被输入法忽略, open() 里先补足间隔
  }

  gapWait() {
    var now = Date.now()
    if (now - this.lastCloseAt < REOPEN_GAP_MS) {
      return REOPEN_GAP_MS - (now - this.lastCloseAt)
    }
    return 0
  }

  openNow(opts, resolve, retriesLeft) {
    var self = this
    var o = opts || {}

    this.cleanup()
    this.subscribe()
    this.resolver = resolve

    var cfg = {
      text: o.text || '',
      placeholder: o.placeholder || '',
      maxlength: o.maxlength || 64,
      maxLength: o.maxlength || 64,
      inputType: 'ZhCNPreferred',
      autofocus: true,
      showCursor: true,
      cursorIndex: (o.text || '').length,
      enterButtonText: o.enterButtonText || '确定',
      confirmText: o.enterButtonText || '确定',
      // 不让输入法自行销毁会话, 由 finish 拿到结果后统一关闭
      shouldCloseOnConfirm: false,
      closeButtonVisible: true,
      returnButtonVisible: true,
      micInputVisible: false,
      multiLinesEditVisible: false,
    }

    var uuid = null
    try {
      uuid = getManager().startTextEdit(safeStringify(cfg))
    } catch (e) {
      uuid = null
    }
    if (uuid && typeof uuid === 'object' && uuid.uuid) uuid = uuid.uuid

    if (!uuid) {
      // 打开失败 (常见于上一次会话刚结束): 间隔后重试一次
      this.cleanup()
      if (retriesLeft > 0) {
        setTimeout(function () {
          self.openNow(opts, resolve, retriesLeft - 1)
        }, REOPEN_GAP_MS)
      } else {
        resolve(null)
      }
      return
    }
    this.currentUuid = uuid
  }

  cleanup() {
    this.unsubscribe()
    this.closeSession()
    if (this.resolver) {
      var r = this.resolver
      this.resolver = null
      r(null)
    }
  }

  cancel() {
    this.cleanup()
  }

  destroy() {
    this.cleanup()
  }
}
