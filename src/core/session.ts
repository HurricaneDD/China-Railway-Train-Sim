import { APP_CONFIG } from '../config';
import { RailwayRepository } from '../data/railway';
import { StationRepository } from '../data/stations';
import type { GameSave, JunctionOption, JunctionRequest, LonLat, Reverser, RoutePoint, SavePosition, SnapResult, TrainState } from '../types';
import { bearing, compassDirection, distance, pointAt } from '../utils/geo';
import { initialTrainState, stepDynamics } from './dynamics';
import { ElevationService } from './elevation';
import { saveStore } from './storage';

export class GameSession {
  readonly railway = new RailwayRepository();
  readonly stations = new StationRepository();
  readonly elevation = new ElevationService();
  train: TrainState = initialTrainState();
  position?: SavePosition;
  junction?: JunctionRequest;
  junctionDistance = Infinity;
  running = false;
  paused = false;
  elapsed = 0;
  brakeHeld = false;
  onUpdate?: () => void;
  onAutosave?: () => void;
  onError?: (message: string) => void;
  private history: RoutePoint[] = [];
  private preferredNext?: string;
  private animationFrame = 0;
  private previousTime = 0;
  private accumulator = 0;
  private uiAccumulator = 0;
  private slopeTimer = 0;
  private borderTimer = 0;
  private autosaveTimer = 0;
  private repeatTimer = 0;
  private heldThrottle = new Set<'up' | 'down'>();

  async initialize(): Promise<void> {
    await Promise.all([this.railway.loadIndex(), this.stations.load()]);
  }

  async startAt(province: string, point: LonLat, maxDistance: number): Promise<SnapResult> {
    await this.railway.load(province);
    const snapped = this.railway.network.nearest(point, maxDistance);
    if (!snapped) throw new Error(`附近 ${Math.round(maxDistance)} 米内没有可用国铁线路，请重新选择`);
    this.position = { province, segmentId: snapped.segmentId, offset: snapped.offset, direction: 1, travelled: 0 };
    this.train = initialTrainState();
    this.elapsed = 0;
    this.junction = undefined;
    this.preferredNext = undefined;
    this.running = true;
    this.paused = false;
    this.initializeHistory();
    this.startLoop();
    void this.refreshSlope();
    void this.loadNearbyProvinces();
    this.onUpdate?.();
    return snapped;
  }

  async restore(save: GameSave): Promise<void> {
    await this.railway.load(save.position.province);
    const segment = this.railway.network.segments.get(save.position.segmentId);
    if (!segment) throw new Error('存档中的铁路区段不存在，可能线路数据已更新');
    this.position = { ...save.position, offset: Math.max(0, Math.min(segment.length, save.position.offset)) };
    this.train = { ...initialTrainState(), ...save.train };
    this.elapsed = save.elapsed;
    this.junction = undefined;
    this.preferredNext = undefined;
    this.running = true;
    this.paused = false;
    this.history = save.routeHistory.filter((point) => point.travelled <= this.position!.travelled).map((point) => ({ ...point })).sort((a, b) => a.travelled - b.travelled);
    this.recordRoutePoint();
    this.startLoop();
    void this.refreshSlope();
    void this.loadNearbyProvinces();
    this.onUpdate?.();
  }

  createSave(name: string, id = `save-${Date.now()}`): GameSave {
    if (!this.position) throw new Error('当前没有可保存的驾驶进度');
    return {
      id,
      name,
      version: 1,
      savedAt: new Date().toISOString(),
      position: { ...this.position },
      train: { ...this.train },
      elapsed: this.elapsed,
      routeHistory: this.history.map((point) => ({ ...point })),
      consist: APP_CONFIG.train.cars,
    };
  }

  async manualSave(name: string): Promise<GameSave> {
    const save = this.createSave(name);
    await saveStore.put(save);
    return save;
  }

  setThrottle(value: number): void {
    this.train.throttle = Math.max(0, Math.min(100, value));
  }

  holdThrottle(direction: 'up' | 'down', held: boolean): void {
    if (held) this.heldThrottle.add(direction);
    else this.heldThrottle.delete(direction);
  }

  setReverser(value: Reverser): boolean {
    if (Math.abs(this.train.velocity) * 3.6 > APP_CONFIG.train.reverseThresholdKmh) return false;
    this.train.reverser = value;
    this.train.velocity = 0;
    this.preferredNext = undefined;
    void this.refreshSlope();
    return true;
  }

  sand(): boolean {
    if (!this.train.adhesionLimited) return false;
    this.train.sandRemaining = APP_CONFIG.train.sandDuration;
    return true;
  }

  chooseJunction(segmentId: string): void {
    if (!this.junction?.options.some((option) => option.segmentId === segmentId)) return;
    this.preferredNext = segmentId;
    this.junction = undefined;
    this.junctionDistance = Infinity;
  }

  currentPoint(): RoutePoint | undefined {
    return this.history[this.history.length - 1];
  }

