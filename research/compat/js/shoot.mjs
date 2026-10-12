// Screenshot the Cockpit against a live gateway.  node shoot.mjs <cockpitUrl> <gatewayUrl> <apiKey> <outDir>
import { chromium } from 'playwright'
import fs from 'node:fs'
const [cockpit, gateway, key, out] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const pages = ['/', '/approvals', '/traces', '/violations', '/policies', '/dsl', '/agents', '/audit-log', '/alignment', '/coverage', '/scan', '/proxy', '/rollbacks', '/settings']
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
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false })
    console.log('shot', name, await page.title())
  } catch (e) { console.log('fail', name, String(e).slice(0, 120)) }
}
await browser.close()
