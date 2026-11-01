import { APP_CONFIG } from '../config';
import type { TrainState } from '../types';

const G = 9.80665;

export function totalMass(): number {
  return APP_CONFIG.train.locomotive.mass + APP_CONFIG.train.cars.reduce((sum, car) => sum + car.mass, 0);
}

export function initialTrainState(): TrainState {
  return {
    velocity: 0,
    throttle: 0,
    brakeCommand: 0,
    brakeActual: 0,
    brakePipe: 600,
    acceleration: 0,
    tractionForce: 0,
    brakeForce: 0,
    resistanceForce: 0,
    gradeForce: 0,
    slope: 0,
    reverser: 1,
    sandRemaining: 0,
    adhesionLimited: false,
  };
}

export function stepDynamics(state: TrainState, dt: number, slope: number, brakeHeld: boolean): void {
  const config = APP_CONFIG.train;
  state.brakeCommand = Math.max(0, Math.min(100, state.brakeCommand + (brakeHeld ? 100 / config.brakeApplySeconds : -100 / config.brakeReleaseSeconds) * dt));
  const brakeRate = 100 / (state.brakeActual < state.brakeCommand ? config.brakeApplySeconds : config.brakeReleaseSeconds);
  state.brakeActual += Math.max(-brakeRate * dt, Math.min(brakeRate * dt, state.brakeCommand - state.brakeActual));
  state.brakeActual = Math.max(0, Math.min(100, state.brakeActual));
  state.brakePipe = 600 - state.brakeActual * 1.7;
  state.sandRemaining = Math.max(0, state.sandRemaining - dt);

  const speed = Math.abs(state.velocity);
  const requested = state.throttle / 100 * config.maxTractionForce * Math.min(1, config.tractionFadeSpeed / Math.max(1, speed));
  const adhesion = config.baseAdhesion + (state.sandRemaining > 0 ? config.sandAdhesionBonus : 0);
  const adhesionLimit = config.locomotive.mass * G * adhesion;
  state.adhesionLimited = requested > adhesionLimit;
  state.tractionForce = Math.min(requested, adhesionLimit) * state.reverser;
  state.brakeForce = config.maxBrakeForce * state.brakeActual / 100;
  state.resistanceForce = speed > 0.002 ? config.resistance.a + config.resistance.b * speed + config.resistance.c * speed * speed : 0;
  state.gradeForce = totalMass() * G * Math.sin(Math.atan(slope));
  state.slope = slope;

  const direction = Math.sign(state.velocity);
  const netForce = state.tractionForce - direction * state.brakeForce - direction * state.resistanceForce - state.gradeForce;
  state.acceleration = netForce / totalMass();
  const nextVelocity = state.velocity + state.acceleration * dt;
  if (state.velocity !== 0 && Math.sign(nextVelocity) !== direction && (state.brakeActual > 0 || state.reverser === 0)) state.velocity = 0;
  else state.velocity = nextVelocity;
  if (Math.abs(state.velocity) < 0.0005 && state.throttle === 0 && Math.abs(state.gradeForce) < config.resistance.a + state.brakeForce) state.velocity = 0;
}
