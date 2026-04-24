import Foundation

// MARK: - Constants matching web engine index.ts

let forwardIntegrationMaxStepSec: Double = 5
let forwardCanopyAirspeedKt: Double = 25
let forwardCanopyGlideRatio: Double = 2.5
let forwardCanopyDeploymentLossFt: Double = 300
let forwardCanopyPatternReserveFt: Double = 1000
let forwardCanopyPreferredMarginFt: Double = 750
let forwardCorridorPreferredMarginFt: Double = 1000
let forwardDeployPreferredRadiusFraction: Double = 0.45
let forwardDeployPreferredRadiusMinFt: Double = 2500
let forwardDeployPreferredRadiusMaxFt: Double = 4500
let forwardDeployPreferredRadiusBandFt: Double = 750
let wingsuitDistanceDefaultOffsetFt: Double = 4000 * 3.280839895
let wingsuitDistanceDefaultPostTurnFt: Double = 750
let wingsuitDistanceFirstLegTargetFt: Double = 1800

let defaultWingsuitAutoAssumptions = ResolvedJumpRunAssumptions(
    planeAirspeedKt: 85,
    groupCount: 4,
    groupSeparationFt: 1500,
    slickDeployHeightFt: 3000,
    slickFallRateFps: 176,
    slickReturnRadiusFt: 5000
)

struct ResolvedJumpRunAssumptions {
    let planeAirspeedKt: Double
    let groupCount: Int
    let groupSeparationFt: Double
    let slickDeployHeightFt: Double
    let slickFallRateFps: Double
    let slickReturnRadiusFt: Double
}

let jumpRunSpotTable: [(maxWindKt: Double, offsetMiles: Double)] = [
    (2.5, 0), (7.5, 0.1), (12.5, 0.2), (17.5, 0.3),
    (22.5, 0.4), (27.5, 0.5), (32.5, 0.6), (.infinity, 0.7),
]

let jumpRunCrosswindTable: [(maxWindKt: Double, offsetMiles: Double)] = [
    (2.5, 0), (7.5, 0.05), (12.5, 0.1), (17.5, 0.15),
    (22.5, 0.2), (27.5, 0.25), (32.5, 0.3), (.infinity, 0.35),
]

// MARK: - Internal types for forward solver

struct ForwardCandidateEvaluation {
    let landingHeadingDeg: Double
    let bearingDeg: Double
    let radiusFt: Double
    let turnHeightsFt: [Double]
    let resolvedJumpRun: ResolvedJumpRun
    let deployPoint: WingsuitAutoWaypoint
    let exitPoint: WingsuitAutoWaypoint
    let turnPoints: [WingsuitAutoWaypoint]
    let routeWaypoints: [WingsuitAutoWaypoint]
    let routeSegments: [SegmentOutput]
    let warnings: [String]
    let exitToJumpRunErrorFt: Double
    let firstSlickReturnMarginFt: Double?
    let lastSlickReturnMarginFt: Double?
    let corridorMarginFt: Double
    let deployRadiusMarginFt: Double
    let firstLegTrackDeltaDeg: Double
    let exitAlongTargetErrorFt: Double
    let canopyReturnMarginFt: Double
    let shapePenalty: Double
}

struct AutoGateCandidate {
    let gatesFt: [Double] // 4 elements
    let turnHeightsFt: [Double] // 2 elements
}

struct ForwardRouteLeg {
    let name: SegmentName
    let headingDeg: Double
    let startAltFt: Double
    let endAltFt: Double
}

struct ForwardRouteLegResult {
    let segment: ForwardSegmentComputation
    let start: LocalPoint
    let end: LocalPoint
}

struct ForwardSegmentComputation {
    let name: SegmentName
    let headingDeg: Double
    let trackHeadingDeg: Double
    let alongLegSpeedKt: Double
    let groundSpeedKt: Double
    let timeSec: Double
    let distanceFt: Double
}

