import {
  Cartesian2, Cartesian3, Cartographic, Color, ConstantProperty, DistanceDisplayCondition, HeightReference,
  LabelStyle, NearFarScalar, SceneTransforms, VerticalOrigin, type Entity, type Viewer,
} from 'cesium';
import { APP_CONFIG } from '../config';
import type { LonLat, Station } from '../types';
import { distance } from '../utils/geo';
import { chooseStationLabels, nearbyStations, stationLabelText, stationLabelWidth, type StationScreenLabel } from './stationLabels';

type StationLabelMode = 'none' | 'overview' | 'driving';

interface DisplayStation {
  station: Station;
  entity: Entity;
  /**
   * WGS84 station anchor. The entity renders at `markerHeight` above the
   * terrain surface (HeightReference.RELATIVE_TO_GROUND); screen projection
   * re-applies the currently loaded terrain height at this anchor.
   */
  anchor: Cartographic;
  text: string;
}

const ACCENT = Color.fromCssColorString('#d8ff62');
const POINT_OUTLINE = Color.fromCssColorString('#07100a');
const LABEL_FILL = Color.fromCssColorString('#f4f8ee');
const LABEL_OUTLINE = Color.fromCssColorString('#07100a');
const LABEL_BACKGROUND = Color.fromCssColorString('#07100a').withAlpha(0.82);

const scratchToStation = new Cartesian3();
const scratchScreen = new Cartesian2();
const scratchWorld = new Cartesian3();

/**
 * Draws station dots and floating station-name labels on the 3D map.
 *
 * The renderer owns a bounded entity set rather than adding all 2,879 stations
 * to Cesium. In driving mode only stations within `renderDistance` of the
 * locomotive exist as entities; labels additionally fade out before
 * `displayDistance`. Labels are greedily de-cluttered in screen space because
 * Cesium entity labels do not avoid each other.
 */
export class StationLabelRenderer {
  private mode: StationLabelMode = 'none';
  private readonly entities = new Map<string, DisplayStation>();
  private readonly visible = new Set<string>();
  private drivingCenter?: LonLat;
  private lastLabelUpdate = 0;

  constructor(private readonly viewer: Viewer) {}

  showOverview(stations: readonly Station[]): void {
    if (this.viewer.isDestroyed()) return;
    this.mode = 'overview';
    this.drivingCenter = undefined;
    this.replaceAll(this.uniqueStations(stations), 'overview');
    this.lastLabelUpdate = performance.now();
    this.refreshVisibleLabels();
  }

  /**
   * Called every frame by CesiumMap. `center` is the locomotive position while
   * driving; when it is absent, any driving set is released. The overview set
   * is kept because it is only replaced by showOverview/clear.
   */
  update(now: number, center: LonLat | undefined, stations: readonly Station[]): void {
    if (this.viewer.isDestroyed()) return;
    if (center) {
      if (this.mode !== 'driving') {
        this.mode = 'driving';
        this.replaceAll([], 'driving');
        this.drivingCenter = undefined;
      }
      if (!this.drivingCenter || distance(center, this.drivingCenter) >= APP_CONFIG.stationLabels.refreshDistance) {
        this.refreshDrivingSet(center, stations);
        this.lastLabelUpdate = now;
        this.refreshVisibleLabels();
      }
    } else if (this.mode === 'driving') {
      this.clear();
      return;
    }

    if (this.mode === 'none') return;
    if (now - this.lastLabelUpdate < APP_CONFIG.stationLabels.labelUpdateIntervalMs) return;
    this.lastLabelUpdate = now;
    this.refreshVisibleLabels();
  }

  clear(): void {
    this.removeAll();
    this.mode = 'none';
    this.drivingCenter = undefined;
    this.lastLabelUpdate = 0;
  }

  private uniqueStations(stations: readonly Station[]): Station[] {
    const seen = new Set<string>();
    const result: Station[] = [];
    for (const station of stations) {
      if (!station.telecode || seen.has(station.telecode)) continue;
      if (!Number.isFinite(station.longitude) || !Number.isFinite(station.latitude)) continue;
      seen.add(station.telecode);
      result.push(station);
    }
    return result;
  }

  private replaceAll(stations: readonly Station[], mode: Exclude<StationLabelMode, 'none'>): void {
    this.removeAll();
    for (const station of this.uniqueStations(stations)) this.addStation(station, mode);
  }

  private refreshDrivingSet(center: LonLat, stations: readonly Station[]): void {
    const config = APP_CONFIG.stationLabels;
    const nearby = nearbyStations(stations, center, config.renderDistance, config.maxDrivingStations);
    const next = new Set(nearby.map(entry => entry.station.telecode));
    for (const [telecode, item] of this.entities) {
      if (next.has(telecode)) continue;
      this.viewer.entities.remove(item.entity);
      this.entities.delete(telecode);
      this.visible.delete(telecode);
    }
    for (const entry of nearby) {
      if (!this.entities.has(entry.station.telecode)) this.addStation(entry.station, 'driving');
    }
    this.drivingCenter = { lon: center.lon, lat: center.lat };
  }

