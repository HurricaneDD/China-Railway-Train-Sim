import { APP_CONFIG } from '../config';
import type { LonLat } from '../types';
import { offsetPoint } from '../utils/geo';

export interface FixedCameraPose {
  lon: number;
  lat: number;
  altitude: number;
  heading: number;
  pitch: number;
}

/**
 * 计算“第三人称固定”视角的相机位置与朝向。
 *
 * 相机位于车头正后方，与车头的连线相对水平面为 30° 仰角，并高于车头 200 m；
 * 因此水平后移距离为 200 / tan(30°) ≈ 346.4 m。相机朝向与车头一致，
 * 俯角固定为 10°（Cesium 中负 pitch 表示向下看）。
 */
export function fixedCameraPose(head: LonLat & { height: number }, trainHeading: number): FixedCameraPose {
  const { elevationDegrees, height, pitchDegrees } = APP_CONFIG.camera.fixedView;
  const elevation = elevationDegrees * Math.PI / 180;
  const behind = height / Math.tan(elevation);
  // offsetPoint 的 heading 与 Cesium 相同（正北为 0°、顺时针）；heading + 90 表示车尾方向。
  const position = offsetPoint(head, trainHeading + 90, behind);
  return {
    lon: position.lon,
    lat: position.lat,
    altitude: head.height + height,
    heading: trainHeading,
    pitch: pitchDegrees * Math.PI / 180,
  };
}

/**
 * 由竖直视场和画布宽高比求 Cesium PerspectiveFrustum 的 fov（横向）。
 *
 * Cesium 的 `frustum.fov` 在画布宽高比 > 1 时表示横向视场，否则表示竖直视场。
 * 固定视角需要稳定的竖直取景，避免宽屏或超宽屏把列车裁出下边缘。
 */
export function horizontalFovForVertical(verticalFov: number, aspectRatio: number): number {
  if (!(aspectRatio > 1)) return verticalFov;
  return 2 * Math.atan(Math.tan(verticalFov / 2) * aspectRatio);
}

/** 固定视角所需的 Cesium 横向 fov；按当前画布尺寸计算。 */
export function fixedCameraFov(width: number, height: number): number {
  const vertical = APP_CONFIG.camera.fixedView.verticalFovDegrees * Math.PI / 180;
  return horizontalFovForVertical(vertical, width / Math.max(1, height));
}
