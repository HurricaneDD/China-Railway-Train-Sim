import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../src/config';
import { cabCameraFov, cabCameraPose, fixedCameraFov, fixedCameraPose, horizontalFovForVertical } from '../src/map/cameraPose';
import { bearing, distance } from '../src/utils/geo';
import { Cartesian3, Matrix4 } from 'cesium';
import { CAB_LAYOUT } from '../src/map/cabGeometry';

describe('驾驶室沿轨平视', () => {
  const head = { lon: 118.8, lat: 32, height: 42 };
  it('眼点位于三维座舱左侧，距玻璃1m，高2.15m', () => {
    const pose = cabCameraPose(head, 90, 0);
    expect(distance(head, pose)).toBeCloseTo(Math.hypot(7, .55), 1);
    expect(pose.altitude - head.height - APP_CONFIG.track.heightOffset).toBeCloseTo(2.15);
    expect(pose.pitch * 180 / Math.PI).toBeCloseTo(-3.814, 2);
    const local = Matrix4.multiplyByPoint(Matrix4.inverseTransformation(pose.frame, new Matrix4()), pose.position, new Cartesian3());
    expect(local.x).toBeCloseTo(CAB_LAYOUT.eye[0], 6);
    expect(local.y).toBeCloseTo(0, 6);
    expect(local.z).toBeCloseTo(CAB_LAYOUT.eye[2], 6);
    expect(CAB_LAYOUT.glassForward - local.y).toBeCloseTo(1, 6);
  });
  it('坡道时眼点和视线都沿车体前向的轨面变化', () => {
    const pose = cabCameraPose(head, 90, 0.03);
    expect(pose.altitude).toBeCloseTo(cabCameraPose(head, 90, 0).altitude + 7 * 0.03, 2);
    expect(pose.pitch).toBeCloseTo(Math.atan(0.03) + APP_CONFIG.camera.cabPitch);
  });
  it('按参考的55度竖直FOV构图，宽屏可同时看见窗外和仪表台', () => {
    const fov = cabCameraFov(1440, 900);
    expect(2 * Math.atan(Math.tan(fov / 2) / (1440 / 900)) * 180 / Math.PI).toBeCloseTo(55);
    expect(cabCameraFov(390, 616) * 180 / Math.PI).toBeCloseTo(55);
  });
  it('任意航向、坡道下相机与座舱共用一个正交坐标系，转弯不会漂移', () => {
    for (const heading of [0, 90, 179, 270, 359]) for (const grade of [-.04, 0, .04]) {
      const pose = cabCameraPose(head, heading, grade);
      const inverse = Matrix4.inverseTransformation(pose.frame, new Matrix4());
      const local = Matrix4.multiplyByPoint(inverse, pose.position, new Cartesian3());
      expect(local.x).toBeCloseTo(-.55, 6);
      expect(local.z).toBeCloseTo(2.15, 6);
      expect(Cartesian3.dot(pose.direction, pose.up)).toBeCloseTo(0, 12);
      expect(Cartesian3.magnitude(pose.direction)).toBeCloseTo(1, 12);
      const forward = Matrix4.multiplyByPointAsVector(inverse, pose.direction, new Cartesian3());
      expect(forward.x).toBeCloseTo(0, 12);
      expect(forward.y).toBeGreaterThan(.99);
    }
  });
});

describe('第三人称固定视角', () => {
  const head = { lon: 118.8, lat: 32, height: 42 };

  it('位于车头后上方 30°、高 200 m', () => {
    const pose = fixedCameraPose(head, 90);
    expect(pose.altitude).toBeCloseTo(242, 9);
    const horizontal = distance(head, pose);
    // offsetPoint 使用局部米制近似，允许 1 m 内的投影误差。
    expect(Math.abs(horizontal - 200 / Math.tan(Math.PI / 6))).toBeLessThan(1);
    expect(Math.atan2(200, horizontal) * 180 / Math.PI).toBeCloseTo(30, 1);
    expect(bearing(head, pose)).toBeCloseTo(270, 2);
  });

  it('朝向与车头一致，俯角固定为向下 10°', () => {
    const pose = fixedCameraPose(head, 37);
    expect(pose.heading).toBe(37);
    expect(pose.pitch).toBeCloseTo(-Math.PI / 18, 10);
    expect(APP_CONFIG.camera.fixedView.height).toBe(200);
    expect(APP_CONFIG.camera.fixedView.elevationDegrees).toBe(30);
  });

  it('正北车头时相机位于正南', () => {
    const pose = fixedCameraPose(head, 0);
    expect(bearing(head, pose)).toBeCloseTo(180, 2);
  });

  it('固定视角的竖直视场覆盖车头在视轴下方的 20°', () => {
    const fov = fixedCameraFov(1440, 900);
    const fovy = 2 * Math.atan(Math.tan(fov / 2) / (1440 / 900));
    expect(fovy * 180 / Math.PI).toBeCloseTo(50, 6);
    expect(fovy / 2).toBeGreaterThan((30 - 10) * Math.PI / 180);
  });

  it('竖屏时 Cesium fov 直接作为竖直视场', () => {
    expect(horizontalFovForVertical(0.8, 0.5)).toBeCloseTo(0.8, 12);
    expect(horizontalFovForVertical(0.8, 2)).toBeGreaterThan(0.8);
  });
});
