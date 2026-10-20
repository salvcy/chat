/*
 * The ASCII ocean behind the front door and the empty chat: schools of fish
 * and the sharks that hunt them, drawn as glyphs on a canvas.
 *
 * From ascii-sharks (github.com/stackedlol/ascii-sharks @ c521e24) — world,
 * species and math as they were, the renderer adapted for this app's themes
 * (see renderer.ts). This file is the original engine plus four things the
 * app needed: a theme switch, a pause while the page is hidden (a closed
 * desktop window keeps its page until it is released, and must not animate
 * for nobody), handing the canvas's backing store back on destroy, and a
 * speed for the whole ocean's clock (Settings → Appearance).
 */
import { AsciiRenderer } from "./renderer.ts";
import { World, type SharkSpec } from "./world.ts";

const STEP = 1 / 60;
const MAX_STEPS = 4;

/**
 * Wires World + AsciiRenderer to a canvas: fixed-timestep loop, resize,
 * pointer input, pausing off-screen, and prefers-reduced-motion.
 */
export class OceanEngine {
  private world: World;
  private renderer: AsciiRenderer;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = true;
  private reducedMotion: MediaQueryList;
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private disposed = false;
  /** Simulated seconds per real second. */
  private speed = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    {
      sharks,
      fishCount,
      dark = true,
    }: { sharks?: SharkSpec[]; fishCount?: number; dark?: boolean } = {},
  ) {
    this.world = new World(sharks, fishCount);
    this.renderer = new AsciiRenderer(canvas, dark);
    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);

    this.resize();
    // Canvas text can't trigger a webfont load; once the mono face is in, redraw.
    document.fonts?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`).then(() => {
      if (!this.disposed && this.reducedMotion.matches) this.drawStill();
    });
    this.schedule();
  }

  /**
   * Run the ocean's clock faster or slower. Everything keeps time with it —
   * fish, sharks, tail beats, wakes — so a slow ocean is slow motion, not a
   * different hunt.
   */
  setSpeed(speed: number) {
    this.speed = Number.isFinite(speed) ? Math.min(4, Math.max(0.1, speed)) : 1;
  }

  /** Light or dark water. A still frame (reduced motion) is repainted at once. */
  setTheme(dark: boolean) {
    this.renderer.setDark(dark);
    if (!this.disposed && this.reducedMotion.matches) this.drawStill();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
    this.renderer.release();
  }

  private resize() {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(rect.width, rect.height, dpr);
    this.world.resize(rect.width, rect.height, this.renderer.cellWidth, this.renderer.cellHeight);
    if (this.reducedMotion.matches) this.drawStill();
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible || document.hidden || this.reducedMotion.matches) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // Simulated time. Slower than real time, the step shrinks with it, so a
    // slow ocean still moves every frame rather than in jumps; faster, it
    // takes more steps of the usual size.
    const sim = dt * this.speed;
    const step = STEP * Math.min(1, this.speed);
    const maxSteps = Math.ceil(MAX_STEPS * Math.max(1, this.speed));
    this.acc += sim;
    let steps = 0;
    while (this.acc >= step && steps < maxSteps) {
      this.world.step(step);
      this.acc -= step;
      steps++;
    }
    if (steps === maxSteps) this.acc = 0;
    this.renderer.render(this.world, sim);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Reduced motion: let the ecosystem settle, then show a single frame. */
  private drawStill() {
    if (this.world.time < 4) {
      for (let i = 0; i < 240; i++) this.world.step(STEP);
    }
    this.renderer.render(this.world, STEP);
  }

  private onMotionPreference = () => {
    if (this.reducedMotion.matches) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  };

  private onVisibility = () => this.schedule();

  private toLocal(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    return { x, y, inside };
  }

  private onPointerMove = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e);
    const p = this.world.pointer;
    p.x = x;
    p.y = y;
    p.active = inside && e.pointerType !== "touch";
  };

  private onPointerDown = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e);
    if (inside && !this.reducedMotion.matches) this.world.splash(x, y);
  };

  private onPointerLeave = () => {
    this.world.pointer.active = false;
  };
}
