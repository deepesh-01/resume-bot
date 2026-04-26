// Diagnose LinkedIn cookie state.
// Tries multiple URLs and reports what we hit so we can tell whether cookies
// are dead vs LinkedIn is detecting us as a bot vs route-specific block.

import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { config } from '../src/config.js'

const URLS = [
  'https://www.linkedin.com/feed/',
  'https://www.linkedin.com/jobs/',
  'https://www.linkedin.com/jobs/view/4400097953/',
]

const main = async () => {
  const cookies = JSON.parse(
    await fs.readFile(config.PLAYWRIGHT_LINKEDIN_COOKIE_PATH, 'utf8'),
  )
  const transformed = cookies
    .filter((c: any) => !c.session || c.expirationDate)
    .map((c: any) => {
      const o: any = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
      }
      if (c.expirationDate) o.expires = c.expirationDate
      const m: any = { no_restriction: 'None', strict: 'Strict', lax: 'Lax' }
      if (c.sameSite && m[c.sameSite]) o.sameSite = m[c.sameSite]
      return o
    })
  console.log(`Loaded ${transformed.length} cookies (li_at present: ${transformed.some((c: any) => c.name === 'li_at')})`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  await ctx.addCookies(transformed)
  const page = await ctx.newPage()

  for (const url of URLS) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(2000)
      const finalUrl = page.url()
      const title = await page.title()
      const isAuthWall = /\/(login|uas\/login|authwall|checkpoint)/i.test(finalUrl)
      console.log(`\n→ ${url}`)
      console.log(`  final: ${finalUrl}`)
      console.log(`  title: ${title}`)
      console.log(`  authwall: ${isAuthWall}`)
      // Look for signed-in markers
      const hasSearch = (await page.locator('input.search-global-typeahead__input').count()) > 0
      const hasMyNetwork = (await page.locator('a[href*="/mynetwork/"]').count()) > 0
      console.log(`  signed-in markers: search=${hasSearch} mynetwork=${hasMyNetwork}`)
    } catch (err) {
      console.log(`\n→ ${url}`)
      console.log(`  error: ${String(err).slice(0, 200)}`)
    }
  }

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
