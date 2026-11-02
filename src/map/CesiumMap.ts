import {
  Cartesian2, Cartesian3, Cartographic, Color, ColorGeometryInstanceAttribute, EllipsoidTerrainProvider, GeometryInstance,
  GroundPolylineGeometry, GroundPolylinePrimitive, PolylineColorAppearance, Rectangle, createWorldImageryAsync, createWorldTerrainAsync,
  HeadingPitchRange, Ion, LabelStyle, Math as CesiumMath, Matrix4, NearFarScalar,
  ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin, Viewer,
} from 'cesium';
import { APP_CONFIG } from '../config';
import type { GameSession } from '../core/session';
import type { LonLat, RailSegment, Station } from '../types';
import { RailRenderer } from './RailRenderer';
import { TrainRenderer } from './TrainRenderer';
import { offsetPoint } from '../utils/geo';
import { withTimeout } from '../utils/assets';

export class CesiumMap {
  viewer!: Viewer;
  onStatus?: (message: string) => void;
  onError?: (message: string) => void;
  serviceStatus = '';
  private disposed = false;
  private serviceGeneration = 0;
  private servicesLoading?: Promise<void>;
  private removeRenderError?: () => void;
  private imageryLoaded = false;
  private railRenderer!: RailRenderer;
  private provinceRailway?: GroundPolylinePrimitive;
  private trainRenderer!: TrainRenderer;
  private handler?: ScreenSpaceEventHandler;
  private session?: GameSession;
  private cameraTarget?: Cartesian3;
  private cameraRange: number = APP_CONFIG.camera.range;
  private cameraRangeDirty = true;
  private cameraMode: 'cab' | 'external' = 'cab';
  private cabHeading?: number;
  private animationFrame = 0;
  private previousTime = 0;
  private downPosition?: Cartesian2;
  private pickLocation?: (point: LonLat) => void;
  private pickStation?: (code: string) => void;

  async initialize(container: HTMLElement): Promise<void> {
    Ion.defaultAccessToken = APP_CONFIG.cesiumIonToken;
    const terrain = new EllipsoidTerrainProvider();
    this.viewer = new Viewer(container, {
      baseLayer: false,
      terrainProvider: terrain,
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      requestRenderMode: false,
      msaaSamples: 2,
    });
    this.viewer.scene.globe.baseColor = Color.fromCssColorString('#253a31');
    this.session?.elevation.setProvider(this.viewer.terrainProvider);
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = APP_CONFIG.camera.minRange;
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 20_000_000;
    this.viewer.camera.setView({ destination: Cartesian3.fromDegrees(108, 34, 10_500_000) });
    this.viewer.cesiumWidget.creditContainer.setAttribute('style', 'font-size:10px;opacity:.65');
    this.railRenderer = new RailRenderer(this.viewer, this.session!.elevation);
    this.trainRenderer = new TrainRenderer(this.viewer);
    this.setupPicking();
    this.removeRenderError = this.viewer.scene.renderError.addEventListener(() => {
      if (this.session) this.session.paused = true;
      this.onError?.('三维画面暂时中断，列车已暂停。请重试地图服务后继续驾驶。');
    });
    this.previousTime = performance.now();
    this.animate();
    void this.retryServices();
  }

  /** Optional online scenery never blocks entry into the simulator. */
  retryServices(): Promise<void> {
    if (this.servicesLoading) return this.servicesLoading;
    this.servicesLoading = this.loadServices().catch(() => {
      if (this.disposed) return;
      this.serviceStatus = '地图服务恢复失败，请重试；当前驾驶进度已保留';
      this.onStatus?.(this.serviceStatus);
    }).finally(() => { this.servicesLoading = undefined; });
    return this.servicesLoading;
  }

