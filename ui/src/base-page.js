/*
 * 页面基类: 统一管理 $falcon.on 事件 token、setTimeout/setInterval,
 * 页面卸载时全部释放, 防止残留 timer / 订阅。
 */

const DEBUG = false

class PageRes extends $falcon.Page {
  constructor() {
    super()
    this.falconOnTokens = [] // [[token, name], ...]
    this.timeoutTokens = new Set()
    this.intervalTokens = new Set()
  }

  on(name, callback) {
    const token = $falcon.on(name, callback)
    this.falconOnTokens.push([token, name])
    return token
  }

  off(name) {
    const kept = []
    for (let i = 0; i < this.falconOnTokens.length; i++) {
      const pair = this.falconOnTokens[i]
      if (pair[1] === name) {
        continue
      }
      kept.push(pair)
    }
    this.falconOnTokens = kept
    $falcon.off(name)
  }

  trigger(name, options) {
    $falcon.trigger(name, options)
  }

  setTimeout(func, ms) {
    const token = setTimeout(() => {
      this.timeoutTokens.delete(token)
      func()
    }, ms)
    this.timeoutTokens.add(token)
    return token
  }

  setInterval(func, ms) {
    const token = setInterval(func, ms)
    this.intervalTokens.add(token)
    return token
  }

  clearTimeout(token) {
    this.timeoutTokens.delete(token)
    clearTimeout(token)
  }

  clearInterval(token) {
    this.intervalTokens.delete(token)
    clearInterval(token)
  }

  release() {
    for (let i = 0; i < this.falconOnTokens.length; i++) {
      const pair = this.falconOnTokens[i]
      DEBUG && console.log(`release $falcon.on token ${pair[0]}`)
      try {
        $falcon.off(pair[1], pair[0])
      } catch (e) {
        console.log(`release token failed: ${e}`)
      }
    }
    this.falconOnTokens.length = 0
    this.timeoutTokens.forEach((token) => {
      clearTimeout(token)
    })
    this.timeoutTokens.clear()
    this.intervalTokens.forEach((token) => {
      clearInterval(token)
    })
    this.intervalTokens.clear()
  }
}

export class BasePage extends PageRes {
  constructor() {
    super()
  }

  async sleep(ms) {
    return new Promise((resolve) => {
      this.setTimeout(() => {
        resolve()
      }, ms)
    })
  }

  onLoad(options) {
    super.onLoad(options)
    this.options = options
  }

  onNewOptions(options) {
    super.onNewOptions(options)
    this.options = options
    if (this.$root && this.$root.onNewOptions) {
      this.$root.onNewOptions(options)
    }
  }

  onShow() {
    super.onShow()
    if (this.$root && this.$root.onShow) {
      this.$root.onShow()
    }
  }

  onHide() {
    super.onHide()
    if (this.$root && this.$root.onHide) {
      this.$root.onHide()
    }
  }

  onUnload() {
    try {
      super.onUnload()
      if (this.$root && this.$root.onUnload) {
        this.$root.onUnload()
      }
    } finally {
      this.release()
    }
  }

  beforeVueInstantiate(Vue) {
    try {
      Vue.prototype.$workspace = globalThis.$workspace
      Vue.prototype.$appid = globalThis.$appid
    } catch (err) {
      console.log(err)
    }
  }
}
