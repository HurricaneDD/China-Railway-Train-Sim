import { DEFAULT_MAP_TILES, type MapTileId } from './map/basemap';

export const APP_CONFIG = {
  cesiumIonToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlNzJjNDgxMS0wNGIxLTQwMmYtODYzMy03ODQ3Njg4Y2FlYzQiLCJpZCI6Mzk3MjkzLCJpYXQiOjE3NzI1NDc1NDN9.MTjRT7M805SQ81Q0dNgYhenCD-I4SOl3nAbFJOz0Dpg',
  data: {
    stationSnapDistance: 2500,
    mapSnapDistance: 5000,
    endpointTolerance: 2,
    spatialCellSize: 0.025,
    maxCachedProvinces: 4,
    renderRadius: 6500,
    maxRenderSegments: 900,
  },
  stationDeparture: {
    /** Nearby original segments offered as selectable starting lines. */
    radius: 1500,
    /** Displayed length of each line around the station, in both directions. */
    windowMeters: 900,
    maxLines: 240,
  },
  stationLabels: {
    /**
     * 驾驶时只在列车周围这个半径内创建车站实体。它是“渲染距离”，
     * 限制 Cesium 实体和图元数量；真正的站名显示距离更短。
     */
    renderDistance: 20_000,
    /** 站名和圆点离镜头超过此距离后完全隐藏；只影响显示，不删除周边实体池。 */
    displayDistance: 14_000,
    /** 列车移动超过此距离才重新计算周边车站，避免 50× 下频繁增删实体。 */
    refreshDistance: 2_000,
    /** 周边实体上限，防止大型枢纽一次创建过多车站。 */
    maxDrivingStations: 120,
    /** 同屏站名上限；重叠时按优先级只保留可读的标签。 */
    maxVisibleLabels: 60,
    /** 标签防重叠重算间隔，单位毫秒。 */
    labelUpdateIntervalMs: 200,
    fontSize: 16,
    labelHeight: 26,
    labelOffsetY: 12,
    /** 站点显示高度（米，相对地形表面）；同时供标签屏幕投影使用。 */
    markerHeight: 30,
  },
  track: {
    gauge: 1.435,
    sleeperSpacing: 12,
    sleeperLength: 2.6,
    heightOffset: 1.2,
    elevationSampleSpacing: 120,
  },
  scenery: {
    chunkLength: 250,
    radius: 1100,
    refreshDistance: 120,
    maxChunks: 48,
    sleeperSpacing: 0.72,
    sampleSpacing: 8,
    retryMs: 5000,
  },
  train: {
    locomotive: { length: 20, width: 3.3, height: 4.7, mass: 138_000 },
    cars: [
      { length: 25, width: 3.1, height: 3.8, mass: 52_000 },
      { length: 25, width: 3.1, height: 3.8, mass: 52_000 },
      { length: 25, width: 3.1, height: 3.8, mass: 52_000 },
      { length: 25, width: 3.1, height: 3.8, mass: 52_000 },
    ],
    couplingGap: 1.5,
    maxTractionForce: 320_000,
    tractionFadeSpeed: 12,
    maxBrakeForce: 520_000,
    resistance: { a: 5_200, b: 155, c: 8.2 },
    baseAdhesion: 0.2,
    sandAdhesionBonus: 0.12,
    sandDuration: 8,
    throttleStep: 1,
    keyRepeatMs: 55,
    brakeApplySeconds: 4,
    brakeReleaseSeconds: 4,
    reverseThresholdKmh: 0.5,
    steepGradeAssist: {
      enabled: true,
      minSlope: 0.06,
      minThrottle: 80,
      maxBrakeActual: 0.1,
      activationSpeedKmh: 8,
      taperStartKmh: 12,
      crawlSpeedKmh: 15,
      targetAcceleration: 0.15,
      // 4,000 kN 高于当前 346 t 编组的整列重力（约 3.39 MN），因此坡道力本身
      // 永远不会先撞上这个上限；它仍作为异常输入时的数值保护。
      maxTotalForce: 4_000_000,
      exitSeconds: 1,
    },
  },
  simulation: {
    fixedStep: 1 / 60,
    maxFrameDelta: 0.1,
    speedOptions: [1, 5, 10, 20, 30, 50],
    maxStepsPerFrame: 300,
    junctionPreviewDistance: 120,
    junctionStopDistance: 35,
    junctionMaxTurnDegrees: 150,
    junctionTransitionMaxTurnDegrees: 35,
    junctionTransitionMaxGap: 0.25,
    junctionExactMaxGap: 0.01,
    junctionInteriorMaxGap: 0.01,
    junctionPathPreviewMeters: 2000,
    junctionPathMaxBoundaries: 80,
    junctionContextRadius: 2000,
    junctionContextMaxSegments: 320,
    junctionApproachMeters: 500,
    routeHistoryLength: 2500,
    autosaveSeconds: 30,
  },
  camera: {
    cabEyeHeight: 2.15,
    cabSeatOffset: -0.55,
    cabForwardOffset: 7,
    cabPitch: -Math.atan(4 / 60),
    cabVerticalFovDegrees: 55,
    cabNear: 0.15,
    cabHeadingSmoothing: 6,
    heading: 0,
    pitch: -0.42,
    range: 150,
    minRange: 35,
    maxRange: 900,
    smoothing: 5,
    // “第三人称固定”：默认后上方 30°、高于车头 150 m、俯角 -10°。
    // 左键/单指拖动只转动镜头朝向，不移动相机；滚轮/双指捏合调整相对车头高度并同步改变位置。
    // 车头位于视轴下方 20°，因此该视角使用 50° 竖直视场，避免列车落到画面外。
    fixedView: {
      elevationDegrees: 30,
      height: 150,
      minHeight: 20,
      maxHeight: 1500,
      dragDegreesPerPixel: 0.2,
      zoomSensitivity: 0.0015,
      pitchDegrees: -10,
      verticalFovDegrees: 50,
    },
  },
} as const;

export type SimulationSpeed = (typeof APP_CONFIG.simulation.speedOptions)[number];

export interface GameSettings {
  sound: boolean;
  autosave: boolean;
  cameraRange: number;
  renderRadius: number;
  mapTiles: MapTileId;
}

export const DEFAULT_SETTINGS: GameSettings = {
  sound: true,
  autosave: true,
  cameraRange: APP_CONFIG.camera.range,
  renderRadius: APP_CONFIG.data.renderRadius,
  mapTiles: DEFAULT_MAP_TILES,
};
