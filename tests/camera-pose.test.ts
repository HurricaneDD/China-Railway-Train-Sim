import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../src/config';
import { fixedCameraFov, fixedCameraPose, horizontalFovForVertical } from '../src/map/cameraPose';
import { bearing, distance } from '../src/utils/geo';

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
