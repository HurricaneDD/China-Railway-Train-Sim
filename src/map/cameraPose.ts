import { APP_CONFIG } from '../config';
import type { LonLat } from '../types';
import { offsetPoint } from '../utils/geo';
import { Cartesian3, Cartographic, Matrix3, Matrix4, Transforms } from 'cesium';

export interface FixedCameraPose {
  lon: number;
  lat: number;
  altitude: number;
  heading: number;
  pitch: number;
}

/** Driver's eye follows the rail profile, never the terrain's highest visible surface. */
export interface CabCameraPose extends FixedCameraPose {
  frame: Matrix4;
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
}

export function cabCameraPose(head: LonLat & { height: number }, heading: number, grade: number): CabCameraPose {
  const forward = APP_CONFIG.camera.cabForwardOffset;
  const slope = Number.isFinite(grade) ? grade : 0;
  const origin = offsetPoint(head, heading - 90, forward);
  const world = Cartesian3.fromDegrees(origin.lon, origin.lat, head.height + APP_CONFIG.track.heightOffset + slope * forward);
  const rotation = Matrix3.multiply(Matrix3.fromRotationZ(-heading * Math.PI / 180), Matrix3.fromRotationX(Math.atan(slope)), new Matrix3());
  const frame = Matrix4.multiply(Transforms.eastNorthUpToFixedFrame(world), Matrix4.fromRotationTranslation(rotation), new Matrix4());
  const position = Matrix4.multiplyByPoint(frame, new Cartesian3(APP_CONFIG.camera.cabSeatOffset, 0, APP_CONFIG.camera.cabEyeHeight), new Cartesian3());
  const pitch = APP_CONFIG.camera.cabPitch;
  const direction = Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, Math.cos(pitch), Math.sin(pitch)), new Cartesian3());
  const up = Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, -Math.sin(pitch), Math.cos(pitch)), new Cartesian3());
  const eye = Cartographic.fromCartesian(position);
  return { lon: eye.longitude * 180 / Math.PI, lat: eye.latitude * 180 / Math.PI, altitude: eye.height,
    heading, pitch: Math.atan(slope) + pitch, frame, position, direction, up };
}

/** Reference uses 55 degrees VERTICAL; a horizontal 55-degree lens would crop the cab away. */
export function cabCameraFov(width: number, height: number): number {
  const aspect = width / Math.max(1, height);
  const vertical = APP_CONFIG.camera.cabVerticalFovDegrees * Math.PI / 180;
  return horizontalFovForVertical(vertical, aspect);
}

export interface FixedCameraView {
  height: number;
  yaw: number;
  pitch: number;
}

export function defaultFixedCameraView(): FixedCameraView {
  return { height: APP_CONFIG.camera.fixedView.height, yaw: 0, pitch: APP_CONFIG.camera.fixedView.pitchDegrees };
}

/** Orbit around the train while retaining its initial position below the optical axis. */
export function rotateFixedCamera(view: FixedCameraView, dx: number, dy: number): void {
  const sensitivity = APP_CONFIG.camera.fixedView.dragDegreesPerPixel;
  view.yaw = ((view.yaw - dx * sensitivity) % 360 + 360) % 360;
  view.pitch = Math.max(-65, Math.min(10, view.pitch + dy * sensitivity));
}

/** Cesium wheel delta is positive toward the user (zoom in). */
export function zoomFixedCamera(view: FixedCameraView, delta: number): void {
  const config = APP_CONFIG.camera.fixedView;
  view.height = Math.max(config.minHeight, Math.min(config.maxHeight,
    view.height * Math.exp(-delta * config.zoomSensitivity)));
}

/** Defaults preserve the original 30° elevation, -10° pitch and 50° vertical lens. */
export function fixedCameraPose(head: LonLat & { height: number }, trainHeading: number,
  view: FixedCameraView = defaultFixedCameraView()): FixedCameraPose {
  const config = APP_CONFIG.camera.fixedView;
  const elevation = (config.elevationDegrees + config.pitchDegrees - view.pitch) * Math.PI / 180;
  const behind = view.height / Math.tan(elevation);
  const heading = trainHeading + view.yaw;
  // offsetPoint uses east=0°, unlike Cesium's north=0°.
  const position = offsetPoint(head, heading + 90, behind);
  return {
    lon: position.lon,
    lat: position.lat,
    altitude: head.height + view.height,
    heading,
    pitch: view.pitch * Math.PI / 180,
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
