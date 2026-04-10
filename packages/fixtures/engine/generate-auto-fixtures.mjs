import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const engineDistDir = resolve(repoRoot, "packages/engine/dist");
const tmpDir = mkdtempSync(join(tmpdir(), "landing-auto-engine-"));

const mathSource = readFileSync(resolve(engineDistDir, "math.js"), "utf8");
const rawIndexSource = readFileSync(resolve(engineDistDir, "index.js"), "utf8");
const indexSource = rawIndexSource.replace(/from\s+"\.\/math"/g, 'from "./math.js"');

writeFileSync(resolve(tmpDir, "math.js"), mathSource);
writeFileSync(resolve(tmpDir, "index.js"), indexSource);

const engineModule = await import(`file://${resolve(tmpDir, "index.js")}`);
const { solveWingsuitAuto, validateWingsuitAutoInput } = engineModule;

const outputPath = resolve(__dirname, "wingsuit-auto-fixtures.json");
const landingPoint = { lat: 37, lng: -122 };

const baseInput = {
  landingPoint,
  jumpRun: {
    directionMode: "manual",
    manualHeadingDeg: 0,
    constraintMode: "none",
    constraintHeadingDeg: 0,
    assumptions: {
      planeAirspeedKt: 85,
      groupCount: 4,
      groupSeparationFt: 1500,
      slickDeployHeightFt: 3000,
      slickFallRateFps: 176,
      slickReturnRadiusFt: 5000,
    },
  },
  side: "left",
  exitHeightFt: 12000,
  deployHeightFt: 4000,
  winds: [
    { altitudeFt: 12000, speedKt: 20, dirFromDeg: 270, source: "manual" },
    { altitudeFt: 8000, speedKt: 16, dirFromDeg: 270, source: "manual" },
    { altitudeFt: 4000, speedKt: 12, dirFromDeg: 270, source: "manual" },
  ],
  wingsuit: {
    name: "Squirrel FREAK",
    flightSpeedKt: 84,
    fallRateFps: 68,
  },
  tuning: {
    corridorHalfWidthFt: 250,
    deployBearingWindowHalfDeg: 70,
    deployRadiusStepFt: 250,
    minDeployRadiusFt: 1000,
  },
};

const cases = [
  { name: "auto_nominal_left", input: baseInput },
  {
    name: "auto_custom_turn_ratios",
    input: {
      ...baseInput,
      turnRatios: {
        turn1: 0.6,
        turn2: 0.25,
      },
    },
  },
  {
    name: "auto_corridor_block",
    input: {
      ...baseInput,
      tuning: {
        ...baseInput.tuning,
        corridorHalfWidthFt: 30000,
      },
    },
  },
];

const payload = {
  schemaVersion: 1,
  cases: cases.map(({ name, input }) => ({
    name,
    input,
    validation: validateWingsuitAutoInput(input),
    output: solveWingsuitAuto(input),
  })),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(payload, null, 2));
console.log(`Wrote fixtures: ${outputPath}`);
