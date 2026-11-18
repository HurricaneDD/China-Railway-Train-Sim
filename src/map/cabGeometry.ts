import {
  BoundingSphere, BoxGeometry, Cartesian3, Color, ColorGeometryInstanceAttribute, ComponentDatatype,
  Geometry, GeometryAttribute, GeometryAttributes, GeometryInstance, Matrix3, Matrix4,
  PerInstanceColorAppearance, PrimitiveType,
} from 'cesium';
import { APP_CONFIG } from '../config';

/** Cab-local metres: X right, Y forward, Z above rail. Eye (-.55, 0, 2.15), glass Y=1. */
export const CAB_LAYOUT = {
  eye: [APP_CONFIG.camera.cabSeatOffset, 0, APP_CONFIG.camera.cabEyeHeight], glassForward: 1,
  screenCenters: [[-0.67, 0.555, 1.92], [-0.43, 0.555, 1.92], [-0.24, 0.555, 1.915]],
  leverPivot: [-0.94, 0.59, 1.91],
} as const;

function box(id: string, position: number[], size: number[], color: string, tilt = 0): GeometryInstance {
  return new GeometryInstance({ id: `cab:${id}`,
    geometry: BoxGeometry.fromDimensions({ dimensions: new Cartesian3(size[0], size[1], size[2]), vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT }),
    modelMatrix: Matrix4.fromRotationTranslation(Matrix3.fromRotationX(tilt), new Cartesian3(position[0], position[1], position[2])),
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color)) },
  });
}

/** Original procedural shell; reference is the seat/glass/desk relationship, not an E235 replica. */
export function cabShellGeometry(): GeometryInstance[] {
  const parts: GeometryInstance[] = [];
  const add = (id: string, p: number[], size: number[], color: string, tilt = 0) => parts.push(box(id, p, size, color, tilt));
  const wall = '#737c7c', dark = '#252e33', rubber = '#101619', desk = '#38464b';
  add('floor', [0, 0, 1.08], [2.9, 2.4, .08], '#273238');
  add('ceiling', [0, 0, 3.29], [2.9, 2.4, .1], wall);
  // Front bulkhead, wide windscreen opening and asymmetric side-wall view from the driver's seat.
  add('front-low', [0, 1.02, 1.49], [2.9, .1, .89], wall);
  add('sill', [0, .97, 1.925], [2.9, .13, .065], rubber);
  add('front-header', [0, 1.02, 3.225], [2.9, .12, .19], dark);
  for (const side of [-1, 1]) {
    add(`a-pillar-${side}`, [side * 1.34, .99, 2.55], [.20, .18, 1.25], dark);
    add(`seal-${side}`, [side * 1.245, .89, 2.55], [.035, .035, 1.25], rubber);
    add(`side-low-${side}`, [side * 1.44, -.05, 1.5], [.1, 2.15, .9], wall);
    add(`side-top-${side}`, [side * 1.44, -.05, 3.12], [.1, 2.15, .28], wall);
    add(`rear-post-${side}`, [side * 1.44, -.8, 2.5], [.1, .18, 1.15], dark);
    add(`side-rail-${side}`, [side * 1.39, -.05, 1.985], [.16, 2.05, .07], dark);
  }
  // Full-width console, physical sloping fascia, and raised instrument binnacle.
  add('desk-base', [0, .74, 1.46], [2.4, .56, .75], dark);
  add('desk-top', [0, .64, 1.835], [2.4, .46, .045], desk, .29);
  add('desk-lip', [0, .40, 1.76], [2.4, .055, .075], '#182126');
  add('screen-housing', [-.55, .63, 1.92], [.55, .12, .18], '#111a20', -.31);
  add('gauge-housing', [-.24, .65, 1.915], [.16, .12, .18], '#141f26', -.31);
  add('controller-base', [-.94, .62, 1.89], [.28, .25, .10], '#1c272d');
  add('controller-track', [-.94, .55, 1.949], [.08, .16, .016], '#070d11');
  add('visor', [-.58, .91, 3.02], [.95, .035, .18], '#263237');
  // An actual wiper resting on the glass, rather than a screen-space decorative stroke.
  add('wiper-arm', [.70, .88, 2.14], [.016, .018, .37], '#182124', .05);
  add('wiper-blade', [.70, .88, 2.32], [.42, .022, .018], '#131c20');
  ['#d2c5a4', '#4d8e76', '#ba6457', '#a6b7ba'].forEach((color, index) => {
    add(`switch-base-${index}`, [.28 + index * .14, .63, 1.91], [.07, .08, .035], rubber);
    add(`switch-cap-${index}`, [.28 + index * .14, .62, 1.94], [.038, .04, .025], color);
  });
  for (let index = 0; index < 9; index++) add(`vent-${index}`, [.68 + index * .035, .79, 1.9], [.012, .10, .008], rubber);
  return parts;
}

export function cabLeverGeometry(): GeometryInstance[] {
  return [box('lever-stem', [0, 0, .09], [.025, .03, .18], '#8a989d'),
    box('lever-grip', [0, 0, .185], [.15, .065, .05], '#131f26')];
}

/** Three raised screen faces share one atlas/material; the third face contains a round speed gauge. */
export function cabDisplayGeometry(): GeometryInstance[] {
  return CAB_LAYOUT.screenCenters.map((center, tile) => {
    const width = tile === 2 ? .13 : .215, height = tile === 2 ? .15 : .135;
    const angle = 18 * Math.PI / 180;
    const vertices: number[] = [];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) vertices.push(
      center[0] + x * width / 2, center[1] + y * height / 2 * Math.sin(angle), center[2] + y * height / 2 * Math.cos(angle),
    );
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(vertices) });
    attributes.normal = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3,
      values: new Float32Array(Array.from({ length: 4 }, () => [0, -Math.cos(angle), Math.sin(angle)]).flat()) });
    attributes.st = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2,
      values: new Float32Array([tile / 3, 0, (tile + 1) / 3, 0, (tile + 1) / 3, 1, tile / 3, 1]) });
    return new GeometryInstance({ id: `cab:display-${tile}`, geometry: new Geometry({ attributes,
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]), primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(vertices) }) });
  });
}
