/**
 * The "rewrite one line" ledger: a small trace chain computed in the
 * browser with WebCrypto. Each row's hash is SHA-256 over the row and the
 * hash above it. The hashes computed on load are the recorded ones and the
 * last of them is the anchored head. A visitor can edit a call or flip a
 * verdict; verification then fails from that row on. "Forge the hashes"
 * rewrites every recorded hash to match, which only moves the break to
 * the head, because the anchored head does not change.
 */

const GENESIS = '0'.repeat(64);
const enc = new TextEncoder();
// Clicking cycles block → allow → hold → block: the first click is the cover-up.
const VERDICTS = ['allow', 'hold', 'block'] as const;

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function init(root: HTMLElement) {
  if (!globalThis.crypto?.subtle) return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-row]'));
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const forgeBtn = root.querySelector<HTMLButtonElement>('[data-forge]')!;
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-reset]')!;
  const original = rows.map((r) => ({
    verdict: r.querySelector<HTMLElement>('[data-verdict]')!.dataset.verdict!,
    call: r.querySelector<HTMLElement>('[data-call]')!.textContent!,
  }));
  let recorded: string[] = [];
  let anchored = '';

  const read = (r: HTMLElement) => ({
    seq: r.dataset.seq!,
    agent: r.dataset.agent!,
    verdict: r.querySelector<HTMLElement>('[data-verdict]')!.dataset.verdict!,
    call: (r.querySelector<HTMLElement>('[data-call]')!.textContent || '').trim(),
  });
  const line = (x: ReturnType<typeof read>, prev: string) =>
    [x.seq, x.agent, x.verdict, x.call, prev].join('|');

  // Each row is checked against the recorded hash above it, as a verifier
  // walking the stored chain would.
  async function computeAgainstRecorded() {
    const out: string[] = [];
    for (let i = 0; i < rows.length; i++) out.push(await sha256(line(read(rows[i]), i ? recorded[i - 1] : GENESIS)));
    return out;
  }
  async function computeFresh() {
    const out: string[] = [];
    for (let i = 0; i < rows.length; i++) out.push(await sha256(line(read(rows[i]), i ? out[i - 1] : GENESIS)));
    return out;
  }

  async function verify() {
    const now = await computeAgainstRecorded();
    const bad = now.findIndex((h, i) => h !== recorded[i]);
    const head = recorded[recorded.length - 1];
    rows.forEach((r, i) => {
      const state = bad < 0 || i < bad ? 'ok' : i === bad ? 'bad' : 'lost';
      r.dataset.state = state;
      r.querySelector<HTMLElement>('[data-hash]')!.textContent = recorded[i].slice(0, 12);
      r.querySelector<HTMLElement>('[data-now]')!.textContent = state === 'bad' ? now[i].slice(0, 12) : '';
    });
    const edited = rows.some((r, i) => {
      const x = read(r);
      return x.verdict !== original[i].verdict || x.call !== original[i].call.trim();
    });
    forgeBtn.hidden = bad < 0;
    resetBtn.hidden = !edited;
    if (bad >= 0) {
      root.dataset.state = 'bad';
      const n = rows.length - bad;
      status.innerHTML = `<b>✕ Record #${rows[bad].dataset.seq} no longer matches its hash.</b> Verification fails from there on — ${n} record${n > 1 ? 's' : ''} can no longer be trusted.`;
    } else if (head !== anchored) {
      root.dataset.state = 'head';
      status.innerHTML = `<b>✕ Every row checks out — but the head is <code>${head.slice(0, 12)}</code>, and the anchored head is <code>${anchored.slice(0, 12)}</code>.</b> The Merkle log and its witnesses still hold the original.`;
    } else {
      root.dataset.state = 'ok';
      status.innerHTML = `<b>✓ ${rows.length} of ${rows.length} records verify.</b> Head <code>${head.slice(0, 12)}</code> matches the anchored head.`;
    }
  }

  rows.forEach((r) => {
    const v = r.querySelector<HTMLButtonElement>('[data-verdict]')!;
    v.addEventListener('click', () => {
      const next = VERDICTS[(VERDICTS.indexOf(v.dataset.verdict as (typeof VERDICTS)[number]) + 1) % VERDICTS.length];
      v.dataset.verdict = next;
      v.textContent = next;
      verify();
    });
    const c = r.querySelector<HTMLElement>('[data-call]')!;
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); c.blur(); } });
    c.addEventListener('input', () => verify());
  });
  forgeBtn.addEventListener('click', async () => { recorded = await computeFresh(); verify(); });
  resetBtn.addEventListener('click', async () => {
    rows.forEach((r, i) => {
      const v = r.querySelector<HTMLElement>('[data-verdict]')!;
      v.dataset.verdict = original[i].verdict;
      v.textContent = original[i].verdict;
      r.querySelector<HTMLElement>('[data-call]')!.textContent = original[i].call;
    });
    recorded = await computeFresh();
    verify();
  });

  computeFresh().then((h) => {
    recorded = h;
    anchored = h[h.length - 1];
    root.dataset.live = '';
    verify();
  });
}

document.querySelectorAll<HTMLElement>('[data-tamper]').forEach(init);
