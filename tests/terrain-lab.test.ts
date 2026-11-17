import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, fitProfile, profileAt, profileMetrics, syntheticHeight, type HeightSample } from '../dev/terrain-lab/profile';
import { initialTrainState, stepDynamics } from '../src/core/dynamics';
import route from '../dev/terrain-lab/route.json';
import { readFileSync } from 'node:fs';
import { distance } from '../src/utils/geo';

const input = () => Array.from({ length: 501 }, (_, i) => ({ s: i * 10, h: syntheticHeight(i * 10, 0) }));
describe('terrain lab: inferred profile evidence, not production railway data', () => {
  it('reduces the controlled spike, preserves raw input and respects the configured grade bound', () => {
    const raw = input(), snapshot = JSON.stringify(raw), fitted = fitProfile(raw);
    expect(profileMetrics(raw).maxAbsGradePermille).toBeGreaterThan(400);
    expect(profileMetrics(fitted).maxAbsGradePermille).toBeLessThanOrEqual(35 + 1e-8);
    expect(profileAt(fitted, 1250).height).toBeLessThan(profileAt(raw, 1250).height - 10);
    expect(fitted[0]).toEqual(raw[0]); expect(fitted.at(-1)).toEqual(raw.at(-1));
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
  it('fails on missing/NaN samples, duplicate mileages and infeasible endpoint constraints', () => {
    for (const bad of [null, NaN, Infinity]) expect(() => fitProfile([{ s: 0, h: 10 }, { s: 10, h: bad }])).toThrow();
    expect(() => fitProfile([{ s: 0, h: 10 }, { s: 0, h: 10 }])).toThrow();
    expect(() => fitProfile([{ s: 0, h: 10 }, { s: 10, h: 20 }])).toThrow('incompatible');
  });
  it('same global profile gives identical heights at 250m chunk seams and on reverse visits', () => {
    const fitted = fitProfile(input());
    for (let s = 250; s < 5000; s += 250) {
      expect(profileAt(fitted, s - 1e-7).height).toBeCloseTo(profileAt(fitted, s + 1e-7).height, 7);
      const step = 0.1, forward = (profileAt(fitted, s + step).height - profileAt(fitted, s - step).height) / (2 * step);
      const reverse = (profileAt(fitted, s - step).height - profileAt(fitted, s + step).height) / (2 * step);
      expect(reverse).toBeCloseTo(-forward, 10);
    }
  });
  it('demonstrates why fitting each chunk separately is unsafe', () => {
    const raw = input(), global = fitProfile(raw);
    // A chunk anchor on the erroneous peak locks the error into the local fit or makes it infeasible.
    expect(() => fitProfile(raw.filter(p => p.s >= 1000 && p.s <= 1250))).toThrow('incompatible');
    expect(Math.abs(profileAt(raw, 1250).height - profileAt(global, 1250).height)).toBeGreaterThan(10);
  });
  it('quantifies slope-input effects using the existing 60Hz dynamics, assistance absent', () => {
    const raw = input(), fitted = fitProfile(raw);
    const slope = (profile: HeightSample[], s: number) => (profileAt(profile, s + 150).height - profileAt(profile, s - 150).height) / 300;
    const run = (profile: HeightSample[]) => {
      const train = initialTrainState(); train.throttle = 100; train.brakeCommand = train.brakeActual = 0;
      let s = 900, maxGradeForce = 0, minSpeed = Infinity, elapsed = 0;
      for (let i = 0; i < 180 * 60; i++) {
        stepDynamics(train, 1 / 60, slope(profile, s), false);
        s += train.velocity / 60; elapsed += 1 / 60;
        maxGradeForce = Math.max(maxGradeForce, Math.abs(train.gradeForce)); minSpeed = Math.min(minSpeed, train.velocity * 3.6);
      }
      return { endMileage: s, endSpeedKmh: train.velocity * 3.6, maxGradeForce, minSpeed, elapsed };
    };
    const before = run(raw), after = run(fitted);
    console.log('terrain lab dynamics (controlled 22m bump, no assist):', JSON.stringify({ before, after, options: DEFAULT_PROFILE }));
    expect(after.maxGradeForce).toBeLessThan(before.maxGradeForce);
    // Smoothing redistributes gravitational work; greater trip distance is not a valid success criterion.
    expect(after.maxGradeForce).toBeLessThan(before.maxGradeForce * 0.5);
  });
  it('test corridor samples remain exactly on their declared original GeoJSON segments', () => {
    const source = JSON.parse(readFileSync(new URL('../data/geojson/320000-江苏省.geojson', import.meta.url), 'utf8'));
    expect(route.samples).toHaveLength(501); expect(route.length).toBe(5000);
    for (const p of route.samples) {
      const [, feature, part] = p.segmentId.split(':').map(Number);
      const points = source.features[feature].geometry.coordinates[part] as number[][];
      let traversed = 0, projected: { lon: number; lat: number } | undefined;
      for (let i = 1; i < points.length; i++) {
        const a = { lon: points[i - 1][0], lat: points[i - 1][1] }, b = { lon: points[i][0], lat: points[i][1] };
        const span = distance(a, b);
        if (traversed + span >= p.offset - 1e-6) { const t = (p.offset - traversed) / span; projected = { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t }; break; }
        traversed += span;
      }
      expect(projected).toBeDefined(); expect(distance(p, projected!)).toBeLessThan(0.001);
    }
  });
});
