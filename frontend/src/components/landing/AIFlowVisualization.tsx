import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const INCOMING_MESSAGES = [
  'Do you have this in stock?',
  'What are your hours today?',
  'Can I change my delivery address?',
];

const OUTGOING_MESSAGES = [
  'Yes — we have 3 left. Want me to hold one?',
  "We're open 9–6. I can add a note for pickup.",
  "Done. I've updated your order to the new address.",
];

const STEP_MS = 3800;
const STEP_MS_REDUCED = 10000;

type Vec2 = { x: number; y: number };

function quadBezier(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function quadBezierTangent(p0: Vec2, p1: Vec2, p2: Vec2, t: number): Vec2 {
  return {
    x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
  };
}

type Particle = {
  t: number;
  speed: number;
  path: 'in' | 'out';
  size: number;
  hue: number;
  wobble: number;
};

type Spark = { x: number; y: number; life: number; vx: number; vy: number };

function initParticles(w: number): Particle[] {
  const n = Math.min(48, Math.floor(28 + w / 35));
  const arr: Particle[] = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      t: (i / n) % 1,
      speed: 0.0012 + Math.random() * 0.0022,
      path: i % 2 === 0 ? 'in' : 'out',
      size: 1.2 + Math.random() * 2.8,
      hue: i % 3 === 0 ? 172 : i % 3 === 1 ? 265 : 43,
      wobble: Math.random() * Math.PI * 2,
    });
  }
  return arr;
}

