import { BasePage } from './base-page.js'
import { log, initLog } from './services/logger.js'

const DESIGN_WIDTH = 960 // 有道词典笔 melon_pro: 屏幕 960x266 (direction 270)

class App extends $falcon.App {
  constructor() {
    super()
  }

  onLaunch(options) {
    super.onLaunch(options)
    this.setViewPort(DESIGN_WIDTH)
    $falcon.useDefaultBasePageClass(BasePage)
    initLog()
    log('应用', 'onLaunch appid=' + (globalThis.$appid || ''))
    try {
      console.log('[wifi-login] env=' + JSON.stringify($falcon.env))
    } catch (e) {}
  }

  onShow() {
    super.onShow()
  }

  onHide() {
    super.onHide()
  }

  onDestroy() {
    super.onDestroy()
  }
}

try {
  globalThis['window'] = {
    requestAnimationFrame,
    cancelAnimationFrame,
  }
} catch (err) {
  console.log(err)
}

try {
  globalThis['process'] = {
    env: {
      NODE_ENV: 'production',
    },
  }
} catch (err) {
  console.log(err)
}

// 联调开关: 需要跳过连通性测试直连指定服务器时, 设为
// { server: 'http://IP:端口', username: 'x', password: 'y' }
globalThis['__WIFI_LOGIN_DEBUG'] = null

export default App
