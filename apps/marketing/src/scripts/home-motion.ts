/**
 * Scroll choreography for the homepage.
 *
 * Lenis smooths the wheel; every frame, each scene reads how far the page
 * has scrolled through it and sets its elements' state directly. There is
 * no timeline library: a scene is a function of its own progress, so
 * scrolling back plays everything in reverse for free, and a resize only
 * has to re-measure.
 *
 *   hero    the headline is held (CSS sticky) while a field of photographs
 *           and product cards drifts up past it at three depths; the
 *           headline then goes out of focus line by line.
 *   focus   any [data-focus] line is sharp in the middle band of the
 *           viewport and blurs as it nears either edge.
 *   replay  one block from the demo fleet, held and scrubbed: the
 *           injected ticket, the call, the checks, the stamp, the refusal
 *           returning to the agent.
 *   tour    the live demo, held: a browser frame grows in and pages
 *           through the cockpit's screens as the chapter list advances.
 *   split   a held two-column stage: the photograph on the left grows in,
 *           then the steps cross-fade in place, picture and text together.
 *   drift   [data-drift] elements move at their own speed relative to the
 *           page (the evidence card's ghost words).
 *   grow    [data-grow] panels scale up to full width as they arrive.
 *
 * Reduced motion: no Lenis, no transforms; everything is shown in its
 * settled state (and the split section stacks, via CSS).
 */
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ramp = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const smooth = (t: number) => t * t * (3 - 2 * t);

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wide = window.matchMedia('(min-width: 881px)');
let vh = window.innerHeight;

type Scene = () => void;
const scenes: Scene[] = [];

/** Progress of a held section: 0 when its top reaches the viewport top,
 *  1 when its bottom reaches the viewport bottom. */
function heldProgress(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return clamp(-r.top / Math.max(1, r.height - vh));
}