struct ResolvedJumpRunPlan {
    let resolved: ResolvedJumpRun
    let frame: JumpRunFrame
    let targetExitLocal: LocalPoint
    let jumpRunUnit: LocalPoint
    let groupSpacingFt: Double
    let placementMode: WingsuitAutoJumpRunPlacementMode
    let headingSource: WingsuitAutoJumpRunHeadingSource
    let constrainedHeadingApplied: Bool
    let normalJumpRunHeadingDeg: Double?
    let distanceOffsiteFt: Double?
    let headwindComponentKt: Double
    let crosswindComponentKt: Double
    let firstSlickReturnMarginFt: Double?
    let lastSlickReturnMarginFt: Double?
    let preferredSpotOffsetAlongFt: Double
    let warnings: [String]
    let blockedReason: String?
}

// MARK: - Helper functions

func resolveJumpRunPlacementMode(_ mode: WingsuitAutoJumpRunPlacementMode?) -> WingsuitAutoJumpRunPlacementMode {
    mode == .distance ? .distance : .normal
}

func resolveDistanceOffsetFt(_ input: WingsuitAutoInput) -> Double {
    input.jumpRun.distanceOffsetFt ?? wingsuitDistanceDefaultOffsetFt
}

func resolveDistancePostTurnFt(_ input: WingsuitAutoInput) -> Double {
    input.jumpRun.distancePostTurnFt ?? wingsuitDistanceDefaultPostTurnFt
}

func resolveJumpRunAssumptions(_ assumptions: WingsuitAutoJumpRunAssumptions?) -> ResolvedJumpRunAssumptions {
    ResolvedJumpRunAssumptions(
        planeAirspeedKt: assumptions?.planeAirspeedKt ?? defaultWingsuitAutoAssumptions.planeAirspeedKt,
        groupCount: assumptions?.groupCount ?? defaultWingsuitAutoAssumptions.groupCount,
        groupSeparationFt: assumptions?.groupSeparationFt ?? defaultWingsuitAutoAssumptions.groupSeparationFt,
        slickDeployHeightFt: assumptions?.slickDeployHeightFt ?? defaultWingsuitAutoAssumptions.slickDeployHeightFt,
        slickFallRateFps: assumptions?.slickFallRateFps ?? defaultWingsuitAutoAssumptions.slickFallRateFps,
        slickReturnRadiusFt: assumptions?.slickReturnRadiusFt ?? defaultWingsuitAutoAssumptions.slickReturnRadiusFt
    )
}

func lookupJumpRunSpotOffsetFt(_ componentKt: Double) -> Double {
    let abs = Swift.abs(componentKt)
    let bucket = jumpRunSpotTable.first { abs <= $0.maxWindKt }
    let offsetFt = (bucket?.offsetMiles ?? 0) * 5280
    return componentKt >= 0 ? offsetFt : -offsetFt
}

func lookupJumpRunCrosswindOffsetFt(_ componentKt: Double) -> Double {
    let abs = Swift.abs(componentKt)
    let bucket = jumpRunCrosswindTable.first { abs <= $0.maxWindKt }
    let offsetFt = (bucket?.offsetMiles ?? 0) * 5280
    return componentKt >= 0 ? offsetFt : -offsetFt
}

private func positivePart(_ value: Double) -> Double { max(0, value) }
private func square(_ value: Double) -> Double { value * value }

func signedHeadingDeltaDeg(_ fromDeg: Double, _ toDeg: Double) -> Double {
    ((normalizeHeading(toDeg) - normalizeHeading(fromDeg) + 540).truncatingRemainder(dividingBy: 360)) - 180
}

func absoluteHeadingDeltaDeg(_ fromDeg: Double, _ toDeg: Double) -> Double {
    abs(signedHeadingDeltaDeg(fromDeg, toDeg))
}

func localPointToVec(_ point: LocalPoint) -> Vec2 {
    Vec2(east: point.eastFt, north: point.northFt)
}

