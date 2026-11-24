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

export type FixedCameraSide = 'rear' | 'front';

export interface FixedCameraView {
  /** Relative altitude of the camera above the train head. */
  height: number;
  /** View heading offset from the train heading. It must not move the camera. */
  yaw: number;
  /** View pitch in degrees. It must not move the camera. */
  pitch: number;
}

export function defaultFixedCameraView(side: FixedCameraSide = 'rear'): FixedCameraView {
  return {
    height: APP_CONFIG.camera.fixedView.height,
    yaw: side === 'front' ? 180 : 0,
    pitch: APP_CONFIG.camera.fixedView.pitchDegrees,
  };
}

/**
 * Drag rotates the camera in place: it changes only the viewing direction.
 * The horizontal/vertical signs are intentionally opposite to the previous
 * orbit-style logic: dragging right looks right, dragging down looks down.
 */
export function rotateFixedCamera(view: FixedCameraView, dx: number, dy: number): void {
  const sensitivity = APP_CONFIG.camera.fixedView.dragDegreesPerPixel;
  view.yaw = ((view.yaw + dx * sensitivity) % 360 + 360) % 360;
  view.pitch = Math.max(-65, Math.min(10, view.pitch - dy * sensitivity));
}

/**
 * Wheel zoom changes the camera height and, through `fixedCameraPose`, its
 * longitudinal distance; it never changes the viewing direction.
 * Cesium wheel delta is positive toward the user (zoom in).
 */
export function zoomFixedCamera(view: FixedCameraView, delta: number): void {
  const config = APP_CONFIG.camera.fixedView;
  view.height = Math.max(config.minHeight, Math.min(config.maxHeight,
    view.height * Math.exp(-delta * config.zoomSensitivity)));
}

/**
 * Touch pinch zoom uses the same height/position model as the wheel:
 * fingers moving apart (scale > 1) lower the camera, fingers together raise it.
 * The viewing direction is untouched.
 */
export function zoomFixedCameraByScale(view: FixedCameraView, scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) return;
  const config = APP_CONFIG.camera.fixedView;
  view.height = Math.max(config.minHeight, Math.min(config.maxHeight, view.height / scale));
}

/**
 * The camera position is determined only by the train head, the side and the
 * wheel-controlled height. 'rear' sits at the configured 30° elevation behind
 * the train; 'front' is its mirror image ahead of the train. View yaw/pitch
 * rotate the camera in place, so dragging never moves it.
 */
export function fixedCameraPose(head: LonLat & { height: number }, trainHeading: number,
  view?: FixedCameraView, side: FixedCameraSide = 'rear'): FixedCameraPose {
  const state = view ?? defaultFixedCameraView(side);
  const config = APP_CONFIG.camera.fixedView;
  const elevation = config.elevationDegrees * Math.PI / 180;
  const horizontal = state.height / Math.tan(elevation);
  const heading = ((trainHeading + state.yaw) % 360 + 360) % 360;
  // The position uses the train heading, never the view yaw.
  // offsetPoint uses east=0°, unlike Cesium's north=0°. -90 is ahead, +90 behind.
  const position = offsetPoint(head, side === 'front' ? trainHeading - 90 : trainHeading + 90, horizontal);
  return {
    lon: position.lon,
    lat: position.lat,
    altitude: head.height + state.height,
    heading,
    pitch: state.pitch * Math.PI / 180,
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
