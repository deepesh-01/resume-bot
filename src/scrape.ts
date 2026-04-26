import fs from 'node:fs/promises'
// playwright-extra with stealth plugin masks the automation fingerprint
// LinkedIn uses to flag scrapers (navigator.webdriver, missing chrome runtime,
// specific permissions API quirks, etc.). Falls back gracefully if either pkg
// shape changes — chromium import path stays the same.
import { chromium as chromiumExtra } from 'playwright-extra'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- types not great
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { BrowserContext, Page } from 'playwright'
import { config } from './config.js'
import { logger } from './logger.js'

// Apply stealth once at module load.
chromiumExtra.use(StealthPlugin())

export class ScrapeError extends Error {
  constructor(
    public code: 'SCRAPE_FAILED' | 'SCRAPE_AUTH_WALL' | 'JD_TOO_SHORT',
    message: string,
  ) {
    super(message)
    this.name = 'ScrapeError'
  }
}

// §13.3 timeouts.
const SCRAPE_NAV_TIMEOUT_MS = 30_000
const MIN_JD_CHARS = 200

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface CookieEditorEntry {
  name: string
  value: string
  domain: string
  path: string
  expirationDate?: number
  httpOnly: boolean
  secure: boolean
  sameSite: string | null
  session: boolean
}

interface PlaywrightCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

const sameSiteMap: Record<string, 'Strict' | 'Lax' | 'None'> = {
  no_restriction: 'None',
  strict: 'Strict',
  lax: 'Lax',
}

const transformCookies = (raw: CookieEditorEntry[]): PlaywrightCookie[] => {
  const out: PlaywrightCookie[] = []
  for (const c of raw) {
    if (c.session && !c.expirationDate) continue
    const cookie: PlaywrightCookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
    }
    if (c.expirationDate) cookie.expires = c.expirationDate
    if (c.sameSite) {
      const mapped = sameSiteMap[c.sameSite.toLowerCase()]
      if (mapped) cookie.sameSite = mapped
    }
    out.push(cookie)
  }
  return out
}

const loadLinkedInCookies = async (): Promise<PlaywrightCookie[]> => {
  try {
    const raw = await fs.readFile(config.PLAYWRIGHT_LINKEDIN_COOKIE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as CookieEditorEntry[]
    return transformCookies(parsed)
  } catch (err) {
    logger.warn({ err }, 'failed to load LinkedIn cookies')
    return []
  }
}

const isLinkedIn = (url: string): boolean => /linkedin\.com/i.test(url)

// LinkedIn embeds a sign-in widget on EVERY public page (job view included),
// so selector-based detection produced false positives. The reliable signal is
// the URL: a real auth wall redirects to /authwall, /login, /uas/login, or
// /checkpoint. Public job pages keep the original /jobs/view/<id>/ path.
const detectAuthWall = (page: Page): boolean =>
  /\/(login|uas\/login|authwall|checkpoint)/i.test(page.url())

const tryExtract = async (
  page: Page,
  selectors: string[],
): Promise<string> => {
  for (const sel of selectors) {
    const el = page.locator(sel).first()
    if ((await el.count()) === 0) continue
    const text = (await el.innerText().catch(() => '')).trim()
    if (text.length > 100) return text
  }
  return ''
}

const extractMeta = async (
  page: Page,
  url: string,
): Promise<{ role?: string; company?: string }> => {
  let title = ''
  try {
    title = (await page.title()) || ''
  } catch {
    /* ignore */
  }
  if (!title) return {}

  // LinkedIn: two known title shapes.
  // 1. Logged-in view: "Role | Company | LinkedIn" (sometimes "Role" itself
  //    contains a hyphen-separated team qualifier — keep as-is).
  // 2. Public view:    "Company hiring Role in Location | LinkedIn"
  if (isLinkedIn(url)) {
    const liHiring = /^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+|\s+\|)/i.exec(title)
    if (liHiring?.[1] && liHiring[2]) {
      return { company: liHiring[1].trim(), role: liHiring[2].trim() }
    }
    const segs = title
      .split(/\s*\|\s*/)
      .map((s) => s.trim())
      .filter((s) => s && !/^linkedin$/i.test(s))
    if (segs[0] && segs[1]) return { role: segs[0], company: segs[1] }
    if (segs[0]) return { role: segs[0] }
  }

  // Generic boards: "Role at Company" / "Role - Company" / "Role | Company".
  const dash = /^(.+?)\s+(?:at|@|-|–|—|\|)\s+(.+?)(?:\s*[-|].*)?$/.exec(title)
  if (dash?.[1] && dash[2]) {
    return { role: dash[1].trim(), company: dash[2].trim() }
  }

  return {}
}

