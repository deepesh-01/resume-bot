// Direct scrape smoke — verifies Playwright + cookie loading + selectors work
// before we wire the full job pipeline through Telegram.

import { scrape, ScrapeError } from '../src/scrape.js'

const URL =
  process.argv[2] ?? 'https://www.linkedin.com/jobs/view/4400097953/'

const main = async (): Promise<void> => {
  console.log(`scraping: ${URL}`)
  const start = Date.now()
  try {
    const r = await scrape(URL)
    const ms = Date.now() - start
    console.log(`✅ ok in ${ms}ms`)
    console.log(`   role:    ${r.role ?? '(unknown)'}`)
    console.log(`   company: ${r.company ?? '(unknown)'}`)
    console.log(`   chars:   ${r.jdText.length}`)
    console.log(`   first 200 chars:`)
    console.log(`     ${r.jdText.slice(0, 200).replace(/\n/g, ' ')}`)
  } catch (err) {
    if (err instanceof ScrapeError) {
      console.error(`❌ ${err.code}: ${err.message}`)
    } else {
      console.error(`❌ unexpected: ${err}`)
    }
    process.exit(1)
  }
}

main()
