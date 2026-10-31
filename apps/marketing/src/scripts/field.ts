/**
 * A field of short strokes on the ink panels, drawn to a canvas.
 *
 * Each stroke sits on a grid and points along a slow, wind-like flow
 * (a few summed sines over space and time). Near the pointer the flow
 * turns into a swirl around it: strokes there lengthen, brighten and a
 * few warm to amber, and a soft light follows the cursor. The pointer is
 * eased so the field trails it rather than snapping.
 *
 * Mount with <canvas data-field> inside a positioned panel; the canvas
 * sizes itself to that panel. With reduced motion one still frame is
 * drawn and redrawn on resize. Nothing runs while the panel is off
 * screen or the tab is hidden.
 */

const GAP = 22;      // grid spacing, CSS px
const LEN = 9;       // resting stroke length
const REACH = 220;   // pointer influence radius
const SAGE = [159, 180, 167];
const PAPER = [242, 239, 234];
const AMBER = [232, 186, 112];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function mount(canvas: HTMLCanvasElement) {
  const host = canvas.parentElement as HTMLElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0, h = 0, dpr = 1;
  let visible = true, raf = 0, t0 = performance.now();
  // Target and eased pointer; `on` fades the pointer's influence in and out.
  const target = { x: -1e4, y: -1e4, on: 0 };
  const p = { x: -1e4, y: -1e4, on: 0 };

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Layout size, not the rendered box: a panel may be mid-scale.
    w = host.clientWidth; h = host.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (still) draw(0);
  }

  function draw(t: number) {
    ctx!.clearRect(0, 0, w, h);

    // The light under the cursor.
    if (p.on > 0.01) {
      const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, REACH * 1.6);
      g.addColorStop(0, `rgba(159, 196, 178, ${0.16 * p.on})`);
      g.addColorStop(1, 'rgba(159, 196, 178, 0)');
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, w, h);
    }

    ctx!.lineCap = 'round';
    ctx!.lineWidth = 1.25;
    const ox = (w % GAP) / 2, oy = (h % GAP) / 2;
    for (let y = oy; y < h + GAP; y += GAP) {
      for (let x = ox; x < w + GAP; x += GAP) {
        // Ambient flow: a slow wind that bends across the panel.
        let a = Math.sin(x * 0.006 + t * 0.00021) * 1.1
              + Math.cos(y * 0.008 - t * 0.00017) * 0.9
              + Math.sin((x + y) * 0.003 + t * 0.00011) * 0.6;
        // Strongest in the open upper part, faint behind the copy below.
        const fade = 1 - 0.78 * Math.min(1, Math.max(0, (y / h - 0.3) / 0.4));
        let len = LEN, alpha = 0.24 * fade, warm = 0;

        const dx = x - p.x, dy = y - p.y;
        const d = Math.hypot(dx, dy);
        if (p.on > 0.01 && d < REACH) {
          const k = (1 - d / REACH) ** 2 * p.on;
          // Swirl: the tangent around the pointer, blended in by nearness.
          const swirl = Math.atan2(dy, dx) + Math.PI / 2 + 0.35;
          const diff = Math.atan2(Math.sin(swirl - a), Math.cos(swirl - a));
          a += diff * Math.min(1, k * 1.6);
          len += k * 12;
          alpha += k * 0.6;
          warm = k;
        }

        const cx = Math.cos(a) * len / 2, cy = Math.sin(a) * len / 2;
        // Sage at rest, paper when lit; the closest warm toward amber.
        const lit = Math.min(1, warm * 1.4);
        const amb = Math.max(0, (warm - 0.55) / 0.45) * 0.7;
        const [r, g, b] = SAGE.map((s, i) => Math.round(lerp(lerp(s, PAPER[i], lit), AMBER[i], amb)));
        ctx!.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.85, alpha)})`;
        ctx!.beginPath();
        ctx!.moveTo(x - cx, y - cy);
        ctx!.lineTo(x + cx, y + cy);
        ctx!.stroke();
      }
    }
  }

  function frame(now: number) {
    raf = 0;
    if (!visible || document.hidden) return;
    p.x += (target.x - p.x) * 0.12;
    p.y += (target.y - p.y) * 0.12;
    p.on += (target.on - p.on) * 0.08;
    draw(now - t0);
    raf = requestAnimationFrame(frame);
  }
  const run = () => { if (!still && !raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };

  host.addEventListener('pointermove', (e) => {
    const r = host.getBoundingClientRect();
    target.x = (e.clientX - r.left) * (w / r.width);
    target.y = (e.clientY - r.top) * (h / r.height);
    // Jump the eased pointer on entry so the swirl doesn't fly in from afar.
    if (p.on < 0.02) { p.x = target.x; p.y = target.y; }
    target.on = 1;
  });
  host.addEventListener('pointerleave', () => { target.on = 0; });

  new ResizeObserver(size).observe(host);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; run(); }).observe(host);
  document.addEventListener('visibilitychange', run);
  size();
  run();
}

document.querySelectorAll<HTMLCanvasElement>('canvas[data-field]').forEach(mount);