export interface ScrapeResult {
  jdText: string
  role?: string
  company?: string
}

const MAX_AUTHWALL_RETRIES = 2
const RETRY_BASE_DELAY_MS = 4000

const tryScrapeOnce = async (url: string): Promise<ScrapeResult> => {
  const browser = await chromiumExtra.launch({ headless: true })
  let context: BrowserContext | undefined
  try {
    context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    })
    // Note: NOT loading the LinkedIn cookies. Empirically a stale `li_at`
    // triggers LinkedIn's "invalid session" detection and causes
    // probabilistic auth-wall redirects on public job pages. Stealth + no
    // cookies = far more reliable. Cookie file remains available in env in
    // case future flows need authenticated views.
    const page = await context.newPage()

    try {
      await page.goto(url, {
        timeout: SCRAPE_NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      })
    } catch (err) {
      throw new ScrapeError(
        'SCRAPE_FAILED',
        `goto failed: ${String(err).slice(0, 200)}`,
      )
    }

    // Let JS-rendered content settle.
    await page.waitForTimeout(2000)

    if (detectAuthWall(page)) {
      throw new ScrapeError(
        'SCRAPE_AUTH_WALL',
        `auth wall on ${page.url()}`,
      )
    }

    const linkedInSelectors = [
      '.show-more-less-html__markup',
      '.description__text',
      '.jobs-description__content',
      '.jobs-box__html-content',
      '.jobs-description-content__text',
    ]
    const genericSelectors = ['main', 'article', 'body']

    const jdText = isLinkedIn(url)
      ? (await tryExtract(page, linkedInSelectors)) ||
        (await tryExtract(page, genericSelectors))
      : await tryExtract(page, genericSelectors)

    if (jdText.length < MIN_JD_CHARS) {
      throw new ScrapeError(
        'JD_TOO_SHORT',
        `extracted ${jdText.length} chars`,
      )
    }

    const meta = await extractMeta(page, url)
    return { jdText, role: meta.role, company: meta.company }
  } finally {
    await context?.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

// LinkedIn's bot detection is probabilistic — same URL flips between auth
// wall and clean page across attempts. Retry on AUTH_WALL specifically with
// jittered backoff. Other errors (JD_TOO_SHORT, SCRAPE_FAILED) propagate.
export const scrape = async (url: string): Promise<ScrapeResult> => {
  let lastErr: ScrapeError | undefined
  for (let attempt = 0; attempt <= MAX_AUTHWALL_RETRIES; attempt++) {
    try {
      return await tryScrapeOnce(url)
    } catch (err) {
      if (
        err instanceof ScrapeError &&
        err.code === 'SCRAPE_AUTH_WALL' &&
        attempt < MAX_AUTHWALL_RETRIES
      ) {
        const delay =
          RETRY_BASE_DELAY_MS * (attempt + 1) +
          Math.floor(Math.random() * 2000)
        logger.warn(
          { attempt: attempt + 1, delay, url },
          'auth wall hit, backing off and retrying',
        )
        await new Promise((r) => setTimeout(r, delay))
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr ?? new ScrapeError('SCRAPE_FAILED', 'unknown')
}
