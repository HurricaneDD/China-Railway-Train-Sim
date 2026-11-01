import { CallbackPositionProperty, CallbackProperty, Cartesian3, Color, HeadingPitchRoll, ReferenceFrame, Transforms, type Entity, type Quaternion, type Viewer } from 'cesium';
import { APP_CONFIG } from '../config';
import type { RoutePoint } from '../types';

export class TrainRenderer {
  private entities: Entity[] = [];
  private positions: Cartesian3[] = [];
  private orientations: Quaternion[] = [];
  private visible = false;

  constructor(private viewer: Viewer) {
    const vehicles = [APP_CONFIG.train.locomotive, ...APP_CONFIG.train.cars];
    vehicles.forEach((vehicle, index) => {
      this.positions.push(Cartesian3.fromDegrees(116.4, 39.9, -1000));
      this.orientations.push(Transforms.headingPitchRollQuaternion(this.positions[index], new HeadingPitchRoll()));
      const entity = viewer.entities.add({
        position: new CallbackPositionProperty(() => this.positions[index], false, ReferenceFrame.FIXED),
        orientation: new CallbackProperty(() => this.orientations[index], false),
        box: {
          dimensions: new Cartesian3(vehicle.width, vehicle.length, vehicle.height),
          material: index === 0 ? Color.fromCssColorString('#b9e3b0') : Color.fromCssColorString('#315b45'),
          outline: true,
          outlineColor: Color.fromCssColorString('#15251c'),
        },
        show: false,
      });
      this.entities.push(entity);
    });
  }

  update(points: RoutePoint[]): void {
    this.visible = points.length > 0;
    const vehicles = [APP_CONFIG.train.locomotive, ...APP_CONFIG.train.cars];
    points.forEach((point, index) => {
      const height = point.height + APP_CONFIG.track.heightOffset + vehicles[index].height / 2;
      this.positions[index] = Cartesian3.fromDegrees(point.lon, point.lat, height);
      const heading = (point.heading - 90) * Math.PI / 180;
      this.orientations[index] = Transforms.headingPitchRollQuaternion(this.positions[index], new HeadingPitchRoll(heading, 0, 0));
    });
    this.entities.forEach((entity, index) => { entity.show = this.visible && index < points.length; });
  }
}
