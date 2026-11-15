import { PerInstanceColorAppearance, Primitive, type Viewer } from 'cesium';
import { APP_CONFIG } from '../config';
import type { ElevationService } from '../core/elevation';
import type { LonLat, RailSegment } from '../types';
import { distance } from '../utils/geo';
import { buildSceneryGeometry } from './sceneryGeometry';
import { planScenery, profilePoints } from './sceneryPlan';

interface Request { segments: RailSegment[]; focus: LonLat; preferred?: string }

/** Resident near-field chunks. Coarse province rails remain the independent distant layer. */
export class SceneryManager {
  private resident = new Map<string, Primitive>();
  private staged = new Set<Primitive>();
  private generation = 0;
  private revision = -1;
  private pending?: Request;
  private loading = false;
  private lastFocus?: LonLat;
  private lastPreferred?: string;
  private lastNetworkSize = -1;
  private lastAttempt = -Infinity;
  private failed = false;
  private cancelWait = new Set<() => void>();

  constructor(private viewer: Viewer, private elevation: ElevationService) {}

  get stats() { return { chunks: this.resident.size, staged: this.staged.size, loading: this.loading, failed: this.failed }; }

  needsUpdate(focus: LonLat, preferred: string | undefined, networkSize: number, now: number): boolean {
    if (this.loading) return false;
    if (this.failed && now - this.lastAttempt < APP_CONFIG.scenery.retryMs) return false;
    return this.failed || !this.lastFocus || this.lastPreferred !== preferred || this.lastNetworkSize !== networkSize
      || this.revision !== this.elevation.revision || distance(focus, this.lastFocus) >= APP_CONFIG.scenery.refreshDistance;
  }

  clear(): void {
    this.generation++;
    this.pending = undefined;
    this.cancelWait.forEach(cancel => cancel());
    [...this.resident.values(), ...this.staged].forEach(p => this.viewer.scene.primitives.remove(p));
    this.resident.clear(); this.staged.clear();
    this.lastFocus = undefined;
    this.failed = false;
  }

  async update(segments: RailSegment[], focus: LonLat, preferred?: string, networkSize = segments.length): Promise<void> {
    if (this.loading) { this.pending = { segments, focus, preferred }; return; }
    this.loading = true;
    this.lastAttempt = performance.now();
    const generation = this.generation;
    const revision = this.elevation.revision;
    const current = () => generation === this.generation && revision === this.elevation.revision && !this.viewer.isDestroyed();
    const next = new Map<string, Primitive>();
    try {
      const plan = planScenery(segments, focus, preferred);
      const sameProfile = revision === this.revision;
      const missing = plan.filter(chunk => !sameProfile || !this.resident.has(chunk.key));
      await this.elevation.sample(missing.flatMap(profilePoints));
      if (!current()) return;
      // Keep the old scene if any requested chunk is unmeasured; zero is only valid on an ellipsoid.
      if (missing.some(chunk => profilePoints(chunk).some(point => !this.elevation.hasHeight(point)))) {
        throw new Error('轨旁场景高程暂不可用');
      }
      for (const [index, chunk] of plan.entries()) {
        if (!current()) return;
        const previous = sameProfile ? this.resident.get(chunk.key) : undefined;
        if (previous) { next.set(chunk.key, previous); continue; }
        const primitive = new Primitive({
          geometryInstances: buildSceneryGeometry(chunk, this.elevation, segments),
          appearance: new PerInstanceColorAppearance({ flat: false, faceForward: true, translucent: false, closed: false }),
          asynchronous: false, allowPicking: false, show: false,
        });
        next.set(chunk.key, primitive);
        this.staged.add(primitive);
        this.viewer.scene.primitives.add(primitive);
        // A handful of 250 m chunks per frame keeps the simulation responsive while scenery streams.
        if (index % 4 === 3) await this.nextFrame();
      }
      if (!current()) return;
      // Hidden primitives do not prepare GPU resources in Cesium. Reveal the staged batch, then
      // keep the previous batch until a rendered frame confirms readiness.
      next.forEach(p => { p.show = true; });
      await this.ready([...next.values()], current);
      if (!current()) return;
      this.resident.forEach((p, key) => { if (next.get(key) !== p) this.viewer.scene.primitives.remove(p); });
      this.resident = next;
      next.forEach(p => this.staged.delete(p));
      this.lastFocus = { ...focus }; this.lastPreferred = preferred; this.lastNetworkSize = networkSize;
      this.revision = revision; this.failed = false;
    } catch {
      if (generation === this.generation) this.failed = true;
    } finally {
      next.forEach(p => {
        if (this.staged.delete(p) && !this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(p);
      });
      this.loading = false;
      const pending = this.pending;
      this.pending = undefined;
      if (pending && generation === this.generation) void this.update(pending.segments, pending.focus, pending.preferred);
    }
  }

  private nextFrame(): Promise<void> {
    return new Promise(resolve => {
      let frame: number | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (frame !== undefined) cancelAnimationFrame(frame);
        this.cancelWait.delete(finish); resolve();
      };
      const timer = setTimeout(finish, 50);
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(finish);
      else queueMicrotask(finish);
      this.cancelWait.add(finish);
    });
  }

  private ready(primitives: Primitive[], current: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let remove: (() => void) | undefined;
      const finish = () => { clearTimeout(timer); remove?.(); this.cancelWait.delete(finish); resolve(); };
      const timer = setTimeout(() => { remove?.(); this.cancelWait.delete(finish); reject(new Error('轨旁绘制超时')); }, 15_000);
      remove = this.viewer.scene.postRender.addEventListener(() => {
        if (!current() || primitives.every(p => p.ready)) finish();
      });
      this.cancelWait.add(finish);
      this.viewer.scene.requestRender();
    });
  }
}