  consistPoints(): RoutePoint[] {
    if (!this.position || !this.history.length) return [];
    const points = [this.currentPoint()!];
    let trailingDistance = APP_CONFIG.train.locomotive.length / 2;
    for (const car of APP_CONFIG.train.cars) {
      trailingDistance += APP_CONFIG.train.couplingGap + car.length / 2;
      points.push(this.historyPoint(this.position.travelled - trailingDistance));
      trailingDistance += car.length / 2;
    }
    return points;
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animationFrame);
    this.heldThrottle.clear();
    this.brakeHeld = false;
  }

  private startLoop(): void {
    cancelAnimationFrame(this.animationFrame);
    this.previousTime = performance.now();
    this.accumulator = 0;
    const frame = (time: number) => {
      if (!this.running) return;
      const delta = Math.min(APP_CONFIG.simulation.maxFrameDelta, (time - this.previousTime) / 1000);
      this.previousTime = time;
      this.accumulator += delta;
      while (this.accumulator >= APP_CONFIG.simulation.fixedStep) {
        this.tick(APP_CONFIG.simulation.fixedStep);
        this.accumulator -= APP_CONFIG.simulation.fixedStep;
      }
      this.uiAccumulator += delta;
      if (this.uiAccumulator >= 0.1) {
        this.onUpdate?.();
        this.uiAccumulator = 0;
      }
      this.animationFrame = requestAnimationFrame(frame);
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  private tick(dt: number): void {
    if (this.paused || this.junction || !this.position) return;
    this.elapsed += dt;
    this.repeatTimer += dt;
    if (this.repeatTimer >= APP_CONFIG.train.keyRepeatMs / 1000) {
      const direction = this.heldThrottle.has('up') ? 1 : this.heldThrottle.has('down') ? -1 : 0;
      if (direction) this.setThrottle(this.train.throttle + direction * APP_CONFIG.train.throttleStep);
      this.repeatTimer = 0;
    }
    stepDynamics(this.train, dt, this.train.slope, this.brakeHeld);
    this.advance(this.train.velocity * dt);
    this.slopeTimer += dt;
    this.borderTimer += dt;
    this.autosaveTimer += dt;
    if (this.slopeTimer >= 1.5) {
      this.slopeTimer = 0;
      void this.refreshSlope();
    }
    if (this.borderTimer >= 15) {
      this.borderTimer = 0;
      void this.loadNearbyProvinces();
    }
    if (this.autosaveTimer >= APP_CONFIG.simulation.autosaveSeconds) {
      this.autosaveTimer = 0;
      this.onAutosave?.();
    }
  }

  private advance(signedDistance: number): void {
    if (!this.position || Math.abs(signedDistance) < 0.000001) return;
    let remaining = signedDistance;
    let guard = 0;
    while (Math.abs(remaining) > 0.000001 && guard++ < 8 && this.position) {
      const segment = this.railway.network.segments.get(this.position.segmentId);
      if (!segment) {
        this.train.velocity = 0;
        return;
      }
      const coordinateDirection = Math.sign(remaining) * this.position.direction;
      const atEnd = coordinateDirection > 0;
      const available = atEnd ? segment.length - this.position.offset : this.position.offset;
      const movement = Math.sign(remaining) * Math.min(Math.abs(remaining), available);
      this.position.offset += movement * this.position.direction;
      this.position.travelled += Math.abs(movement);
      remaining -= movement;
      if (Math.abs(remaining) <= 0.000001) break;
      const connections = this.railway.network.connections(segment.id, atEnd);
      const next = this.preferredNext ? connections.find((item) => item.id === this.preferredNext) : connections.length === 1 ? connections[0] : undefined;
      if (!next) {
        this.train.velocity = 0;
        if (connections.length > 1) this.openJunction(segment.id, atEnd);
        break;
      }
      const nodeId = atEnd ? segment.endNode : segment.startNode;
      const entersAtStart = next.startNode === nodeId;
      this.position.segmentId = next.id;
      this.position.direction = entersAtStart ? 1 : -1;
      this.position.offset = entersAtStart ? 0 : next.length;
      this.position.province = next.properties.province;
      this.preferredNext = undefined;
    }
    this.recordRoutePoint();
    this.checkJunction();
  }

  private checkJunction(): void {
    if (!this.position || this.junction) return;
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return;
    const travelSign = Math.sign(this.train.velocity) || this.train.reverser;
    if (!travelSign) return;
    const atEnd = travelSign * this.position.direction > 0;
    const remaining = atEnd ? segment.length - this.position.offset : this.position.offset;
    const connections = this.railway.network.connections(segment.id, atEnd);
    this.junctionDistance = connections.length > 1 && remaining < APP_CONFIG.simulation.junctionPreviewDistance ? remaining : Infinity;
    if (connections.length > 1 && remaining <= APP_CONFIG.simulation.junctionStopDistance && !this.preferredNext) this.openJunction(segment.id, atEnd);
  }

  private openJunction(segmentId: string, atEnd: boolean): void {
    const segment = this.railway.network.segments.get(segmentId)!;
    const node = this.railway.network.nodeFor(segmentId, atEnd)!;
    const options = this.railway.network.connections(segmentId, atEnd).map((next): JunctionOption => {
      const fromStart = next.startNode === node.id;
      const a = pointAt(next, fromStart ? 0 : next.length);
      const b = pointAt(next, fromStart ? Math.min(300, next.length) : Math.max(0, next.length - 300));
      const degrees = bearing(a, b);
      const station = this.stations.nearest(b, next.properties.province);
      const nextStation = station && distance(b, { lon: station.longitude, lat: station.latitude }) <= 8000 ? station.name : '暂无车站信息';
      return { segmentId: next.id, name: next.properties.name, bearing: degrees, direction: compassDirection(degrees), nextStation };
    });
    this.junction = { nodeId: node.id, atSegmentEnd: atEnd, options };
    this.onUpdate?.();
  }

  private initializeHistory(): void {
    if (!this.position) return;
    let segment = this.railway.network.segments.get(this.position.segmentId)!;
    let direction = this.position.direction * (this.train.reverser || 1);
    let offset = this.position.offset;
    const reversed: RoutePoint[] = [];
    for (let back = 0; back <= APP_CONFIG.simulation.routeHistoryLength; back += 5) {
      let desired = offset - (back === 0 ? 0 : 5) * direction;
      let guard = 0;
      while ((desired < 0 || desired > segment.length) && guard++ < 8) {
        const overflow = desired < 0 ? -desired : desired - segment.length;
        const atEnd = direction < 0;
        const node = this.railway.network.nodeFor(segment.id, atEnd);
        const previous = this.railway.network.connections(segment.id, atEnd);
        if (!node || previous.length !== 1) {
          this.history = reversed.reverse();
          return;
        }
        const next = previous[0];
        direction = next.endNode === node.id ? 1 : -1;
        offset = direction === 1 ? next.length : 0;
        segment = next;
        desired = offset - overflow * direction;
      }
      if (desired < 0 || desired > segment.length) break;
      offset = desired;
      const point = pointAt(segment, offset);
      reversed.push({ ...point, heading: (point.heading + (direction < 0 ? 180 : 0)) % 360, height: this.elevation.height(point), travelled: this.position.travelled - back });
    }
    this.history = reversed.reverse();
  }

  private recordRoutePoint(): void {
    if (!this.position) return;
    const segment = this.railway.network.segments.get(this.position.segmentId)!;
    const point = pointAt(segment, this.position.offset);
    const orientation = this.position.direction * (this.train.reverser || 1);
    const routePoint: RoutePoint = { ...point, heading: (point.heading + (orientation < 0 ? 180 : 0)) % 360, height: this.elevation.height(point), travelled: this.position.travelled };
    const last = this.history[this.history.length - 1];
    if (!last || distance(last, routePoint) >= 1.5) this.history.push(routePoint);
    else this.history[this.history.length - 1] = routePoint;
    const earliest = this.position.travelled - APP_CONFIG.simulation.routeHistoryLength;
    this.history = this.history.filter((point) => point.travelled >= earliest);
  }

  private historyPoint(travelled: number): RoutePoint {
    let low = 0;
    let high = this.history.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.history[mid].travelled <= travelled) low = mid;
      else high = mid - 1;
    }
    return this.history[low];
  }

  private async refreshSlope(): Promise<void> {
    if (!this.position) return;
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return;
    const travelDirection = this.position.direction * (Math.sign(this.train.velocity) || this.train.reverser || 1);
    const span = Math.min(150, segment.length / 2);
    const center = pointAt(segment, this.position.offset);
    const ahead = pointAt(segment, Math.max(0, Math.min(segment.length, this.position.offset + span * travelDirection)));
    const behind = pointAt(segment, Math.max(0, Math.min(segment.length, this.position.offset - span * travelDirection)));
    const slope = await this.elevation.slope(center, ahead, behind, span * 2);
    const visibleHistory = this.history.slice(-30);
    const heights = await this.elevation.sample(visibleHistory);
    visibleHistory.forEach((point, index) => { point.height = heights[index]; });
    if (this.position?.segmentId === segment.id) this.train.slope = slope;
  }

  private async loadNearbyProvinces(): Promise<void> {
    if (!this.position) return;
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return;
    const point = pointAt(segment, this.position.offset);
    const provinces = new Set(this.stations.stations.filter((station) => station.province !== this.position!.province && Math.abs(station.longitude - point.lon) < 0.22 && Math.abs(station.latitude - point.lat) < 0.22).map((station) => station.province));
    for (const province of [...provinces].slice(0, 2)) {
      try {
        await this.railway.load(province);
      } catch (error) {
        this.onError?.(error instanceof Error ? error.message : '相邻省份线路加载失败');
      }
    }
  }
}