export function AIFlowVisualization({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const sparksRef = useRef<Spark[]>([]);
  const rafRef = useRef<number>(0);
  const dimsRef = useRef({ w: 800, h: 480, dpr: 1 });

  const [phase, setPhase] = useState(0);
  const [tick, setTick] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const ms = reduceMotion ? STEP_MS_REDUCED : STEP_MS;
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      setPhase((p) => (p + 1) % 4);
    }, ms);
    return () => window.clearInterval(id);
  }, [reduceMotion]);

  const msgIndex = tick % INCOMING_MESSAGES.length;

  const drawFrame = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      const { w, h, dpr } = dimsRef.current;
      const t = time * 0.001;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const p0in: Vec2 = { x: w * 0.06, y: h * 0.58 };
      const p1in: Vec2 = { x: w * 0.32, y: h * 0.18 };
      const p2in: Vec2 = { x: w * 0.5, y: h * 0.5 };

      const p0out: Vec2 = { x: w * 0.5, y: h * 0.5 };
      const p1out: Vec2 = { x: w * 0.68, y: h * 0.82 };
      const p2out: Vec2 = { x: w * 0.94, y: h * 0.42 };

      // base
      ctx.fillStyle = '#060605';
      ctx.fillRect(0, 0, w, h);

      // soft vignette + chromatic-ish glow
      const vg = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, h * 0.85);
      vg.addColorStop(0, 'rgba(45, 212, 191, 0.12)');
      vg.addColorStop(0.35, 'rgba(99, 102, 241, 0.06)');
      vg.addColorStop(1, 'transparent');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      // moving grid
      const gridOff = (t * 38) % 48;
      ctx.strokeStyle = 'rgba(240, 238, 230, 0.045)';
      ctx.lineWidth = 1;
      for (let x = -gridOff; x < w + 48; x += 48) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      const gridOffY = (t * 22) % 48;
      for (let y = -gridOffY; y < h + 48; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // scanlines
      if (!reduceMotion) {
        ctx.fillStyle = `rgba(0,0,0,${0.04 + 0.02 * Math.sin(t * 2)})`;
        for (let y = 0; y < h; y += 4) {
          ctx.fillRect(0, y + ((t * 80) % 4), w, 2);
        }
      }

      const drawBezierPath = (a: Vec2, b: Vec2, c: Vec2, color: string, glow: boolean) => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(b.x, b.y, c.x, c.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = glow ? 2.2 : 1.2;
        if (glow) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 14;
        }
        const dash = 10 + Math.sin(t * 3) * 2;
        ctx.setLineDash([dash, dash * 1.2]);
        ctx.lineDashOffset = -t * 42;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      };

      drawBezierPath(p0in, p1in, p2in, 'rgba(45, 212, 191, 0.45)', true);
      drawBezierPath(p0out, p1out, p2out, 'rgba(167, 139, 250, 0.5)', true);

      // secondary faint paths (decorative)
      ctx.globalAlpha = 0.25;
      drawBezierPath(
        { x: w * 0.1, y: h * 0.72 },
        { x: w * 0.38, y: h * 0.88 },
        { x: w * 0.52, y: h * 0.55 },
        'rgba(250, 204, 21, 0.35)',
        false,
      );
      drawBezierPath(
        { x: w * 0.48, y: h * 0.52 },
        { x: w * 0.62, y: h * 0.12 },
        { x: w * 0.9, y: h * 0.58 },
        'rgba(45, 212, 191, 0.3)',
        false,
      );
      ctx.globalAlpha = 1;

      // particles along curves
      const parts = particlesRef.current;
      for (const p of parts) {
        const pathPts = p.path === 'in' ? [p0in, p1in, p2in] : [p0out, p1out, p2out];
        const pt = quadBezier(pathPts[0], pathPts[1], pathPts[2], p.t);
        const tang = quadBezierTangent(pathPts[0], pathPts[1], pathPts[2], p.t);
        const len = Math.hypot(tang.x, tang.y) || 1;
        const nx = tang.x / len;
        const ny = tang.y / len;
        const wo = Math.sin(t * 4 + p.wobble) * 5;
        const px = pt.x - ny * wo;
        const py = pt.y + nx * wo;

        p.t += reduceMotion ? p.speed * 0.25 : p.speed;
        if (p.t > 1) p.t -= 1;

        const g = ctx.createRadialGradient(px, py, 0, px, py, p.size * 4);
        g.addColorStop(0, `hsla(${p.hue}, 95%, 72%, 0.95)`);
        g.addColorStop(0.4, `hsla(${p.hue}, 90%, 55%, 0.35)`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, p.size * 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `hsla(${p.hue}, 100%, 88%, 1)`;
        ctx.beginPath();
        ctx.arc(px, py, p.size * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }

      // sparks burst occasionally from center
      if (!reduceMotion && sparksRef.current.length < 55 && Math.random() < 0.022) {
        const seed = (time * 0.001) % 1000;
        for (let i = 0; i < 4; i++) {
          const ang = ((seed * 0.17 + i * 1.7) % 1) * Math.PI * 2;
          const sp = 1.2 + ((seed + i * 13) % 5) * 0.35;
          sparksRef.current.push({
            x: w * 0.5 + Math.cos(ang) * 18,
            y: h * 0.5 + Math.sin(ang) * 18,
            life: 1,
            vx: Math.cos(ang) * sp,
            vy: Math.sin(ang) * sp,
          });
        }
      }
      sparksRef.current = sparksRef.current.filter((s) => {
        s.x += s.vx;
        s.y += s.vy;
        s.life -= reduceMotion ? 0.02 : 0.035;
        if (s.life <= 0) return false;
        ctx.fillStyle = `rgba(94, 234, 212, ${s.life * 0.6})`;
        ctx.fillRect(s.x, s.y, 2, 2);
        return true;
      });

      // center core — rotating rings + pulse
      const cx = w * 0.5;
      const cy = h * 0.5;
      const pulse = 0.55 + 0.45 * Math.sin(t * 3.2);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(reduceMotion ? 0 : t * 0.35);
      for (let r = 56; r <= 92; r += 18) {
        ctx.strokeStyle = `rgba(94, 234, 212, ${0.12 + (92 - r) * 0.006})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 14, 3, 14]);
        ctx.lineDashOffset = t * (20 + r * 0.08);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(reduceMotion ? 0 : -t * 0.22);
      ctx.strokeStyle = `rgba(167, 139, 250, ${0.2 + pulse * 0.15})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 44 + pulse * 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // core disk
      const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, 48);
      coreG.addColorStop(0, `rgba(30, 30, 28, ${0.95})`);
      coreG.addColorStop(0.65, 'rgba(12, 12, 11, 0.92)');
      coreG.addColorStop(1, 'rgba(6, 6, 5, 0.98)');
      ctx.fillStyle = coreG;
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(45, 212, 191, ${0.35 + pulse * 0.25})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 46, 0, Math.PI * 2);
      ctx.stroke();

      // waveform ring (audio / signal metaphor)
      ctx.strokeStyle = 'rgba(240, 238, 230, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const baseR = 58;
      for (let a = 0; a <= Math.PI * 2; a += 0.08) {
        const wob = Math.sin(a * 8 + t * 6) * 4 + Math.sin(a * 3 - t * 4) * 3;
        const rr = baseR + wob;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();

      // corner brackets (HUD)
      const drawBracket = (x: number, y: number, flipX: number, flipY: number) => {
        const L = 22;
        ctx.strokeStyle = 'rgba(240, 238, 230, 0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + flipY * L);
        ctx.lineTo(x, y);
        ctx.lineTo(x + flipX * L, y);
        ctx.stroke();
      };
      drawBracket(w * 0.04, h * 0.08, 1, 1);
      drawBracket(w * 0.96, h * 0.08, -1, 1);
      drawBracket(w * 0.04, h * 0.92, 1, -1);
      drawBracket(w * 0.96, h * 0.92, -1, -1);

      // floating data columns (binary-ish rain) — left & right
      if (!reduceMotion) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(94, 234, 212, 0.15)';
        const ti = Math.floor(t * 24);
        for (let col = 0; col < 4; col++) {
          const x = w * 0.02 + col * 10;
          for (let row = 0; row < 18; row++) {
            const y = ((row * 17 + col * 31 + t * 60) % (h + 40)) - 20;
            const bit = (col * 47 + row * 19 + ti) % 2;
            ctx.fillText(bit === 0 ? '1' : '0', x, y);
          }
        }
        ctx.fillStyle = 'rgba(167, 139, 250, 0.12)';
        for (let col = 0; col < 4; col++) {
          const x = w * 0.94 - col * 10;
          for (let row = 0; row < 18; row++) {
            const y = ((row * 19 + col * 37 - t * 55) % (h + 40)) - 20;
            const sym = (col + row * 3 + ti) % 2 === 0 ? 'λ' : 'Σ';
            ctx.fillText(sym, x, y);
          }
        }
      }
    },
    [reduceMotion],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(320, rect.width);
      const h = Math.min(560, Math.max(380, rect.width * 0.52));
      dimsRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      particlesRef.current = initParticles(w);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const loop = (now: number) => {
      drawFrame(now);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [drawFrame, reduceMotion]);

  const showCustomerPulse = phase === 0 || phase === 1;
  const showAiProcess = phase === 1 || phase === 2;
  const showReplyPulse = phase === 2 || phase === 3;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border border-[#c8c4b8] bg-[#0a0908] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.35)] ring-1 ring-white/5',
        className,
      )}
      role="img"
      aria-label="Animated diagram of messages flowing into an AI core and responses flowing out."
    >
      <div ref={wrapRef} className="relative w-full">
        <canvas
          ref={canvasRef}
          className="block w-full"
          aria-hidden
        />

        {/* HUD labels */}
        <div className="pointer-events-none absolute left-4 top-3 font-landing text-[10px] font-semibold uppercase tracking-[0.2em] text-teal-300/90">
          Live inference
        </div>
        <div className="pointer-events-none absolute right-4 top-3 font-landing text-[10px] tabular-nums text-white/35">
          <span className="text-emerald-400/90">●</span> stream
        </div>

        {/* Core label on canvas */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 flex h-[92px] w-[92px] -translate-x-1/2 -translate-y-1/2 items-center justify-center">
          <span className="font-landing text-sm font-bold tracking-[0.35em] text-white/90">
            AI
          </span>
        </div>

        {/* Columns overlay */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 flex items-end justify-between gap-2 px-3 pb-4 pt-14 sm:px-5 sm:pb-5 md:items-center md:pb-6">
          <div className="flex max-w-[min(42%,220px)] flex-col gap-2 md:max-w-[200px]">
            <div
              className={cn(
                'rounded-lg border border-white/10 bg-black/40 px-2 py-1 font-landing text-[9px] font-semibold uppercase tracking-wider text-teal-300/90 backdrop-blur-md',
                showCustomerPulse && 'border-teal-400/40 shadow-[0_0_20px_rgba(45,212,191,0.2)]',
              )}
            >
              Ingest
            </div>
            <div
              className={cn(
                'rounded-xl border border-white/12 bg-black/55 px-3 py-2.5 shadow-lg backdrop-blur-md transition-all duration-300',
                phase === 0 && 'ring-1 ring-teal-400/50',
              )}
            >
              <p className="font-landing text-[9px] font-medium uppercase tracking-wider text-white/45">
                Payload
              </p>
              <p className="mt-1 font-landing text-[11px] leading-snug text-white/90">
                {INCOMING_MESSAGES[msgIndex]}
              </p>
            </div>
          </div>

          <div className="hidden w-px shrink-0 md:block" aria-hidden />

          <div className="flex max-w-[min(42%,220px)] flex-col items-end gap-2 md:max-w-[200px]">
            <div
              className={cn(
                'rounded-lg border border-white/10 bg-black/40 px-2 py-1 font-landing text-[9px] font-semibold uppercase tracking-wider text-violet-300/90 backdrop-blur-md',
                showReplyPulse && 'border-violet-400/40 shadow-[0_0_20px_rgba(167,139,250,0.25)]',
              )}
            >
              Emit
            </div>
            <div
              className={cn(
                'rounded-xl border border-white/12 bg-gradient-to-br from-violet-950/80 to-black/70 px-3 py-2.5 text-right shadow-lg backdrop-blur-md transition-all duration-300',
                phase === 2 && 'ring-1 ring-violet-400/45',
              )}
            >
              <p className="font-landing text-[9px] font-medium uppercase tracking-wider text-white/45">
                Token stream
              </p>
              <p className="mt-1 font-landing text-[11px] leading-snug text-white/92">
                {OUTGOING_MESSAGES[msgIndex]}
              </p>
            </div>
          </div>
        </div>

        {showAiProcess && !reduceMotion && (
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_30%,rgba(0,0,0,0.14)_100%)]" />
        )}
      </div>

      {/* Bottom pipeline */}
      <div className="pointer-events-none flex flex-wrap justify-center gap-1.5 border-t border-white/10 bg-black/50 px-3 py-3 backdrop-blur-sm sm:gap-2">
        {['Message in', 'Context fuse', 'Model run', 'Channel out'].map((label, i) => (
          <span
            key={label}
            className={cn(
              'rounded-full px-2.5 py-1 font-landing text-[10px] font-medium uppercase tracking-wide transition-all duration-300 sm:px-3',
              phase === i
                ? 'bg-teal-400/20 text-teal-200 ring-1 ring-teal-400/40'
                : 'bg-white/10 text-white/40',
            )}
          >
            {i + 1}. {label}
          </span>
        ))}
      </div>
    </div>
  );
}
