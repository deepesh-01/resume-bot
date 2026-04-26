// Inspect what LinkedIn returns so we know which selectors to use.
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { config } from '../src/config.js'

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

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  await ctx.addCookies(transformed)
  const page = await ctx.newPage()
  await page.goto('https://www.linkedin.com/jobs/view/4400097953/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await page.waitForTimeout(3000)

  console.log('URL after nav:', page.url())
  console.log('TITLE:', await page.title())

  // Try a wide net of company/role candidates and report what's present.
  const candidates = [
    '.topcard__org-name-link',
    '.jobs-unified-top-card__company-name',
    'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
    '.job-details-jobs-unified-top-card__company-name',
    '.topcard__title',
    '.jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title',
    'h1.t-24',
    'h1',
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ]
  for (const sel of candidates) {
    const count = await page.locator(sel).count()
    if (count === 0) {
      console.log(`  [ ] ${sel} (0 matches)`)
      continue
    }
    if (sel.startsWith('meta')) {
      const v = await page.locator(sel).first().getAttribute('content')
      console.log(`  [✓] ${sel} → "${v?.slice(0, 80)}"`)
    } else {
      const t = (await page.locator(sel).first().innerText().catch(() => ''))
        .replace(/\n/g, ' ')
        .slice(0, 80)
      console.log(`  [✓] ${sel} → "${t}"`)
    }
  }

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