  private addStation(station: Station, mode: Exclude<StationLabelMode, 'none'>): void {
    const config = APP_CONFIG.stationLabels;
    const text = stationLabelText(station.name);
    // RELATIVE_TO_GROUND keeps the marker at markerHeight above the terrain
    // surface, so high-altitude stations no longer sink below the globe.
    const anchor = Cartographic.fromDegrees(station.longitude, station.latitude);
    const entity = this.viewer.entities.add({
      id: `station-${station.telecode}`,
      name: station.full_name,
      position: Cartesian3.fromRadians(anchor.longitude, anchor.latitude, config.markerHeight),
      point: {
        pixelSize: 7,
        color: ACCENT,
        outlineColor: POINT_OUTLINE,
        outlineWidth: 2,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        ...(mode === 'driving' ? {
          // Keep dots and labels in the same display band; the larger render
          // radius only keeps entities ready for the train's approach.
          distanceDisplayCondition: new DistanceDisplayCondition(0, config.displayDistance),
        } : {}),
      },
      label: {
        text,
        font: `500 ${config.fontSize}px "Noto Sans SC", "Microsoft YaHei", sans-serif`,
        style: LabelStyle.FILL_AND_OUTLINE,
        fillColor: LABEL_FILL,
        outlineColor: LABEL_OUTLINE,
        outlineWidth: 2,
        showBackground: true,
        backgroundColor: LABEL_BACKGROUND,
        backgroundPadding: new Cartesian2(6, 3),
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -config.labelOffsetY),
        show: false,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        ...(mode === 'driving' ? {
          distanceDisplayCondition: new DistanceDisplayCondition(0, config.displayDistance),
          // Fade only text near the culling edge; the dot stays as a location cue.
          translucencyByDistance: new NearFarScalar(config.displayDistance * 0.8, 1, config.displayDistance, 0),
        } : {}),
      },
    });
    this.entities.set(station.telecode, { station, entity, anchor, text });
  }

  private removeAll(): void {
    for (const item of this.entities.values()) this.viewer.entities.remove(item.entity);
    this.entities.clear();
    this.visible.clear();
  }

  private refreshVisibleLabels(): void {
    if (this.mode === 'none' || this.entities.size === 0) {
      this.hideAll();
      return;
    }
    const scene = this.viewer.scene;
    const width = scene.canvas.clientWidth || scene.canvas.width;
    const height = scene.canvas.clientHeight || scene.canvas.height;
    if (!width || !height) return;
    const camera = this.viewer.camera;
    const config = APP_CONFIG.stationLabels;
    const candidates: StationScreenLabel[] = [];
    for (const [telecode, item] of this.entities) {
      // Mirror the RELATIVE_TO_GROUND rendering height with the terrain tiles
      // that are currently loaded; falls back to the ellipsoid when unloaded.
      const terrainHeight = scene.globe.getHeight(item.anchor) ?? 0;
      const world = Cartesian3.fromRadians(
        item.anchor.longitude, item.anchor.latitude,
        terrainHeight + config.markerHeight, scene.globe.ellipsoid, scratchWorld,
      );
      const cameraDistance = Cartesian3.distance(camera.positionWC, world);
      if (this.mode === 'driving' && cameraDistance > config.displayDistance) continue;
      const toStation = Cartesian3.subtract(world, camera.positionWC, scratchToStation);
      if (Cartesian3.dot(toStation, camera.directionWC) <= 0) continue;
      const screen = SceneTransforms.worldToWindowCoordinates(scene, world, scratchScreen);
      if (!screen) continue;
      const priority = this.mode === 'driving'
        ? cameraDistance
        : Math.hypot(screen.x - width / 2, screen.y - height / 2);
      candidates.push({
        telecode, text: item.text, x: screen.x, y: screen.y,
        width: stationLabelWidth(item.text), priority,
      });
    }
    const shown = new Set(chooseStationLabels(candidates, { width, height }, config.maxVisibleLabels));
    for (const [telecode, item] of this.entities) {
      const shouldShow = shown.has(telecode);
      if (this.visible.has(telecode) === shouldShow) continue;
      item.entity.label!.show = new ConstantProperty(shouldShow);
      if (shouldShow) this.visible.add(telecode);
      else this.visible.delete(telecode);
    }
  }

  private hideAll(): void {
    for (const telecode of this.visible) {
      const item = this.entities.get(telecode);
      if (item) item.entity.label!.show = new ConstantProperty(false);
    }
    this.visible.clear();
  }
}
