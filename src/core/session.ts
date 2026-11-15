import { APP_CONFIG, type SimulationSpeed } from '../config';
import { RailwayRepository, type RailExit, type RailBoundary } from '../data/railway';
import { StationRepository } from '../data/stations';
import { neighboringProvinces } from '../data/province-neighbors';
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
  connectionWarning = '';
  running = false;
  paused = false;
  /** Wall-clock multiplier for physics simulation; does not change dynamics or route identity. */
  simulationSpeed: SimulationSpeed = 1;
  elapsed = 0;
  brakeHeld = false;
  parkingBrake = true;
  routeEnd = false;
  loadingBorder = false;
  practiceComplete = false;
  private routeCoordinate = 0;
  private lastHistoryExtension = -Infinity;
  private slopeGeneration = 0;
  private borderLoading?: Promise<void>;
  private tripGeneration = 0;
  private lastBorderCheck?: LonLat;
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
    this.beginTrip(snapped.segmentId, snapped.offset, 1);
    return snapped;
  }

  /** Start on a line chosen in the station departure map. */
  startOnTrack(segmentId: string, offset: number, direction: 1 | -1): LonLat {
    const segment = this.railway.network.segments.get(segmentId);
    if (!segment) throw new Error('所选始发线路不存在，请重新选择');
    const clamped = Math.max(0, Math.min(segment.length, offset));
    this.beginTrip(segmentId, clamped, direction);
    return pointAt(segment, clamped);
  }

  private beginTrip(segmentId: string, offset: number, direction: 1 | -1): void {
    const segment = this.railway.network.segments.get(segmentId);
    if (!segment) throw new Error('出发区段不存在');
    this.position = { province: segment.properties.province, segmentId, offset, direction, travelled: 0 };
    this.train = initialTrainState();
    this.train.brakeCommand = this.train.brakeActual = 100;
    this.train.brakePipe = 430;
    this.parkingBrake = true;
    this.routeCoordinate = 0;
    this.routeEnd = false;
    this.practiceComplete = false;
    this.tripGeneration++;
    this.loadingBorder = false;
    this.borderLoading = undefined;
    this.lastBorderCheck = undefined;
    this.lastHistoryExtension = -Infinity;
    this.slopeGeneration++;
    this.clearControls();
    this.elapsed = 0;
    this.simulationSpeed = 1;
    this.junction = undefined;
    this.connectionWarning = '';
    this.preferredNext = undefined;
    this.running = true;
    this.paused = false;
    this.initializeHistory();
    this.startLoop();
    void this.refreshSlope();
    void this.loadNearbyProvinces();
    this.onUpdate?.();
  }

  async restore(save: GameSave): Promise<void> {
    await this.railway.load(save.position.province);
    const sourceProvince = this.railway.provinces.find(province => province.adcode === save.position.segmentId.split(':')[0]);
    if (sourceProvince) await this.railway.load(sourceProvince.province);
    const segment = this.railway.network.segments.get(save.position.segmentId);
    if (!segment) throw new Error('存档中的铁路区段不存在，可能线路数据已更新');
    this.position = { ...save.position, offset: Math.max(0, Math.min(segment.length, save.position.offset)) };
    this.train = { ...initialTrainState(), ...save.train };
    this.parkingBrake = Math.abs(this.train.velocity) < 0.001 && this.train.brakeActual >= 99;
    this.routeCoordinate = save.position.travelled;
    this.routeEnd = false;
    this.practiceComplete = false;
    this.tripGeneration++;
    this.loadingBorder = false;
    this.borderLoading = undefined;
    this.lastBorderCheck = undefined;
    this.lastHistoryExtension = -Infinity;
    this.slopeGeneration++;
    this.clearControls();
    this.elapsed = save.elapsed;
    this.simulationSpeed = 1;
    this.junction = undefined;
    this.connectionWarning = '';
    this.preferredNext = undefined;
    this.running = true;
    this.paused = false;
    this.history = save.routeHistory.map((point) => ({ ...point })).sort((a, b) => a.travelled - b.travelled);
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
      routeHistory: this.historyWithCurrent().map((point) => ({ ...point, travelled: point.travelled + this.position!.travelled - this.routeCoordinate })),
      consist: APP_CONFIG.train.cars,
    };
  }

  async manualSave(name: string): Promise<GameSave> {
    const save = this.createSave(name);
    await saveStore.put(save);
    return save;
  }

  clearControls(): void {
    this.heldThrottle.clear();
    this.brakeHeld = false;
    this.repeatTimer = 0;
  }

  setPaused(value: boolean): void {
    this.paused = value;
    this.clearControls();
    this.onUpdate?.();
  }

  setSimulationSpeed(value: number): boolean {
    if (!(APP_CONFIG.simulation.speedOptions as readonly number[]).includes(value)) return false;
    this.simulationSpeed = value as SimulationSpeed;
    // Drop any stale accumulator so switching speed never injects a burst of physics steps.
    this.accumulator = 0;
    this.onUpdate?.();
    return true;
  }

  toggleParkingBrake(): void {
    this.parkingBrake = !this.parkingBrake;
    if (this.parkingBrake) this.setThrottle(0);
    this.onUpdate?.();
  }

  get frontDistance(): number {
    if (!this.position) return 0;
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return 0;
    const sign = Math.sign(this.train.velocity) || this.train.reverser || 1;
    return sign * this.position.direction > 0 ? segment.length - this.position.offset : this.position.offset;
  }

  get nearestStation(): { name: string; distance: number } | undefined {
    const point = this.currentPoint();
    if (!point) return;
    const station = this.stations.nearest(point);
    if (!station) return;
    return { name: station.name, distance: distance(point, { lon: station.longitude, lat: station.latitude }) };
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
    this.routeEnd = false;
    this.junction = undefined;
    this.onUpdate?.();
    return true;
  }

  sand(): boolean {
    if (!this.train.adhesionLimited) return false;
    this.train.sandRemaining = APP_CONFIG.train.sandDuration;
    return true;
  }

  chooseJunction(segmentId: string): void {
    if (!this.junction?.options.some((option) => option.segmentId === segmentId)) return;
    if (!this.position) return;
    const sign = Math.sign(this.train.velocity) || this.train.reverser;
    const direction = sign * this.position.direction;
    const boundary = this.railway.network.nextBoundary(this.position.segmentId, this.position.offset, direction);
    if (!boundary || boundary.nodeId !== this.junction.nodeId || !this.railway.network.drivableExits(this.position.segmentId, boundary, direction).some(exit => exit.key === segmentId)) {
      this.onError?.('道岔候选已变化，请重新选择');
      this.junction = undefined;
      this.preferredNext = undefined;
      this.checkJunction();
      this.onUpdate?.();
      return;
    }
    this.preferredNext = segmentId;
    this.junction = undefined;
    this.junctionDistance = Infinity;
    this.onUpdate?.();
  }

  currentPoint(): RoutePoint | undefined {
    if (!this.position) return;
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return;
    const point = pointAt(segment, this.position.offset);
    return { ...point, heading: (point.heading + (this.position.direction < 0 ? 180 : 0)) % 360,
      height: this.elevation.height(point), travelled: this.routeCoordinate };
  }

  consistPoints(): RoutePoint[] {
    if (!this.position || !this.currentPoint()) return [];
    const points = [this.currentPoint()!];
    let trailingDistance = APP_CONFIG.train.locomotive.length / 2;
    for (const car of APP_CONFIG.train.cars) {
      trailingDistance += APP_CONFIG.train.couplingGap + car.length / 2;
      const point = this.historyPoint(this.routeCoordinate - trailingDistance);
      if (!point) break;
      points.push(point);
      trailingDistance += car.length / 2;
    }
    return points;
  }

  stop(): void {
    this.running = false;
    this.tripGeneration++;
    this.loadingBorder = false;
    cancelAnimationFrame(this.animationFrame);
    this.clearControls();
  }

  private startLoop(): void {
    cancelAnimationFrame(this.animationFrame);
    this.previousTime = performance.now();
    this.accumulator = 0;
    const frame = (time: number) => {
      if (!this.running) return;
      const delta = Math.min(APP_CONFIG.simulation.maxFrameDelta, (time - this.previousTime) / 1000);
      this.previousTime = time;
      this.accumulator += delta * this.simulationSpeed;
      let steps = 0;
      while (this.accumulator >= APP_CONFIG.simulation.fixedStep && steps < APP_CONFIG.simulation.maxStepsPerFrame) {
        this.tick(APP_CONFIG.simulation.fixedStep);
        this.accumulator -= APP_CONFIG.simulation.fixedStep;
        steps++;
      }
      // Never chase an unbounded backlog after a stall or a very slow frame.
      if (steps >= APP_CONFIG.simulation.maxStepsPerFrame) this.accumulator = 0;
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
    if (this.paused || this.junction || this.loadingBorder || this.routeEnd || !this.position) return;
    this.elapsed += dt;
    this.repeatTimer += dt;
    // Input repeat and background work stay at wall-clock cadence while physics is sped up.
    const speed = this.simulationSpeed;
    if (this.repeatTimer >= (APP_CONFIG.train.keyRepeatMs / 1000) * speed) {
      const direction = this.heldThrottle.has('up') ? 1 : this.heldThrottle.has('down') ? -1 : 0;
      if (direction) this.setThrottle(this.train.throttle + direction * APP_CONFIG.train.throttleStep);
      this.repeatTimer = 0;
    }
    stepDynamics(this.train, dt, this.train.slope, this.brakeHeld || this.parkingBrake);
    this.advance(this.train.velocity * dt);
    if (this.position.travelled >= 1000 && Math.abs(this.train.velocity) * 3.6 < 0.5) this.practiceComplete = true;
    this.slopeTimer += dt;
    this.borderTimer += dt;
    this.autosaveTimer += dt;
    if (this.slopeTimer >= 1.5 * speed) {
      this.slopeTimer = 0;
      void this.refreshSlope();
    }
    if (this.borderTimer >= 3 * speed) {
      this.borderTimer = 0;
      void this.loadNearbyProvinces();
    }
    if (this.autosaveTimer >= APP_CONFIG.simulation.autosaveSeconds * speed) {
      this.autosaveTimer = 0;
      this.onAutosave?.();
    }
  }

  private advance(signedDistance: number): void {
    if (!this.position || Math.abs(signedDistance) < 0.000001) return;
    this.routeEnd = false;
    let remaining = signedDistance;
    const movementSign = Math.sign(signedDistance);
    let guard = 0;
    while (Math.abs(remaining) > 0.000001 && guard++ < 128 && this.position) {
      const segment = this.railway.network.segments.get(this.position.segmentId);
      if (!segment) { this.train.velocity = 0; return; }
      const coordinateDirection = movementSign * this.position.direction;
      const boundary = this.railway.network.nextBoundary(segment.id, this.position.offset, coordinateDirection);
      if (!boundary) { this.train.velocity = 0; this.routeEnd = true; break; }
      const available = Math.abs(boundary.offset - this.position.offset);
      const movement = movementSign * Math.min(Math.abs(remaining), available);
      this.position.offset += movement * this.position.direction;
      this.position.travelled += Math.abs(movement);
      this.routeCoordinate += movement;
      remaining -= movement;
      if (Math.abs(movement) < available - 0.000001) break;
      const exits = this.railway.network.drivableExits(segment.id, boundary, coordinateDirection);
      const remembered = this.knownConnection(exits, movementSign);
      const next = this.preferredNext ? exits.find(exit => exit.key === this.preferredNext) : exits.length === 1 ? exits[0] : movementSign < 0 ? remembered : undefined;
      this.recordRoutePoint(true);
      if (!next) {
        if (exits.length > 1) this.openJunction(segment.id, boundary, coordinateDirection);
        else {
          this.train.velocity = 0;
          this.train.throttle = 0;
          this.routeEnd = true;
          void this.retryBorder();
        }
        break;
      }
      // A newly selected branch replaces only the unoccupied direction of the old corridor.
      if (this.preferredNext && (!remembered || remembered.key !== next.key)) {
        this.history = this.history.filter(point => movementSign > 0 ? point.travelled <= this.routeCoordinate : point.travelled >= this.routeCoordinate);
        this.lastHistoryExtension = -Infinity;
      }
      const nextSegment = this.railway.network.segments.get(next.segmentId)!;
      this.position.segmentId = nextSegment.id;
      this.position.direction = (next.direction * movementSign) as 1 | -1;
      this.position.offset = next.offset;
      this.position.province = nextSegment.properties.province;
      this.preferredNext = undefined;
    }
    this.recordRoutePoint();
    if (guard >= 128 && Math.abs(remaining) > 0.000001) {
      this.train.velocity = 0;
      this.setPaused(true);
      this.onError?.('区段切换过于密集，已暂停。可换向或重新选择出发位置。');
    }
    if (this.routeCoordinate - (this.history[0]?.travelled ?? this.routeCoordinate) < 150 &&
        Math.abs(this.routeCoordinate - this.lastHistoryExtension) > 10) this.extendHistory();
    this.checkJunction();
  }

  private checkJunction(): void {
    if (!this.position || this.junction) return;
    this.connectionWarning = '';
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return;
    const sign = Math.sign(this.train.velocity) || this.train.reverser;
    if (!sign) return;
    const direction = sign * this.position.direction;
    const boundary = this.railway.network.nextBoundary(segment.id, this.position.offset, direction);
    if (!boundary) return;
    const remaining = Math.abs(boundary.offset - this.position.offset);
    const candidates = this.railway.network.connectionsAt(segment.id, boundary, direction);
    const exits = candidates.filter(candidate => candidate.valid);
    this.connectionWarning = remaining < APP_CONFIG.simulation.junctionPreviewDistance && exits.length === 1 && exits[0].confidence === 'uncertain'
      ? `前方连接为几何推定：${exits[0].reason}` : '';
    this.junctionDistance = exits.length > 1 && remaining < APP_CONFIG.simulation.junctionPreviewDistance ? remaining : Infinity;
    if (exits.length > 1 && remaining <= APP_CONFIG.simulation.junctionStopDistance && !this.preferredNext && !(sign < 0 && this.knownConnection(exits, sign, remaining))) {
      this.openJunction(segment.id, boundary, direction);
    }
  }

  private openJunction(segmentId: string, boundary: RailBoundary, direction: number): void {
    const options = this.railway.network.drivableExits(segmentId, boundary, direction).map((exit): JunctionOption => {
      const next = this.railway.network.segments.get(exit.segmentId)!;
      const a = pointAt(next, exit.offset);
      const b = pointAt(next, exit.offset + exit.direction * Math.min(300, exit.direction > 0 ? next.length - exit.offset : exit.offset));
      const degrees = bearing(a, b);
      const path = this.railway.network.previewPath(exit);
      const name = next.properties.name !== '未命名铁路' ? next.properties.name :
        path.names.length === 1 ? `${path.names[0]}连接区段（推断）` : '未识别轨道';
      return { segmentId: exit.key, name, bearing: degrees, direction: compassDirection(degrees), nextStation: '后续车站未确认',
        angle: exit.angle, preview: path.points, previewLength: path.length, stopReason: path.stopReason,
        confidence: path.uncertain ? 'uncertain' : 'derived', reason: exit.reason };
    });
    this.clearControls();
    const current = this.railway.network.segments.get(segmentId)!;
    const at = pointAt(current, boundary.offset);
    const incomingBearing = bearing(pointAt(current, boundary.offset - Math.sign(direction) * 10), at);
    const approachAvailable = direction > 0 ? boundary.offset : current.length - boundary.offset;
    const approachMeters = Math.min(APP_CONFIG.simulation.junctionApproachMeters, Math.max(0, approachAvailable));
    const incoming: LonLat[] = [];
    const approachSteps = approachMeters > 0.5 ? Math.max(1, Math.ceil(approachMeters / 10)) : 0;
    for (let index = 0; index <= approachSteps; index++) {
      const behind = approachMeters * (1 - index / Math.max(1, approachSteps));
      incoming.push(pointAt(current, boundary.offset - direction * behind));
    }
    if (!incoming.length) incoming.push(at);
    // Nearby tracks give the prompt local yard context. The selected preview path remains the
    // authoritative route; this background geometry is display-only and never a second connection rule.
    const contextTracks = this.railway.network.segmentsNear(at, APP_CONFIG.simulation.junctionContextRadius,
      APP_CONFIG.simulation.junctionContextMaxSegments, current.id).map((segment) => ({
      segmentId: segment.id,
      name: segment.properties.name === '未命名铁路' ? '未识别轨道' : segment.properties.name,
      bridge: segment.properties.bridge,
      tunnel: segment.properties.tunnel,
      points: segment.points.map((point) => ({ lon: point.lon, lat: point.lat })),
    }));
    const diagnostics = this.railway.network.connectionsAt(segmentId, boundary, direction).map(connection => ({
      ...connection, incoming: { segmentId, osmId: current.properties.osmId, properties: current.properties, direction },
      outgoing: this.railway.network.segments.get(connection.segmentId)?.properties,
      previewStop: options.find(option => option.segmentId === connection.key)?.stopReason,
    }));
    this.junction = { nodeId: boundary.nodeId, atSegmentEnd: direction > 0, options,
      currentName: current.properties.name === '未命名铁路' ? '未识别轨道' : current.properties.name, incomingBearing,
      context: { center: at, incoming, tracks: contextTracks }, diagnostics };
    this.onUpdate?.();
  }

  private knownConnection(exits: RailExit[], sign: number, boundaryDistance = 0): RailExit | undefined {
    if (!this.position || exits.length < 2) return;
    const ranked = exits.map(exit => {
      const segment = this.railway.network.segments.get(exit.segmentId)!;
      const delta = Math.min(3, (exit.direction > 0 ? segment.length - exit.offset : exit.offset) / 2);
      const known = this.historyPoint(this.routeCoordinate + sign * (boundaryDistance + delta));
      return { exit, distance: known ? distance(known, pointAt(segment, exit.offset + exit.direction * delta)) : Infinity };
    }).filter(item => item.distance < 1).sort((a, b) => a.distance - b.distance);
    if (ranked.length === 1 || (ranked.length > 1 && ranked[1].distance - ranked[0].distance > 0.2)) return ranked[0].exit;
  }

  private initializeHistory(): void {
    this.history = [];
    this.recordRoutePoint(true);
    this.extendHistory();
  }

  private extendHistory(): void {
    if (!this.position) return;
    this.lastHistoryExtension = this.routeCoordinate;
    let segment = this.railway.network.segments.get(this.position.segmentId)!;
    let direction = this.position.direction;
    let offset = this.position.offset;
    let coordinate = this.routeCoordinate;
    const oldest = this.history[0]?.travelled ?? coordinate;
    const points: RoutePoint[] = [];
    let distanceLeft = APP_CONFIG.simulation.routeHistoryLength;
    let guard = 0;
    while (distanceLeft > 0 && guard++ < 5000) {
      const point = pointAt(segment, offset);
      if (coordinate < oldest) points.push({ ...point, heading: (point.heading + (direction < 0 ? 180 : 0)) % 360,
        height: this.elevation.height(point), travelled: coordinate });
      const boundary = this.railway.network.nextBoundary(segment.id, offset, -direction);
      if (!boundary) break;
      const available = Math.abs(offset - boundary.offset);
      const step = Math.min(5, available, distanceLeft);
      offset -= step * direction;
      coordinate -= step;
      distanceLeft -= step;
      if (available > step + 0.000001) continue;
      const choices = this.railway.network.drivableExits(segment.id, boundary, -direction);
      const known = this.historyPoint(coordinate - 2);
      const matches = known ? choices.filter(exit => {
        const next = this.railway.network.segments.get(exit.segmentId)!;
        return distance(pointAt(next, exit.offset + exit.direction * Math.min(2, next.length / 2)), known) < 0.5;
      }) : [];
      // For initial tail placement, continuity within the same original polyline is unambiguous.
      const continuation = choices.find(exit => exit.segmentId === segment.id);
      const next = matches.length === 1 ? matches[0] : continuation ?? (choices.length === 1 ? choices[0] : undefined);
      if (!next) break;
      const corner = pointAt(segment, offset);
      if (coordinate < oldest) points.push({ ...corner, heading: (corner.heading + (direction < 0 ? 180 : 0)) % 360,
        height: this.elevation.height(corner), travelled: coordinate });
      direction = -next.direction as 1 | -1;
      segment = this.railway.network.segments.get(next.segmentId)!;
      offset = next.offset;
    }
    this.history = [...points.reverse(), ...this.history].sort((a, b) => a.travelled - b.travelled)
      .filter((point, index, all) => index === 0 || point.travelled > all[index - 1].travelled + 0.000001);
  }

  private recordRoutePoint(force = false): void {
    const point = this.currentPoint();
    if (!point) return;
    // Keep committed samples separate from the live head, so sub-metre steps accumulate.
    const coordinate = this.routeCoordinate;
    let left = -1, right = this.history.length;
    while (left + 1 < right) {
      const middle = (left + right) >> 1;
      if (this.history[middle].travelled <= coordinate) left = middle;
      else right = middle;
    }
    if (left >= 0 && Math.abs(this.history[left].travelled - coordinate) < 0.000001) this.history[left] = point;
    else if (force || left < 0 || (left === this.history.length - 1 && coordinate - this.history[left].travelled >= 1.5)) {
      this.history.splice(left + 1, 0, point);
    }
    const earliest = coordinate - APP_CONFIG.simulation.routeHistoryLength;
    const latest = coordinate + APP_CONFIG.simulation.routeHistoryLength;
    this.history = this.history.filter(sample => sample.travelled >= earliest && sample.travelled <= latest);
  }

  private historyWithCurrent(): RoutePoint[] {
    const points = this.history.map(point => ({ ...point }));
    const current = this.currentPoint();
    if (!current) return points;
    const index = points.findIndex(point => point.travelled >= current.travelled);
    if (index < 0) points.push(current);
    else if (Math.abs(points[index].travelled - current.travelled) < 0.000001) points[index] = current;
    else points.splice(index, 0, current);
    return points;
  }

  private historyPoint(travelled: number): RoutePoint | undefined {
    const points = this.history;
    const current = this.currentPoint();
    if (!points.length || !current) return;
    if (travelled < Math.min(points[0].travelled, current.travelled) - 0.001 ||
        travelled > Math.max(points[points.length - 1].travelled, current.travelled) + 0.001) return;
    let low = 0, high = points.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (points[mid].travelled <= travelled) low = mid;
      else high = mid;
    }
    let a = points[low], b = points[high];
    if (travelled >= current.travelled && current.travelled >= a.travelled) a = current;
    if (travelled <= current.travelled && current.travelled <= b.travelled) b = current;
    if (travelled >= points[points.length - 1].travelled) { a = points[points.length - 1]; b = current; }
    const span = b.travelled - a.travelled;
    const t = span > 0 ? Math.max(0, Math.min(1, (travelled - a.travelled) / span)) : 0;
    const headingDelta = ((b.heading - a.heading + 540) % 360) - 180;
    return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t,
      height: a.height + (b.height - a.height) * t, heading: (a.heading + headingDelta * t + 360) % 360, travelled };
  }

  private async refreshSlope(): Promise<void> {
    if (!this.position) return;
    const segment = this.railway.network.segments.get(this.position.segmentId);
    if (!segment) return;
    const generation = ++this.slopeGeneration;
    const direction = this.position.direction;
    const span = Math.min(150, segment.length / 2);
    const center = pointAt(segment, this.position.offset);
    const aheadOffset = Math.max(0, Math.min(segment.length, this.position.offset + span * direction));
    const behindOffset = Math.max(0, Math.min(segment.length, this.position.offset - span * direction));
    const ahead = pointAt(segment, aheadOffset), behind = pointAt(segment, behindOffset);
    // Physical slope always uses the locomotive's body-forward axis, including while reversing.
    const slope = await this.elevation.slope(center, ahead, behind, Math.abs(aheadOffset - behindOffset));
    if (generation !== this.slopeGeneration) return;
    const visibleHistory = this.history.filter(point => Math.abs(point.travelled - this.routeCoordinate) < 180);
    const heights = await this.elevation.sample(visibleHistory);
    if (generation !== this.slopeGeneration) return;
    visibleHistory.forEach((point, index) => { point.height = heights[index]; });
    if (this.position?.segmentId === segment.id) this.train.slope = slope;
  }

  async retryBorder(): Promise<void> {
    if (this.loadingBorder || !this.position) return;
    const generation = this.tripGeneration;
    const original = { ...this.position };
    this.loadingBorder = true;
    this.onUpdate?.();
    try { await this.loadNearbyProvinces(true); }
    finally {
      if (generation !== this.tripGeneration) return;
      this.loadingBorder = false;
      if (this.position?.segmentId === original.segmentId && Math.abs(this.position.offset - original.offset) < 0.01) {
        const direction = (this.train.reverser || 1) * this.position.direction;
        const boundary = this.railway.network.nextBoundary(this.position.segmentId, this.position.offset, direction);
        this.routeEnd = !boundary || (Math.abs(boundary.offset - this.position.offset) < 0.01 &&
          this.railway.network.drivableExits(this.position.segmentId, boundary, direction).length === 0);
      }
      this.onUpdate?.();
    }
  }

  private async loadNearbyProvinces(force = false): Promise<void> {
    if (this.borderLoading) return this.borderLoading;
    if (!this.position) return;
    const point = this.currentPoint();
    if (!point || (!force && this.lastBorderCheck && distance(point, this.lastBorderCheck) < 8000)) return;
    this.lastBorderCheck = point;
    const generation = this.tripGeneration;
    const names = neighboringProvinces(this.position.province);
    const nearby = new Set(this.stations.stations.filter(station => Math.abs(station.longitude - point.lon) < 0.22 && Math.abs(station.latitude - point.lat) < 0.22).map(station => station.province));
    // Explicit adjacency covers borders with no station hints. Load sequentially to bound parsing pressure.
    const ordered = [...new Set([...nearby, ...names])].filter(name => name !== this.position!.province && this.railway.byProvince(name));
    this.borderLoading = (async () => {
      for (const province of ordered) {
        if (generation !== this.tripGeneration) break;
        try { await this.railway.load(province); }
        catch (error) { if (generation === this.tripGeneration) this.onError?.(error instanceof Error ? error.message : '相邻省份线路加载失败'); }
      }
    })();
    try { await this.borderLoading; } finally { if (generation === this.tripGeneration) this.borderLoading = undefined; }
  }
}