  private async loadServices(): Promise<void> {
    const generation = ++this.serviceGeneration;
    const current = () => !this.disposed && generation === this.serviceGeneration && !this.viewer.isDestroyed();
    this.serviceStatus = '正在加载卫星影像和地形，可先选择车站';
    this.onStatus?.(this.serviceStatus);
    const results = await Promise.allSettled([
      withTimeout(createWorldTerrainAsync(), 12_000, '地形服务连接超时'),
      this.imageryLoaded ? Promise.resolve(undefined) : withTimeout(createWorldImageryAsync(), 12_000, '卫星影像连接超时'),
    ]);
    if (!current()) return;
    const [terrain, imagery] = results;
    if (terrain.status === 'fulfilled') {
      this.viewer.terrainProvider = terrain.value;
      this.session?.elevation.setProvider(terrain.value);
    }
    if (imagery.status === 'fulfilled' && imagery.value) {
      this.viewer.imageryLayers.addImageryProvider(imagery.value);
      this.imageryLoaded = true;
    }
    const unavailable = [terrain.status === 'rejected' ? '地形' : '', imagery.status === 'rejected' ? '卫星影像' : ''].filter(Boolean);
    this.serviceStatus = unavailable.length ? `${unavailable.join('、')}暂不可用，已使用基础地球；可继续驾驶或重试` : '';
    this.onStatus?.(this.serviceStatus);
    this.viewer.useDefaultRenderLoop = true;
    this.viewer.scene.requestRender();
    const point = this.session?.currentPoint();
    if (terrain.status === 'fulfilled' && point && this.session?.running) {
      void this.renderRailway(this.session.railway.network.segmentsNear(point, APP_CONFIG.data.renderRadius)).catch(() => {
        this.onStatus?.('地形已恢复，附近轨道将在下一次更新时重绘');
      });
    }
  }

  attachSession(session: GameSession): void {
    this.session = session;
  }

  async renderRailway(segments: RailSegment[]): Promise<void> {
    this.clearProvinceRailway();
    await this.railRenderer.render(segments, this.session?.currentPoint());
  }

