import { describe, expect, it } from 'vitest';
import { initialTrainState, stepDynamics } from '../src/core/dynamics';

describe('列车动力学', () => {
  it('制动指令在四秒内从零增长到100%', () => {
    const train = initialTrainState();
    for (let i = 0; i < 240; i++) stepDynamics(train, 1 / 60, 0, true);
    expect(train.brakeCommand).toBeCloseTo(100);
    expect(train.brakeActual).toBeGreaterThan(0);
    expect(train.brakeActual).toBeCloseTo(100);
    expect(train.brakePipe).toBeLessThan(600);
  });

  it('牵引产生加速度，松开后保留惯性', () => {
    const train = initialTrainState();
    train.throttle = 100;
    for (let i = 0; i < 600; i++) stepDynamics(train, 1 / 60, 0, false);
    expect(train.velocity).toBeGreaterThan(0);
    const speed = train.velocity;
    train.throttle = 0;
    stepDynamics(train, 1 / 60, 0, false);
    expect(train.velocity).toBeGreaterThan(0);
    expect(train.velocity).toBeLessThan(speed);
  });

  it('上坡产生反向重力分力', () => {
    const train = initialTrainState();
    train.throttle = 30;
    stepDynamics(train, 1 / 60, 0.02, false);
    expect(train.gradeForce).toBeGreaterThan(0);
    expect(train.slope).toBe(0.02);
  });

  it('黏着不足时限制牵引力，撒砂提高上限', () => {
    const train = initialTrainState();
    train.throttle = 100;
    stepDynamics(train, 1 / 60, 0, false);
    expect(train.adhesionLimited).toBe(true);
    const limited = train.tractionForce;
    train.sandRemaining = 8;
    stepDynamics(train, 1 / 60, 0, false);
    expect(train.tractionForce).toBeGreaterThan(limited);
  });
});
