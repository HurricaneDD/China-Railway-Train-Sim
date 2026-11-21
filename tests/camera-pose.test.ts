import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../src/config';
import { cabCameraFov, cabCameraPose, defaultFixedCameraView, fixedCameraFov, fixedCameraPose, horizontalFovForVertical, rotateFixedCamera, zoomFixedCamera, zoomFixedCameraByScale } from '../src/map/cameraPose';
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

  it('位于车头后上方 30°、高 150 m', () => {
    const pose = fixedCameraPose(head, 90);
    expect(pose.altitude).toBeCloseTo(192, 9);
    const horizontal = distance(head, pose);
    // offsetPoint 使用局部米制近似，允许 1 m 内的投影误差。
    expect(Math.abs(horizontal - 150 / Math.tan(Math.PI / 6))).toBeLessThan(1);
    expect(Math.atan2(150, horizontal) * 180 / Math.PI).toBeCloseTo(30, 1);
    expect(bearing(head, pose)).toBeCloseTo(270, 2);
  });

  it('朝向与车头一致，俯角固定为向下 10°', () => {
    const pose = fixedCameraPose(head, 37);
    expect(pose.heading).toBe(37);
    expect(pose.pitch).toBeCloseTo(-Math.PI / 18, 10);
    expect(APP_CONFIG.camera.fixedView.height).toBe(150);
    expect(APP_CONFIG.camera.fixedView.elevationDegrees).toBe(30);
  });

  it('正北车头时相机位于正南', () => {
    const pose = fixedCameraPose(head, 0);
    expect(bearing(head, pose)).toBeCloseTo(180, 2);
  });

  it('拖动只改变镜头朝向，不改变相机位置，且拖动方向相反', () => {
    const view = defaultFixedCameraView();
    const base = fixedCameraPose(head, 90, view);
    rotateFixedCamera(view, 100, 100);
    const turned = fixedCameraPose(head, 90, view);
    expect(turned.lon).toBe(base.lon);
    expect(turned.lat).toBe(base.lat);
    expect(turned.altitude).toBe(base.altitude);
    expect(view.yaw).toBeCloseTo(20);
    expect(turned.heading).toBeCloseTo(110); // 向右拖动看右
    expect(turned.pitch * 180 / Math.PI).toBeCloseTo(-30); // 向下拖动看下
    // 相机仍在车头正后方、保持30°仰角，只是朝向改变。
    expect(bearing(head, turned)).toBeCloseTo(270, 2);
    expect(Math.atan2(turned.altitude - head.height, distance(head, turned)) * 180 / Math.PI).toBeCloseTo(30, 1);

    const reverse = defaultFixedCameraView();
    rotateFixedCamera(reverse, -100, -100);
    expect(reverse.yaw).toBeCloseTo(340);
    expect(reverse.pitch).toBeCloseTo(10);
    expect(fixedCameraPose(head, 90, reverse).heading).toBeCloseTo(70);

    rotateFixedCamera(view, 100000, 100000);
    expect(view.pitch).toBe(-65);
    rotateFixedCamera(view, 0, -100000);
    expect(view.pitch).toBe(10);
    expect(view.yaw).toBeGreaterThanOrEqual(0);
    expect(view.yaw).toBeLessThan(360);
  });

  it('滚轮只改变高度和位置，不改变镜头朝向', () => {
    const view = defaultFixedCameraView();
    const base = fixedCameraPose(head, 37, view);
    zoomFixedCamera(view, 120);
    expect(view.height).toBeLessThan(150);
    const zoomed = fixedCameraPose(head, 37, view);
    expect(zoomed.altitude - head.height).toBeCloseTo(view.height);
    expect(zoomed.heading).toBe(37);
    expect(zoomed.pitch).toBeCloseTo(-Math.PI / 18);
    expect(distance(base, zoomed)).toBeGreaterThan(1);
    expect(bearing(head, zoomed)).toBeCloseTo(217, 0);
    expect(Math.abs(distance(head, zoomed) - view.height / Math.tan(Math.PI / 6))).toBeLessThan(1.5);
    expect(Math.atan2(view.height, distance(head, zoomed)) * 180 / Math.PI).toBeCloseTo(30, 0);
    zoomFixedCamera(view, -120);
    expect(view.height).toBeCloseTo(150);
    zoomFixedCamera(view, -100000);
    expect(view.height).toBe(1500);
    zoomFixedCamera(view, 100000);
    expect(view.height).toBe(20);
    expect(defaultFixedCameraView()).toEqual({ height: 150, yaw: 0, pitch: -10 });
  });

  it('双指捏合按比例改变高度和位置，不改变镜头朝向', () => {
    const view = defaultFixedCameraView();
    const base = fixedCameraPose(head, 37, view);
    zoomFixedCameraByScale(view, 2);
    expect(view.height).toBeCloseTo(75);
    const zoomed = fixedCameraPose(head, 37, view);
    expect(zoomed.altitude - head.height).toBeCloseTo(75);
    expect(zoomed.heading).toBe(37);
    expect(zoomed.pitch).toBeCloseTo(-Math.PI / 18);
    expect(distance(base, zoomed)).toBeGreaterThan(1);
    expect(Math.atan2(75, distance(head, zoomed)) * 180 / Math.PI).toBeCloseTo(30, 0);
    zoomFixedCameraByScale(view, 0.5);
    expect(view.height).toBeCloseTo(150);
    zoomFixedCameraByScale(view, 0);
    expect(view.height).toBeCloseTo(150);
    zoomFixedCameraByScale(view, -2);
    expect(view.height).toBeCloseTo(150);
    zoomFixedCameraByScale(view, 1000);
    expect(view.height).toBe(20);
    zoomFixedCameraByScale(view, 0.001);
    expect(view.height).toBe(1500);
    expect(view.yaw).toBe(0);
    expect(view.pitch).toBe(-10);
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
