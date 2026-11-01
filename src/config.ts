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
  track: {
    gauge: 1.435,
    sleeperSpacing: 12,
    sleeperLength: 2.6,
    heightOffset: 1.2,
    elevationSampleSpacing: 120,
  },
  train: {
    locomotive: { length: 20, width: 3.1, height: 4.1, mass: 138_000 },
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
  },
  simulation: {
    fixedStep: 1 / 60,
    maxFrameDelta: 0.1,
    junctionPreviewDistance: 120,
    junctionStopDistance: 35,
    routeHistoryLength: 2500,
    autosaveSeconds: 30,
  },
  camera: {
    cabEyeHeight: 3.2,
    cabForwardOffset: 7,
    cabPitch: -0.07,
    cabHeadingSmoothing: 6,
    heading: 0,
    pitch: -0.42,
    range: 150,
    minRange: 35,
    maxRange: 900,
    smoothing: 5,
  },
} as const;

export interface GameSettings {
  sound: boolean;
  autosave: boolean;
  cameraRange: number;
  renderRadius: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  sound: true,
  autosave: true,
  cameraRange: APP_CONFIG.camera.range,
  renderRadius: APP_CONFIG.data.renderRadius,
};
