# CLAUDE.md — Repository Working Rules

## Repository Purpose

Local-first skydiving flight-path simulator. Computes canopy landing patterns and wingsuit freefall routes. Runs on web (React + Vite) and iOS (SwiftUI). Wingsuit auto mode is **currently web-only**; the iOS implementation is planned but not yet started.

## Implementation Style

Prefer simple, explicit solutions over defensive over-design. Do not add speculative abstractions, broad edge-case handling, or silent fallback paths unless they are clearly required by the existing product or codebase. For invalid, unsupported, or disqualified input, fail fast and visibly with a clear error rather than trying to guess, recover silently, or layer multiple fallback behaviors.

## Start Here

Before making any change, read in this order:

1. `docs/architecture_overview.md` — product purpose, modes, system boundaries, feature matrix
2. `docs/component_map.md` — exact file locations for every subsystem, onboarding reading order
3. The subsystem-specific doc relevant to your task (see Key Docs)

**Verify important behavior from the code itself before editing docs or making architectural claims.**

## Key Docs

| Doc | When to Read |
|-----|-------------|
| `docs/architecture_overview.md` | All changes |
| `docs/component_map.md` | Finding files, module boundaries |
| `docs/wingsuit-auto-mode.md` | Any work touching `solveWingsuitAuto` or auto-mode logic |
| `docs/web_ios_feature_status.md` | Any iOS work or parity questions |
| `docs/domain_model.md` | Data structures, solver contracts, coordinate systems, persistence |
| `docs/rendering_pipeline.md` | Map overlays, GeoJSON features, markers, layer styling |

## Key Code Areas

| Area | Primary File(s) |
|------|----------------|
| Pattern solver (web) | `packages/engine/src/index.ts` — `computePattern`, `solveWingsuitAuto` |
| Math utilities (web) | `packages/engine/src/math.ts` |
| Type contracts (web) | `packages/ui-types/src/index.ts` |
| Wind + presets (web) | `packages/data/src/index.ts`, `packages/data/src/presets.ts` |
| Web state | `apps/web/src/store.ts` |
| Web UI + solver wiring | `apps/web/src/App.tsx` — `buildPatternInput`, `buildWingsuitAutoInput` |
| Web map rendering | `apps/web/src/components/MapPanel.tsx` |
| iOS state | `apps/ios/LandingPattern/State/LandingStore.swift` |
| iOS solver (Swift) | `apps/ios/LandingPatternCore/Sources/LandingPatternCore/Engine/PatternEngine.swift` |
| iOS type contracts | `apps/ios/LandingPatternCore/Sources/LandingPatternCore/Models/Contracts.swift` |
| Parity fixtures | `packages/fixtures/engine/` — run `npm run ios:fixtures:sync` after engine changes |

## Product / Implementation Guardrails

- **Wingsuit auto mode is currently web-only.** The iOS gate is `iosWingsuitAutoModeEnabled = false` in `LandingStore.swift:15`. Before enabling it, the Swift solver must be ported from the current web implementation. See `docs/web_ios_feature_status.md` §Recommended Porting Order.
- **For auto mode, the web TypeScript is the source of truth.** `PatternEngine.swift` contains an older reverse-solve implementation that predates the current forward-parametric design — do not use it as a reference when working on auto mode.
- **iOS is behind web on several features — check before assuming parity.** Consult `docs/web_ios_feature_status.md` before assuming a web feature exists on iOS.
- **iOS and web have separate engine implementations.** A logic change on one side requires a matching change on the other, plus a fixture sync (`npm run ios:fixtures:sync`).
- **The iOS `WingsuitAutoOutput` contract is currently missing fields** present on the web. When porting auto mode, update `Contracts.swift` to match the web output shape first.

## Change Workflow Expectations

- Run `npm run test --workspace @landing/engine` after touching engine logic.
- Run `npm run build` to confirm no TypeScript errors.
- After any engine logic change, run `npm run ios:fixtures:sync` and `npm run ios:core:test` to check Swift parity.
- Full iOS pipeline: `npm run ios:pipeline`.
- Engine tests live in `packages/engine/test/engine.test.ts` — add a test when changing solver behavior.
- Verify changed behavior with a test before declaring it correct.
- For rendering changes, verify the `kind` filter in `MapPanel.tsx` and the corresponding layer definition match.
- For iOS work, confirm `Contracts.swift` matches the TS `ui-types` interface for any new fields.

## Documentation Expectations

Update the relevant doc **in the same change** when code alters:

| What changed | Doc to update |
|-------------|--------------|
| Solver behavior, contracts, I/O shapes | `docs/wingsuit-auto-mode.md` and/or `docs/domain_model.md` |
| Rendering (feature kind, layer, color, interaction) | `docs/rendering_pipeline.md` |
| Web/iOS parity | `docs/web_ios_feature_status.md` |
| New/moved files or module boundaries | `docs/component_map.md` |
| System-level architecture or feature matrix | `docs/architecture_overview.md` |

Update `AGENTS.md` / `CLAUDE.md` only when **repo-wide working rules change** — not for ordinary feature changes.
