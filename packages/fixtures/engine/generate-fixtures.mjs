import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const engineDistDir = resolve(repoRoot, 'packages/engine/dist');
const tmpDir = mkdtempSync(join(tmpdir(), 'landing-engine-'));

const mathSource = readFileSync(resolve(engineDistDir, 'math.js'), 'utf8');
const rawIndexSource = readFileSync(resolve(engineDistDir, 'index.js'), 'utf8');
const indexSource = rawIndexSource.replace(/from\s+"\.\/math"/g, 'from "./math.js"');

writeFileSync(resolve(tmpDir, 'math.js'), mathSource);
writeFileSync(resolve(tmpDir, 'index.js'), indexSource);

const engineModule = await import(`file://${resolve(tmpDir, 'index.js')}`);
const { computePattern, validatePatternInput } = engineModule;

const outputPath = resolve(__dirname, 'fixtures.json');

const baseInput = {
  touchdownLat: 37,
  touchdownLng: -122,
  landingHeadingDeg: 180,
  side: 'left',
  baseLegDrift: true,
  gatesFt: [900, 600, 300, 0],
  canopy: {
    manufacturer: 'PD',
    model: 'Sabre3',
    sizeSqft: 170,
    wlRef: 1,
    airspeedRefKt: 20,
    airspeedWlExponent: 0.5,
    airspeedMinKt: 8,
    airspeedMaxKt: 35,
    glideRatio: 2.7,
  },
  jumper: {
    exitWeightLb: 170,
    canopyAreaSqft: 170,
  },
  winds: [
    { altitudeFt: 900, speedKt: 5, dirFromDeg: 270, source: 'auto' },
    { altitudeFt: 600, speedKt: 5, dirFromDeg: 270, source: 'auto' },
    { altitudeFt: 300, speedKt: 5, dirFromDeg: 270, source: 'auto' },
  ],
};

const cases = [
  { name: 'nominal_left_drift', input: baseInput },
  { name: 'nominal_right_drift', input: { ...baseInput, side: 'right' } },
  {
    name: 'no_drift_crosswind',
    input: {
      ...baseInput,
      baseLegDrift: false,
      winds: baseInput.winds.map((w) => ({ ...w, dirFromDeg: 180 })),
    },
  },
  {
    name: 'strong_headwind',
    input: {
      ...baseInput,
      winds: baseInput.winds.map((w) => ({ ...w, speedKt: 15, dirFromDeg: 180 })),
    },
  },
  {
    name: 'high_wing_loading_block',
    input: {
      ...baseInput,
      jumper: {
        exitWeightLb: 260,
        canopyAreaSqft: 130,
      },
    },
  },
  {
    name: 'non_us_location_high_wind',
    input: {
      ...baseInput,
      touchdownLat: 19.6542,
      touchdownLng: 109.1796,
      landingHeadingDeg: 130,
      winds: [
        { altitudeFt: 900, speedKt: 22, dirFromDeg: 310, source: 'manual' },
        { altitudeFt: 600, speedKt: 18, dirFromDeg: 300, source: 'manual' },
        { altitudeFt: 300, speedKt: 14, dirFromDeg: 290, source: 'manual' },
      ],
    },
  },
];

const payload = {
  schemaVersion: 1,
  tolerance: {
    headingDeg: 1.0,
    distancePct: 0.03,
    timePct: 0.03,
    speedKt: 0.5,
  },
  cases: cases.map(({ name, input }) => ({
    name,
    input,
    validation: validatePatternInput(input),
    output: computePattern(input),
  })),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(payload, null, 2));
console.log(`Wrote fixtures: ${outputPath}`);
