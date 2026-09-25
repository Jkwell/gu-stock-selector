/** 移动导航冒烟测试。运行时需要提供含 playwright 的 NODE_PATH。 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173'

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
})
try {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await mobile.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await mobile.locator('.mobile-tabbar').waitFor({ state: 'visible' })

  const mobileBar = mobile.locator('.mobile-tabbar')
  if (!(await mobileBar.isVisible())) throw new Error('手机底部导航未显示')
  if (await mobileBar.locator('button').count() !== 5) throw new Error('手机导航入口数量不正确')
  if (await mobile.locator('.tabs').isVisible()) throw new Error('手机端桌面导航未隐藏')
  const pageFits = await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  if (!pageFits) throw new Error('手机页面存在横向溢出')

  await mobile.getByRole('button', { name: '更多' }).click()
  if (!(await mobile.locator('#mobile-more-menu').isVisible())) throw new Error('更多面板未打开')
  await mobile.getByRole('button', { name: /策略回测/ }).click()
  if (await mobile.locator('#mobile-more-menu').count() !== 0) throw new Error('更多面板未关闭')
  if (!(await mobile.getByRole('heading', { name: /策略回测/ }).isVisible())) throw new Error('策略回测页未打开')
  if (process.env.SCREENSHOT_PATH) {
    await mobile.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  }

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await desktop.locator('.tabs').waitFor({ state: 'visible' })
  if (!(await desktop.locator('.tabs').isVisible())) throw new Error('桌面导航未显示')
  if (await desktop.locator('.mobile-tabbar').isVisible()) throw new Error('桌面端显示了手机导航')
} finally {
  await browser.close()
}

console.log('mobile navigation verification passed')
