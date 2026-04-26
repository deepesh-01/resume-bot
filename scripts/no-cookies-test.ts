import { chromium as chromiumExtra } from 'playwright-extra'
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

chromiumExtra.use(StealthPlugin())

const main = async () => {
  for (let i = 0; i < 3; i++) {
    const browser = await chromiumExtra.launch({ headless: true })
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    })
    // NO cookies at all
    const page = await ctx.newPage()
    await page
      .goto('https://www.linkedin.com/jobs/view/4400097953/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      .catch(() => null)
    await page.waitForTimeout(2000)
    const url = page.url()
    const title = (await page.title()).slice(0, 80)
    const wall = /\/(login|uas\/login|authwall|checkpoint)/.test(url)
    console.log(
      `attempt ${i + 1}: wall=${wall} title="${title}" url=${url.slice(0, 100)}`,
    )
    await browser.close()
    await new Promise((r) => setTimeout(r, 2000))
  }
}
main()