// ── hero ─────────────────────────────────────────────────────────────
function hero() {
  const root = document.querySelector<HTMLElement>('[data-hero]');
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>('[data-z]')).map((el) => ({
    el,
    z: parseFloat(el.dataset.z || '0.5'),
    side: (parseFloat(el.dataset.x || '50') - 50) / 50,   // -1 left … +1 right
  }));
  const [l1, l2] = Array.from(root.querySelectorAll<HTMLElement>('.hero-h span'));
  const rest = root.querySelectorAll<HTMLElement>('[data-hero-rest]');
  const copy = root.querySelector<HTMLElement>('.hero-copy');
  // An animation's fill outranks inline style, so the entrance has to
  // be removed before the scroll scene can fade this block.
  rest.forEach((el) => el.addEventListener('animationend', () => {
    el.style.animation = 'none';
    frame();
  }, { once: true }));

  scenes.push(() => {
    const p = heldProgress(root);
    for (const it of items) {
      // Near cards travel further for the same scroll: that difference is
      // the depth. They also turn slightly toward the middle.
      const travel = vh * (1.5 + 1.9 * it.z);
      const y = -p * travel;
      const rot = -it.side * (6 + 10 * it.z);
      it.el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0) rotateY(${rot.toFixed(2)}deg)`;
    }
    const fadeRest = smooth(ramp(p, 0.16, 0.3));
    rest.forEach((el) => {
      el.style.opacity = String(1 - fadeRest);
      el.style.transform = `translateY(${(-24 * fadeRest).toFixed(1)}px)`;
    });
    const g1 = smooth(ramp(p, 0.4, 0.55));
    const g2 = smooth(ramp(p, 0.55, 0.7));
    if (l1) { l1.style.opacity = String(1 - 0.72 * g1); l1.style.filter = `blur(${(7 * g1).toFixed(2)}px)`; }
    if (l2 && !l2.classList.contains('entering')) {
      l2.style.opacity = String(1 - 0.72 * g2); l2.style.filter = `blur(${(7 * g2).toFixed(2)}px)`;
    }
    const out = smooth(ramp(p, 0.72, 0.9));
    if (copy) {
      copy.style.opacity = String(1 - out);
      copy.style.transform = `translateY(${(-40 * out).toFixed(1)}px)`;
    }
  });
}

// ── focus lines ──────────────────────────────────────────────────────
function focus() {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-focus]'));
  scenes.push(() => {
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -80 || r.top > vh + 80) continue;
      const d = Math.abs((r.top + r.height / 2 - vh * 0.5) / (vh * 0.5));
      const b = smooth(ramp(d, 0.38, 1.0));
      el.style.filter = b > 0.01 ? `blur(${(11 * b).toFixed(2)}px)` : 'none';
      el.style.opacity = String(1 - 0.82 * smooth(ramp(d, 0.5, 1.05)));
    }
  });
}

// ── held split section ───────────────────────────────────────────────
function split() {
  const root = document.querySelector<HTMLElement>('[data-split]');
  if (!root) return;
  const media = root.querySelector<HTMLElement>('.split-media');
  const layers = Array.from(root.querySelectorAll<HTMLElement>('.sm-layer'));
  const texts = Array.from(root.querySelectorAll<HTMLElement>('.st-step'));
  const n = layers.length;

  scenes.push(() => {
    if (!wide.matches) {
      // Stacked on small screens: undo anything a wide layout set.
      [media, ...layers, ...texts].forEach((el) => { if (el) { el.style.cssText = ''; } });
      return;
    }
    // Entry: the picture grows from an inset frame to the full half.
    const top = root.getBoundingClientRect().top;
    const e = smooth(ramp(1 - top / vh, 0, 1));
    if (media) {
      const i = (1 - e);
      media.style.clipPath = `inset(${(14 * i).toFixed(2)}% ${(22 * i).toFixed(2)}% ${(14 * i).toFixed(2)}% 0 round ${(18 + 10 * i).toFixed(1)}px)`;
    }
    // Steps cross-fade in place.
    const s = heldProgress(root) * n;
    for (let k = 0; k < n; k++) {
      const t = s - k;
      const inn = k === 0 ? 1 : smooth(ramp(t, -0.12, 0.12));
      const outn = k === n - 1 ? 1 : 1 - smooth(ramp(t, 0.88, 1.12));
      const v = Math.min(inn, outn);
      const L = layers[k], T = texts[k];
      if (L) {
        L.style.opacity = String(v);
        L.style.transform = `scale(${(1.05 - 0.05 * v).toFixed(4)})`;
        L.style.filter = v < 0.99 ? `blur(${(8 * (1 - v)).toFixed(2)}px)` : 'none';
      }
      if (T) {
        T.style.opacity = String(v);
        T.style.filter = v < 0.99 ? `blur(${(9 * (1 - v)).toFixed(2)}px)` : 'none';
        T.style.transform = `translateY(${(26 * (1 - v) * (t < 0.5 ? 1 : -1)).toFixed(1)}px)`;
        T.style.pointerEvents = v > 0.5 ? 'auto' : 'none';
      }
    }
  });
}

// ── block replay ─────────────────────────────────────────────────────
// Each [data-at] element is in between its mark and its optional
// [data-out] mark; CSS transitions do the motion, so it replays in
// reverse on the way up. The gate line fills with progress.
function replay(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll<HTMLElement>('[data-at]')).map((el) => ({
    el, at: parseFloat(el.dataset.at || '0'), out: parseFloat(el.dataset.out || '2'), on: false,
  }));
  scenes.push(() => {
    const p = heldProgress(root);
    root.style.setProperty('--rp', p.toFixed(4));
    for (const m of marks) {
      const on = p >= m.at && p < m.out;
      if (on !== m.on) { m.on = on; m.el.classList.toggle('in', on); }
    }
  });
}

// ── demo tour ────────────────────────────────────────────────────────
// A held stage paged by scroll: the browser frame grows in, then each
// chapter's screenshot cross-fades in while its entry in the list opens
// and fills a hairline progress bar. The list also works as navigation.
function tour() {
  const root = document.querySelector<HTMLElement>('[data-tour]');
  if (!root) return;
  const frame = root.querySelector<HTMLElement>('.tour-frame');
  const shots = Array.from(root.querySelectorAll<HTMLImageElement>('.tf-shot'));
  const items = Array.from(root.querySelectorAll<HTMLElement>('.tn'));
  const bars = items.map((li) => li.querySelector<HTMLElement>('.tn-bar b'));
  const path = root.querySelector<HTMLElement>('[data-tour-path]');
  const held = window.matchMedia('(min-width: 1081px) and (min-height: 641px)');
  const n = shots.length;
  let active = -1;

  // Chapter k is centred at progress (k + 0.5) / n.
  root.querySelectorAll<HTMLElement>('[data-tour-go]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = Number(b.dataset.tourGo);
      const top = root.getBoundingClientRect().top + window.scrollY;
      const y = top + ((k + 0.5) / n) * (root.offsetHeight - vh);
      if (lenis) lenis.scrollTo(y, { duration: 1.1 }); else window.scrollTo({ top: y, behavior: 'smooth' });
    });
  });

  scenes.push(() => {
    if (!held.matches) return;
    const top = root.getBoundingClientRect().top;
    const e = smooth(ramp(1 - top / vh, 0.1, 1));
    if (frame) frame.style.transform = `scale(${(0.86 + 0.14 * e).toFixed(4)})`;

    const s = heldProgress(root) * n;
    const k = Math.min(n - 1, Math.floor(s));
    for (let i = 0; i < n; i++) {
      const t = s - i;
      const inn = i === 0 ? 1 : smooth(ramp(t, -0.1, 0.1));
      const outn = i === n - 1 ? 1 : 1 - smooth(ramp(t, 0.9, 1.1));
      const v = Math.min(inn, outn);
      shots[i].style.opacity = String(v);
      shots[i].style.transform = `scale(${(1.03 - 0.03 * v).toFixed(4)})`;
      const b = bars[i];
      if (b) b.style.transform = `scaleX(${clamp(t).toFixed(4)})`;
    }
    if (k !== active) {
      active = k;
      items.forEach((li, i) => li.classList.toggle('on', i === k));
      if (path) path.textContent = shots[k].dataset.path || '';
    }
  });
}

// ── drift (relative speed) and grow ──────────────────────────────────
function drift() {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-drift]'));
  scenes.push(() => {
    for (const el of els) {
      const host = (el.closest('[data-drift-host]') as HTMLElement) || el;
      const r = host.getBoundingClientRect();
      if (r.bottom < -vh || r.top > 2 * vh) continue;
      const speed = parseFloat(el.dataset.drift || '0.2');
      const c = r.top + r.height / 2 - vh / 2;
      el.style.transform = `translate3d(0, ${(c * speed).toFixed(1)}px, 0)`;
    }
  });
}

function grow() {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-grow]'));
  scenes.push(() => {
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top > vh || r.bottom < 0) continue;
      const g = smooth(ramp(1 - r.top / vh, 0.05, 0.75));
      el.style.transform = `scale(${(0.9 + 0.1 * g).toFixed(4)})`;
      el.style.borderRadius = `${(48 - 16 * g).toFixed(1)}px`;
    }
  });
}

function frame() { for (const s of scenes) s(); }

let lenis: Lenis | null = null;

if (!reduce) {
  document.documentElement.classList.add('motion');
  hero(); focus(); tour(); split(); drift(); grow();
  document.querySelectorAll<HTMLElement>('[data-replay]').forEach(replay);

  // The second headline line has its own entrance; the scroll scene
  // takes it over once that has finished.
  const l2 = document.querySelector<HTMLElement>('.hero-h span:nth-child(2)');
  if (l2) {
    l2.classList.add('entering');
    l2.addEventListener('animationend', () => {
      l2.classList.remove('entering');
      l2.style.animation = 'none';
      frame();
    }, { once: true });
  }

  const l = new Lenis({ lerp: 0.12, smoothWheel: true, anchors: true });
  lenis = l;
  l.on('scroll', frame);
  const raf = (t: number) => { l.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  window.addEventListener('resize', () => { vh = window.innerHeight; frame(); });
  frame();
}
