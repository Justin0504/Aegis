// Screenshot the Cockpit against a live gateway.  node shoot.mjs <cockpitUrl> <gatewayUrl> <apiKey> <outDir>
import { chromium } from 'playwright'
import fs from 'node:fs'
const [cockpit, gateway, key, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const pages = process.env.SHOOT_PAGES ? process.env.SHOOT_PAGES.split(',') : ['/', '/approvals', '/traces', '/violations', '/policies', '/dsl', '/agents', '/audit-log', '/alignment', '/coverage', '/scan', '/proxy', '/rollbacks', '/compliance', '/memory', '/settings']
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })
await ctx.addInitScript(({ key, gateway }) => {
  try { localStorage.setItem('aegis:api_key', key); localStorage.setItem('aegis:gateway_url', gateway); localStorage.setItem('aegis:first_launch_done', '1'); localStorage.setItem('aegis:onboarded', '1'); localStorage.setItem('aegis:license', JSON.stringify({ key: 'demo-enterprise', valid: true, plan: 'enterprise', tier: 'enterprise' })) } catch {}
}, { key, gateway })
const page = await ctx.newPage()
for (const p of pages) {
  const name = p === '/' ? 'overview' : p.slice(1).replace(/\//g, '-')
  try {
    await page.goto(cockpit + p, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(1200)
    // toasts are live-feed noise, not evidence; the traces page shows the
    // detail pane for the first row, which is what the caption describes
    await page.addStyleTag({ content: '[data-sonner-toaster]{display:none !important}' })
    if (p === '/scan') {
      // the scanner wants a repository; the demo agent's is the one the paper describes
      const input = page.locator('input[placeholder*="repo"]').first()
      if (await input.count()) {
        await input.fill(process.env.SCAN_REPO || `${process.env.HOME}/agentguard/demo/live-agent`)
        await page.getByRole('button', { name: /^Scan$/ }).first().click()
        await page.waitForTimeout(8000)
      }
    }
    if (p === '/alignment') {
      // the caption says "per-call verdicts": run the starter case so one is on screen
      const btn = page.getByRole('button', { name: /^Audit$/ }).first()
      if (await btn.count()) { await btn.click(); await page.waitForTimeout(45000) }
    }
    if (p === '/traces' && process.env.SHOOT_RUNS) {
      // the Runs tab: open a run that was held, and expand the held step
      const held = page.getByText('Held for review').first()
      if (await held.count()) { await held.click(); await page.waitForTimeout(900) }
    } else if (p === '/traces') {
      const first = page.locator('[data-trace-row], [data-testid="trace-row"]').first()
      if (await first.count()) { await first.click(); await page.waitForTimeout(900) }
      else {
        const card = page.getByText(/^Ran |^Queried /).first()
        if (await card.count()) { await card.click(); await page.waitForTimeout(900) }
      }
    }
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false })
    console.log('shot', name, await page.title())
  } catch (e) { console.log('fail', name, String(e).slice(0, 120)) }
}
await browser.close()
