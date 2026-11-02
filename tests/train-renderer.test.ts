import { Cartesian3, EntityCollection, JulianDate, Matrix3, Matrix4, Transforms, type Viewer } from 'cesium';
import { expect, it } from 'vitest';
import { TrainRenderer } from '../src/map/TrainRenderer';

it('机车为20×3.3×4.7米，长轴在各航向均平行铁轨', () => {
  const entities = new EntityCollection();
  const renderer = new TrainRenderer({ entities } as Viewer);
  const time = JulianDate.now();
  for (const heading of [0, 45, 90, 180, 270]) {
    renderer.update([{ lon: 118.8, lat: 32, height: 20, heading, travelled: 0 }]);
    const locomotive = entities.values[0];
    expect(locomotive.box!.dimensions!.getValue(time)).toEqual(new Cartesian3(20, 3.3, 4.7));
    const rotation = Matrix3.fromQuaternion(locomotive.orientation!.getValue(time)!);
    const longAxis = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_X, new Cartesian3());
    const angle = heading * Math.PI / 180;
    const expected = Matrix4.multiplyByPointAsVector(
      Transforms.eastNorthUpToFixedFrame(locomotive.position!.getValue(time)!),
      new Cartesian3(Math.sin(angle), Math.cos(angle), 0), new Cartesian3(),
    );
    expect(Cartesian3.dot(longAxis, expected)).toBeCloseTo(1, 10);
  }
});
