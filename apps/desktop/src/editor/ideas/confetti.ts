/**
 * Full-screen confetti burst for ticking an idea done: classic gold, silver
 * and white pieces over the whole viewport, from the check button. Canvas,
 * removed when finished. prefers-reduced-motion gets a soft gold fade instead.
 */
const COLORS = ["#d4af37", "#f5d76e", "#b8860b", "#c0c0c0", "#e5e4e2", "#ffffff"];

export function burstConfetti(from?: HTMLElement | null): void {
  if (typeof window === "undefined") return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    const veil = document.createElement("div");
    veil.className = "confettifade";
    document.body.appendChild(veil);
    setTimeout(() => veil.remove(), 700);
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.className = "confetticanvas";
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.remove();
  ctx.scale(dpr, dpr);
  const r = from?.getBoundingClientRect();
  const ox = r ? r.left + r.width / 2 : W / 2;
  const oy = r ? r.top + r.height / 2 : H / 3;
  type P = { x: number; y: number; vx: number; vy: number; w: number; h: number; a: number; va: number; c: string };
  const parts: P[] = [];
  for (let i = 0; i < 180; i++) {
    const fromTop = i % 3 === 0;
    const ang = Math.random() * Math.PI * 2;
    const sp = 6 + Math.random() * 12;
    parts.push({
      x: fromTop ? Math.random() * W : ox,
      y: fromTop ? -20 - Math.random() * H * 0.3 : oy,
      vx: fromTop ? (Math.random() - 0.5) * 2 : Math.cos(ang) * sp,
      vy: fromTop ? 2 + Math.random() * 3 : Math.sin(ang) * sp - 6,
      w: 6 + Math.random() * 6,
      h: 3 + Math.random() * 10,
      a: Math.random() * Math.PI,
      va: (Math.random() - 0.5) * 0.4,
      c: COLORS[i % COLORS.length],
    });
  }
  const start = performance.now();
  const frame = (t: number) => {
    const el = t - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = el > 1800 ? Math.max(0, 1 - (el - 1800) / 600) : 1;
    for (const p of parts) {
      p.vy += 0.25;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.a += p.va;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a * 2)) + 1);
      ctx.restore();
    }
    if (el < 2400) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}