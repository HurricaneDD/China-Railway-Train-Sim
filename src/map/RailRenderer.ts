import { Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance, PolylineColorAppearance, PolylineGeometry, Primitive, type Viewer } from 'cesium';
import { APP_CONFIG } from '../config';
import type { ElevationService } from '../core/elevation';
import type { RailSegment } from '../types';
import { offsetPoint, pointAt } from '../utils/geo';

export class RailRenderer {
  private primitives: Primitive[] = [];

  constructor(private viewer: Viewer, private elevation: ElevationService) {}

  clear(): void {
    this.primitives.forEach((primitive) => this.viewer.scene.primitives.remove(primitive));
    this.primitives = [];
  }

  async render(segments: RailSegment[]): Promise<void> {
    this.clear();
    if (!segments.length) return;
    const unique = new Map<string, { lon: number; lat: number }>();
    segments.forEach((segment) => segment.points.forEach((point) => unique.set(`${point.lon.toFixed(5)},${point.lat.toFixed(5)}`, point)));
    await this.elevation.sample([...unique.values()].slice(0, 6000));
    const rails: GeometryInstance[] = [];
    const sleepers: GeometryInstance[] = [];
    let sleeperCount = 0;

    for (const segment of segments) {
      const centerHeights = segment.points.map((point) => this.elevation.height(point) + APP_CONFIG.track.heightOffset);
      for (const side of [-1, 1]) {
        const positions = segment.points.map((point, index) => {
          const heading = index === segment.points.length - 1 ? pointAt(segment, segment.length).heading : pointAt(segment, segment.cumulative[index] + 0.01).heading;
          const shifted = offsetPoint(point, heading, side * APP_CONFIG.track.gauge / 2);
          return Cartesian3.fromDegrees(shifted.lon, shifted.lat, centerHeights[index]);
        });
        rails.push(this.polyline(positions, 1.6, Color.fromCssColorString('#b7bdb8')));
      }
      for (let offset = 0; offset < segment.length && sleeperCount < 1800; offset += APP_CONFIG.track.sleeperSpacing) {
        const center = pointAt(segment, offset);
        const index = Math.max(1, segment.cumulative.findIndex((value) => value >= offset));
        const span = segment.cumulative[index] - segment.cumulative[index - 1];
        const fraction = span > 0 ? (offset - segment.cumulative[index - 1]) / span : 0;
        const height = centerHeights[index - 1] + (centerHeights[index] - centerHeights[index - 1]) * fraction;
        const left = offsetPoint(center, center.heading, -APP_CONFIG.track.sleeperLength / 2);
        const right = offsetPoint(center, center.heading, APP_CONFIG.track.sleeperLength / 2);
        sleepers.push(this.polyline([Cartesian3.fromDegrees(left.lon, left.lat, height), Cartesian3.fromDegrees(right.lon, right.lat, height)], 2.4, Color.fromCssColorString('#514e45')));
        sleeperCount++;
      }
    }
    this.addPrimitive(rails);
    this.addPrimitive(sleepers);
  }

  private polyline(positions: Cartesian3[], width: number, color: Color): GeometryInstance {
    return new GeometryInstance({
      geometry: new PolylineGeometry({ positions, width, vertexFormat: PolylineColorAppearance.VERTEX_FORMAT }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  private addPrimitive(instances: GeometryInstance[]): void {
    if (!instances.length) return;
    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PolylineColorAppearance({ translucent: false }),
      asynchronous: true,
      allowPicking: false,
    });
    this.viewer.scene.primitives.add(primitive);
    this.primitives.push(primitive);
  }
}
