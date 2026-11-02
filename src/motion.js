export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// r: response in seconds, z: damping ratio. Retargeting keeps the current value and velocity, so motion stays interruptible.
export class Spring {
  constructor(x, apply, eps = 0.05) {
    Object.assign(this, { x, v: 0, apply, eps, raf: 0, last: 0 });
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  set(x, v = 0) {
    this.stop();
    this.x = x;
    this.v = v;
    this.apply(x);
  }

  to(target, { z = 1, r = 0.35, v = this.v, cb } = {}) {
    this.stop();
    this.v = v;
    if (reducedMotion.matches) {
      this.set(target);
      if (cb) setTimeout(cb, 160);
      return;
    }
    const w = (2 * Math.PI) / r, k = w * w, c = 2 * z * w;
    this.last = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      const n = Math.max(1, Math.ceil(dt * 240)), step = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (-k * (this.x - target) - c * this.v) * step;
        this.x += this.v * step;
      }
      if (Math.abs(this.x - target) < this.eps && Math.abs(this.v) < this.eps * 10) {
        this.set(target);
        if (cb) cb();
        return;
      }
      this.apply(this.x);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}

export const project = (v, rate = 0.998) => ((v / 1000) * rate) / (1 - rate);

export const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

// Vertical drag with a 10px direction lock. onEnd receives the release velocity in px/s.
export function dragY(el, selector, { onStart, onMove, onEnd }) {
  let d = null;
  el.addEventListener('pointerdown', (e) => {
    if (reducedMotion.matches || e.button > 0 || e.target.closest('a,button') || !e.target.closest(selector)) return;
    d = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lock: false, s: [] };
  });
  el.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    if (!d.lock) {
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dy) <= Math.abs(dx)) { d = null; return; }
      d.lock = true;
      d.y0 = e.clientY;
      el.setPointerCapture(e.pointerId);
      onStart();
    }
    const dy = e.clientY - d.y0;
    d.s = [...d.s.slice(-7), { t: e.timeStamp, dy }];
    onMove(dy);
  });
  const release = (cancel) => (e) => {
    if (!d || e.pointerId !== d.id) return;
    const { lock, s } = d;
    d = null;
    if (!lock) return;
    const recent = s.filter((p) => e.timeStamp - p.t < 120);
    const [a, b] = [recent[0], recent.at(-1)];
    onEnd(!cancel && a && b.t > a.t ? ((b.dy - a.dy) / (b.t - a.t)) * 1000 : 0, cancel);
  };
  el.addEventListener('pointerup', release(false));
  el.addEventListener('pointercancel', release(true));
}