  // Overview uses the original WGS84 vertices, with no straight-line joins between parts.
  showProvinceRailway(segments: RailSegment[]): void {
    this.clearProvinceRailway();
    this.railRenderer.clear();
    if (!segments.length) return;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    const geometryInstances = segments.map((segment) => {
      const positions = segment.points.map((point) => {
        west = Math.min(west, point.lon); east = Math.max(east, point.lon);
        south = Math.min(south, point.lat); north = Math.max(north, point.lat);
        return Cartesian3.fromDegrees(point.lon, point.lat);
      });
      return new GeometryInstance({
        geometry: new GroundPolylineGeometry({ positions, width: 2 }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString('#d8ff62')) },
      });
    });
    this.provinceRailway = this.viewer.scene.groundPrimitives.add(new GroundPolylinePrimitive({
      geometryInstances,
      appearance: new PolylineColorAppearance(),
      allowPicking: false,
    }));
    this.cameraTarget = undefined;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.camera.flyTo({ destination: Rectangle.fromDegrees(west - 0.1, south - 0.1, east + 0.1, north + 0.1), duration: 1.2 });
  }

  private clearProvinceRailway(): void {
    if (this.provinceRailway && !this.viewer.isDestroyed()) this.viewer.scene.groundPrimitives.remove(this.provinceRailway);
    this.provinceRailway = undefined;
  }

  clearRailway(): void {
    this.clearProvinceRailway();
    this.railRenderer.clear();
  }

  showStations(stations: Station[]): void {
    const collection = this.viewer.entities;
    collection.values.filter((entity) => entity.id.startsWith('station-')).forEach((entity) => collection.remove(entity));
    stations.forEach((station) => {
      collection.add({
        id: `station-${station.telecode}`,
        position: Cartesian3.fromDegrees(station.longitude, station.latitude, 30),
        point: { pixelSize: 7, color: Color.fromCssColorString('#d8ff62'), outlineColor: Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: station.name,
          font: '12px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -12),
          scaleByDistance: new NearFarScalar(1000, 1, 50_000, 0),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
  }

  clearStations(): void {
    this.viewer.entities.values.filter((entity) => entity.id.startsWith('station-')).forEach((entity) => this.viewer.entities.remove(entity));
  }

  flyTo(point: LonLat, range = 25_000): void {
    this.cameraTarget = undefined;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(point.lon, point.lat, range), duration: 1.2 });
  }

  setPicking(onLocation?: (point: LonLat) => void, onStation?: (code: string) => void): void {
    this.pickLocation = onLocation;
    this.pickStation = onStation;
  }

  setCameraRange(range: number): void {
    this.cameraRange = Math.max(APP_CONFIG.camera.minRange, Math.min(APP_CONFIG.camera.maxRange, range));
    this.cameraRangeDirty = true;
  }

  setCameraMode(mode: 'cab' | 'external'): void {
    this.cameraMode = mode;
    this.cameraTarget = undefined;
    this.cabHeading = undefined;
    this.cameraRangeDirty = true;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }

  destroy(): void {
    this.disposed = true;
    this.serviceGeneration++;
    cancelAnimationFrame(this.animationFrame);
    this.removeRenderError?.();
    if (this.viewer && !this.viewer.isDestroyed()) {
      this.railRenderer?.clear();
      this.clearProvinceRailway();
    }
    this.handler?.destroy();
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
  }

  private setupPicking(): void {
    this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.handler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => { this.downPosition = event.position; }, ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
      if (!this.downPosition || Cartesian2.distance(this.downPosition, event.position) > 5) return;
      const picked = this.viewer.scene.pick(event.position);
      const stationId = picked?.id?.id as string | undefined;
      if (stationId?.startsWith('station-') && this.pickStation) {
        this.pickStation(stationId.slice(8));
        return;
      }
      if (!this.pickLocation) return;
      const ray = this.viewer.camera.getPickRay(event.position);
      const cartesian = ray ? this.viewer.scene.globe.pick(ray, this.viewer.scene) : undefined;
      if (!cartesian) return;
      const cartographic = Cartographic.fromCartesian(cartesian);
      this.pickLocation({ lon: CesiumMath.toDegrees(cartographic.longitude), lat: CesiumMath.toDegrees(cartographic.latitude) });
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  private animate = (): void => {
    if (this.disposed || this.viewer.isDestroyed()) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.previousTime) / 1000);
    this.previousTime = now;
    if (this.session?.running) {
      const points = this.session.consistPoints();
      const inCab = this.cameraMode === 'cab';
      this.viewer.scene.screenSpaceCameraController.enableInputs = !inCab;
      this.trainRenderer.update(inCab ? [] : points);
      if (points[0]) {
        const point = points[0];
        if (inCab) this.driveFromCab(point.lon, point.lat, point.height, point.heading, dt);
        else this.follow(point.lon, point.lat, point.height, point.heading, dt);
      }
    } else {
      this.viewer.scene.screenSpaceCameraController.enableInputs = true;
      this.cameraTarget = undefined;
      this.cabHeading = undefined;
      this.trainRenderer.update([]);
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private driveFromCab(lon: number, lat: number, height: number, heading: number, dt: number): void {
    const desired = CesiumMath.toRadians(heading);
    if (this.cabHeading === undefined) this.cabHeading = desired;
    else {
      const difference = Math.atan2(Math.sin(desired - this.cabHeading), Math.cos(desired - this.cabHeading));
      this.cabHeading += difference * (1 - Math.exp(-APP_CONFIG.camera.cabHeadingSmoothing * dt));
    }
    // Place the eye near the front of the locomotive, looking down the track.
    const eye = offsetPoint({ lon, lat }, heading - 90, APP_CONFIG.camera.cabForwardOffset);
    const ground = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(eye.lon, eye.lat));
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(eye.lon, eye.lat, Math.max(height, ground ?? height) + APP_CONFIG.track.heightOffset + APP_CONFIG.camera.cabEyeHeight),
      orientation: { heading: this.cabHeading, pitch: APP_CONFIG.camera.cabPitch, roll: 0 },
    });
  }

  private follow(lon: number, lat: number, height: number, heading: number, dt: number): void {
    const target = Cartesian3.fromDegrees(lon, lat, height + 5);
    const firstFrame = !this.cameraTarget;
    if (!this.cameraTarget) this.cameraTarget = target;
    else Cartesian3.lerp(this.cameraTarget, target, 1 - Math.exp(-APP_CONFIG.camera.smoothing * dt), this.cameraTarget);
    const currentRange = Cartesian3.distance(this.viewer.camera.positionWC, this.cameraTarget);
    const useCurrentRange = !this.cameraRangeDirty && Number.isFinite(currentRange) && currentRange < 100_000;
    const range = Math.max(APP_CONFIG.camera.minRange, Math.min(APP_CONFIG.camera.maxRange, useCurrentRange ? currentRange : this.cameraRange));
    this.viewer.camera.lookAt(this.cameraTarget, new HeadingPitchRange(firstFrame ? CesiumMath.toRadians(heading) : this.viewer.camera.heading, firstFrame ? APP_CONFIG.camera.pitch : Math.min(-0.08, this.viewer.camera.pitch), range));
    this.cameraRangeDirty = false;
    const cameraHeight = this.viewer.scene.globe.getHeight(this.viewer.camera.positionCartographic);
    if (cameraHeight !== undefined && this.viewer.camera.positionCartographic.height < cameraHeight + 8) {
      const correctedWorldPosition = Cartesian3.fromRadians(this.viewer.camera.positionCartographic.longitude, this.viewer.camera.positionCartographic.latitude, cameraHeight + 8);
      this.viewer.camera.position = this.viewer.camera.worldToCameraCoordinatesPoint(correctedWorldPosition);
    }
  }
}
