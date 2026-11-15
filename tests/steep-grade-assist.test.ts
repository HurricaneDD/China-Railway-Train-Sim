import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../src/config';
import { initialSteepGradeAssistState, initialTrainState, stepDynamics, totalMass } from '../src/core/dynamics';

const dt = APP_CONFIG.simulation.fixedStep;
function fixture(direction: 1 | -1 = 1, velocity = 0) {
  const train = initialTrainState();
  train.throttle = 100;
  train.reverser = direction;
  train.velocity = velocity;
  const assist = initialSteepGradeAssistState();
  const tick = (slope = 0.18 * direction, brake = false) => stepDynamics(train, dt, slope, brake, assist);
  const run = (seconds: number, slope = 0.18 * direction) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) tick(slope);
  };
  return { train, assist, tick, run };
}

describe('默认陡坡牵引辅助：确定性 60 Hz 合成工况', () => {
  it('180‰ 无砂起步，跨过 8 km/h 后持续辅助，300秒稳定在15 km/h', () => {
    const { train, assist, tick, run } = fixture();
    expect(totalMass()).toBe(346_000);
    tick();
    expect(assist.active).toBe(true);
    expect(train.tractionForce).toBeGreaterThan(650_000);
    expect(train.tractionForce).toBeLessThan(660_000);
    expect(train.acceleration).toBeCloseTo(0.15, 1);
    expect(train.velocity).toBeGreaterThan(0);
    const startupForce = train.tractionForce;
    run(10 - dt);
    expect(train.velocity * 3.6).toBeCloseTo(5.4, 1);
    const at10 = train.velocity * 3.6;
    run(20);
    expect(train.velocity * 3.6).toBeGreaterThan(12);
    expect(assist.force).toBeGreaterThan(0);
    run(270);
    expect(train.velocity * 3.6).toBeCloseTo(15, 5);
    expect(train.acceleration).toBeCloseTo(0, 8);
    expect(train.sandRemaining).toBe(0);
    console.info('180‰ start', { startupForce, kmhAt10s: at10, kmhAt300s: train.velocity * 3.6, crawlForce: train.tractionForce });
  });

  it.each([1, -1] as const)('180‰ 倒滑 -2km/h 恢复，换向器=%s', direction => {
    const { train, assist, tick, run } = fixture(direction, -direction * 2 / 3.6);
    let recoverySeconds = 0;
    let previous = train.velocity * direction;
    while (train.velocity * direction <= 0 && recoverySeconds < 10) {
      tick();
      expect(train.tractionForce * direction).toBeGreaterThan(0);
      expect(train.velocity * direction).toBeGreaterThan(previous);
      previous = train.velocity * direction;
      recoverySeconds += dt;
    }
    expect(recoverySeconds).toBeLessThan(4);
    expect(train.velocity * direction).toBeGreaterThan(0);
    run(300 - recoverySeconds);
    expect(train.velocity * direction * 3.6).toBeCloseTo(15, 5);
    expect(assist.active).toBe(true);
    console.info('180‰ rollback', { direction, recoverySeconds, kmhAt300s: train.velocity * direction * 3.6 });
  });

  it('从全制动释放的既有四秒过程后自动介入，保留制动释放公式', () => {
    const { train, assist, tick, run } = fixture();
    train.brakeCommand = train.brakeActual = 100;
    for (let i = 0; i < 239; i++) {
      tick();
      expect(assist.force).toBe(0);
    }
    tick();
    expect(train.brakeActual).toBeCloseTo(0);
    expect(assist.force).toBeGreaterThan(0);
    run(300);
    expect(train.velocity * 3.6).toBeCloseTo(15, 5);
  });

  it('随坡度缺口减力，坡顶立即停补力，1秒后解除锁定', () => {
    const { train, assist, tick, run } = fixture();
    run(300);
    let previous = assist.force;
    for (const slope of [0.16, 0.14, 0.12, 0.10, 0.08]) {
      tick(slope);
      expect(assist.force).toBeLessThan(previous);
      previous = assist.force;
    }
    const before = train.velocity;
    const unassistedAtCrest = { ...train };
    stepDynamics(unassistedAtCrest, dt, 0, false);
    tick(0);
    const firstStepDeltaKmh = (train.velocity - before) * 3.6;
    expect(assist.force).toBe(0);
    expect(train.tractionForce).toBeCloseTo(138_000 * 9.80665 * 0.2);
    expect(train.velocity - before).toBeLessThan(0.013);
    expect(train).toEqual(unassistedAtCrest);
    expect(assist.active).toBe(true);
    run(1 - 2 * dt, 0);
    expect(assist.active).toBe(true);
    tick(0);
    expect(assist.active).toBe(false);
    console.info('crest', { firstStepDeltaKmh, exitSeconds: 1 });
  });

  it.each(['throttle', 'brake', 'neutral', 'reverse', 'residualBrake'] as const)('%s 在下一步撤销补力', input => {
    const { train, assist, tick } = fixture();
    tick();
    expect(assist.force).toBeGreaterThan(0);
    if (input === 'throttle') train.throttle = 79.99;
    if (input === 'neutral') train.reverser = 0;
    if (input === 'reverse') train.reverser = -1;
    if (input === 'residualBrake') train.brakeCommand = train.brakeActual = 10;
    tick(0.18, input === 'brake');
    expect(assist).toEqual(initialSteepGradeAssistState());
    expect(Math.abs(train.tractionForce)).toBeLessThanOrEqual(320_000);
  });

  it('80%授权但正常牵引足够时不触发；8km/h只限制启动', () => {
    const boundary = fixture();
    // 80% requests 256kN, enough at 60‰ with the default consist.
    boundary.train.throttle = 80;
    boundary.tick(0.06);
    expect(boundary.assist.active).toBe(false);
    // At 8km/h the 180‰ case must not engage; just below it must.
    boundary.train.velocity = 8 / 3.6;
    boundary.tick();
    expect(boundary.assist.active).toBe(false);
    boundary.train.velocity = 7.99 / 3.6;
    boundary.tick();
    expect(boundary.assist.active).toBe(true);
  });

  it('辅助总力封顶750kN，无法保证任意陡坡均可起步', () => {
    const { train, assist, tick } = fixture();
    tick(0.3);
    expect(train.tractionForce).toBe(750_000);
    expect(assist.force).toBeGreaterThan(0);
    expect(train.acceleration).toBeLessThan(0);
  });

  it('手动撒砂保持原计时和常规上限，辅助按剩余缺口补力', () => {
    const dry = fixture(), sanded = fixture();
    sanded.train.sandRemaining = 8;
    dry.tick(); sanded.tick();
    expect(sanded.train.sandRemaining).toBeCloseTo(8 - dt);
    expect(sanded.train.tractionForce).toBeCloseTo(dry.train.tractionForce);
    expect(dry.assist.force - sanded.assist.force).toBeCloseTo(320_000 - 138_000 * 9.80665 * 0.2);
    sanded.train.throttle = 79;
    sanded.tick();
    expect(sanded.assist.force).toBe(0);
    expect(sanded.train.tractionForce).toBe(0.79 * 320_000);
    expect(sanded.train.sandRemaining).toBeCloseTo(8 - 2 * dt);
  });

  it.each([
    { slope: 0, throttle: 100, brake: false },
    { slope: 0.035, throttle: 100, brake: false },
    { slope: -0.18, throttle: 100, brake: false },
    { slope: 0.0599, throttle: 100, brake: false },
    { slope: 0.18, throttle: 79, brake: false },
    { slope: 0.18, throttle: 100, brake: true },
    { slope: 0.07, throttle: 100, brake: false },
  ])('常规工况逐步与原公式完全一致：%j', ({ slope, throttle, brake }) => {
    const { train, assist } = fixture();
    train.throttle = throttle;
    const baseline = { ...train };
    for (let i = 0; i < 600; i++) {
      stepDynamics(train, dt, slope, brake, assist);
      stepDynamics(baseline, dt, slope, brake);
      expect(train).toEqual(baseline);
      expect(assist.force).toBe(0);
      expect(assist.active).toBe(false);
    }
  });

  it('退出计时必须连续满足正常牵引足够；不把延时变成坡顶额外牵引', () => {
    const { assist, tick, run } = fixture();
    tick();
    run(0.5, 0);
    expect(assist.force).toBe(0);
    expect(assist.active).toBe(true);
    tick();
    expect(assist.sufficientTime).toBe(0);
    run(0.75, 0);
    expect(assist.active).toBe(true);
    run(0.25, 0);
    expect(assist.active).toBe(false);
  });
});