func interpolateLocalPoint(_ start: LocalPoint, _ end: LocalPoint, _ t: Double) -> LocalPoint {
    LocalPoint(eastFt: start.eastFt + (end.eastFt - start.eastFt) * t,
               northFt: start.northFt + (end.northFt - start.northFt) * t)
}

func computeForwardCandidateScore(_ candidate: ForwardCandidateEvaluation) -> Double {
    let canopyShortfall = positivePart(forwardCanopyPreferredMarginFt - candidate.canopyReturnMarginFt)
    let corridorShortfall = positivePart(forwardCorridorPreferredMarginFt - candidate.corridorMarginFt)
    let safetyPenalty = square(canopyShortfall / 500) + square(corridorShortfall / 500)

    let preferredRadius = clamp(
        (candidate.radiusFt + candidate.deployRadiusMarginFt) * forwardDeployPreferredRadiusFraction,
        min: forwardDeployPreferredRadiusMinFt,
        max: forwardDeployPreferredRadiusMaxFt
    )
    let radiusShortfall = positivePart(preferredRadius - forwardDeployPreferredRadiusBandFt - candidate.radiusFt)
    let radiusExcess = positivePart(candidate.radiusFt - preferredRadius - forwardDeployPreferredRadiusBandFt)
    let radiusPenalty = square(radiusShortfall / 1000) + 0.25 * square(radiusExcess / 1000)
    let saturatedReward = 0.01 * min(candidate.canopyReturnMarginFt, 1000) + 0.01 * min(candidate.corridorMarginFt, 1000)

    return 1000 * safetyPenalty + 50 * candidate.shapePenalty + 40 * radiusPenalty - saturatedReward
}

func compareForwardCandidates(_ a: ForwardCandidateEvaluation, _ b: ForwardCandidateEvaluation) -> Double {
    computeForwardCandidateScore(a) - computeForwardCandidateScore(b)
}

func computeForwardShapePenalty(
    input: WingsuitAutoInput,
    jumpRunHeadingDeg: Double,
    firstTrackDeg: Double,
    offsetTrackDeg: Double,
    returnTrackDeg: Double
) -> Double {
    let sideSign: Double = input.side == .left ? -1 : 1
    let firstTarget = normalizeHeading(jumpRunHeadingDeg + sideSign * 15)
    let offsetTarget = normalizeHeading(jumpRunHeadingDeg + sideSign * 90)
    let returnTarget = normalizeHeading(jumpRunHeadingDeg + 180)
    return 0.5 * square(absoluteHeadingDeltaDeg(firstTrackDeg, firstTarget) / 20)
         + 1.5 * square(absoluteHeadingDeltaDeg(offsetTrackDeg, offsetTarget) / 20)
         + 1.5 * square(absoluteHeadingDeltaDeg(returnTrackDeg, returnTarget) / 25)
}

func computeDistanceShapePenalty(
    input: WingsuitAutoInput,
    distanceRunHeadingDeg: Double,
    normalJumpRunHeadingDeg: Double?,
    firstTrackDeg: Double,
    offsetTrackDeg: Double,
    returnTrackDeg: Double,
    firstLegDistanceFt: Double
) -> Double {
    let sideSign: Double = input.side == .left ? -1 : 1
    let firstTarget = normalizeHeading(distanceRunHeadingDeg + sideSign * 10)
    let returnTarget = normalizeHeading((normalJumpRunHeadingDeg ?? distanceRunHeadingDeg) + 180)
    let shortFirstLegPenalty =
        4 * square(positivePart(firstLegDistanceFt - wingsuitDistanceFirstLegTargetFt) / 700) +
        0.35 * square(positivePart(900 - firstLegDistanceFt) / 900)
    return square(absoluteHeadingDeltaDeg(firstTrackDeg, firstTarget) / 15)
         + 3 * square(absoluteHeadingDeltaDeg(offsetTrackDeg, returnTarget) / 14)
         + 3 * square(absoluteHeadingDeltaDeg(returnTrackDeg, returnTarget) / 14)
         + 1.6 * shortFirstLegPenalty
}
