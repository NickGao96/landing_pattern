import Foundation

private let wlMax: Double = 1.7
private let minFinalForwardGroundSpeedKt: Double = 5
private let airspeedMinKtDefault: Double = 8
private let airspeedMaxKtDefault: Double = 35
private let epsilon: Double = 1e-6

private let defaultWingsuitAutoTurnRatiosResolved = WingsuitAutoTurnRatios(
    turn1: 0.75,
    turn2: 0.3125
)

private struct ResolvedWingsuitAutoTuning {
    let corridorHalfWidthFt: Double
    let canopySweepStepDeg: Double
    let deployBearingStepDeg: Double
    let deployRadiusStepFt: Double
    let deployBearingWindowHalfDeg: Double
    let minDeployRadiusFt: Double
    let refinementIterations: Double
    let exitOnJumpRunToleranceFt: Double
}

private let defaultWingsuitAutoTuningResolved = ResolvedWingsuitAutoTuning(
    corridorHalfWidthFt: 1500,
    canopySweepStepDeg: 5,
    deployBearingStepDeg: 5,
    deployRadiusStepFt: 250,
    deployBearingWindowHalfDeg: 60,
    minDeployRadiusFt: 500,
    refinementIterations: 3,
    exitOnJumpRunToleranceFt: 250
)

private struct LocalPoint {
    let eastFt: Double
    let northFt: Double
}

private struct JumpRunFrame {
    let start: LocalPoint
    let end: LocalPoint
    let unit: LocalPoint
    let leftUnit: LocalPoint
    let lengthFt: Double
}

private struct CandidateEvaluation {
    let bearingDeg: Double
    let radiusFt: Double
    let maxRadiusFt: Double
    let deployPoint: WingsuitAutoWaypoint
    let exitPoint: WingsuitAutoWaypoint
    let turnPoints: [WingsuitAutoWaypoint]
    let routeWaypoints: [WingsuitAutoWaypoint]
    let routeSegments: [SegmentOutput]
    let warnings: [String]
    let exitToJumpRunErrorFt: Double
    let corridorMarginFt: Double
    let deployEnvelopeMarginFt: Double
    let exitAlongRunFt: Double
}

private struct SegmentComputation {
    let name: SegmentName
    let headingDeg: Double
    let trackHeadingDeg: Double
    let alongLegSpeedKt: Double
    let groundVectorKt: Vec2
    let groundSpeedKt: Double
    let timeSec: Double
    let distanceFt: Double
}

private struct SegmentSolveResult {
    let segment: SegmentComputation?
    let blockedReason: String?
}

private enum SegmentSolveKind {
    case drift
    case trackLocked
}

private struct SegmentDefinition {
    let name: SegmentName
    let headingDeg: Double
    let startAltFt: Double
    let endAltFt: Double
    let solveKind: SegmentSolveKind
}

private func computeWingLoading(exitWeightLb: Double, canopyAreaSqft: Double) -> Double {
    exitWeightLb / canopyAreaSqft
}

private func clamp(_ value: Double, min: Double, max: Double) -> Double {
    Swift.min(max, Swift.max(min, value))
}

private func computeAirspeedKt(canopy: CanopyProfile, wingLoading: Double) -> Double {
    let ratio = wingLoading / canopy.wlRef
    let exponent = canopy.airspeedWlExponent ?? 0.5
    let raw = canopy.airspeedRefKt * pow(max(ratio, 1e-6), exponent)
    let minKt = canopy.airspeedMinKt ?? airspeedMinKtDefault
    let maxKt = canopy.airspeedMaxKt ?? airspeedMaxKtDefault
    return clamp(raw, min: minKt, max: maxKt)
}

private func computeSinkFps(airspeedKt: Double, glideRatio: Double) -> Double {
    let airspeedFps = knotsToFeetPerSecond(airspeedKt)
    return airspeedFps / glideRatio
}

private func computeLegHeading(landingHeadingDeg: Double, side: PatternSide, segment: SegmentName) -> Double {
    switch segment {
    case .final:
        return normalizeHeading(landingHeadingDeg)
    case .base:
        return normalizeHeading(landingHeadingDeg + (side == .left ? -90 : 90))
    case .downwind:
        return normalizeHeading(landingHeadingDeg + 180)
    }
}

private func vectorToHeadingDeg(_ vector: Vec2) -> Double {
    normalizeHeading(atan2(vector.east, vector.north) * 180 / .pi)
}

private func buildSegmentDefinitions(_ input: PatternInput) -> [SegmentDefinition] {
    let downwindGate = input.gatesFt.indices.contains(0) ? input.gatesFt[0] : 0
    let baseGate = input.gatesFt.indices.contains(1) ? input.gatesFt[1] : 0
    let finalGate = input.gatesFt.indices.contains(2) ? input.gatesFt[2] : 0
    let touchdownGate = input.gatesFt.indices.contains(3) ? input.gatesFt[3] : 0
    let baseLegDrift = input.baseLegDrift ?? true

    return [
        SegmentDefinition(
            name: .downwind,
            headingDeg: computeLegHeading(
                landingHeadingDeg: input.landingHeadingDeg,
                side: input.side,
                segment: .downwind
            ),
            startAltFt: downwindGate,
            endAltFt: baseGate,
            solveKind: .trackLocked
        ),
        SegmentDefinition(
            name: .base,
            headingDeg: computeLegHeading(
                landingHeadingDeg: input.landingHeadingDeg,
                side: input.side,
                segment: .base
            ),
            startAltFt: baseGate,
            endAltFt: finalGate,
            solveKind: baseLegDrift ? .drift : .trackLocked
        ),
        SegmentDefinition(
            name: .final,
            headingDeg: computeLegHeading(
                landingHeadingDeg: input.landingHeadingDeg,
                side: input.side,
                segment: .final
            ),
            startAltFt: finalGate,
            endAltFt: touchdownGate,
            solveKind: .trackLocked
        ),
    ]
}

private func activeSegmentDefinitions(_ input: PatternInput) -> [SegmentDefinition] {
    let definitions = buildSegmentDefinitions(input)
    guard input.mode == .wingsuit else {
        return definitions
    }
    return definitions.filter { $0.startAltFt > $0.endAltFt }
}

private func requiredWindAltitudes(_ input: PatternInput) -> [Double] {
    activeSegmentDefinitions(input).map(\.startAltFt)
}

private func findRequiredWinds(input: PatternInput, winds: [WindLayer]) -> [String] {
    var errors: [String] = []
    for altitude in requiredWindAltitudes(input) where getWindForAltitude(altitude, winds: winds) == nil {
        errors.append("Missing wind layer around \(Int(round(altitude))) ft.")
    }
    return errors
}

private func computeDriftSegment(
    name: SegmentName,
    headingDeg: Double,
    segmentStartAltFt: Double,
    segmentEndAltFt: Double,
    winds: [WindLayer],
    airspeedKt: Double,
    sinkFps: Double
) -> SegmentSolveResult {
    let wind = getWindForAltitude(segmentStartAltFt, winds: winds)
    let windVecTuple = windFromToGroundVector(speedKt: wind?.speedKt ?? 0, dirFromDeg: wind?.dirFromDeg ?? 0)
    let windVec = Vec2(east: windVecTuple.east, north: windVecTuple.north)
    let airUnit = headingToUnitVector(headingDeg)
    let airVec = scaleVec(airUnit, airspeedKt)
    let groundVector = addVec(airVec, windVec)

    let altitudeLoss = segmentStartAltFt - segmentEndAltFt
    let timeSec = altitudeLoss / sinkFps
    let groundSpeedKt = magnitude(groundVector)
    if groundSpeedKt < 0.1 {
        return SegmentSolveResult(segment: nil, blockedReason: "\(name.rawValue) leg has near-zero ground speed.")
    }

    let distanceFt = knotsToFeetPerSecond(groundSpeedKt) * timeSec
    let segment = SegmentComputation(
        name: name,
        headingDeg: headingDeg,
        trackHeadingDeg: vectorToHeadingDeg(groundVector),
        alongLegSpeedKt: dot(groundVector, airUnit),
        groundVectorKt: groundVector,
        groundSpeedKt: groundSpeedKt,
        timeSec: timeSec,
        distanceFt: distanceFt
    )
    return SegmentSolveResult(segment: segment, blockedReason: nil)
}

private func computeTrackLockedSegment(
    name: SegmentName,
    trackHeadingDeg: Double,
    segmentStartAltFt: Double,
    segmentEndAltFt: Double,
    winds: [WindLayer],
    airspeedKt: Double,
    sinkFps: Double
) -> SegmentSolveResult {
    let wind = getWindForAltitude(segmentStartAltFt, winds: winds)
    let windVecTuple = windFromToGroundVector(speedKt: wind?.speedKt ?? 0, dirFromDeg: wind?.dirFromDeg ?? 0)
    let windVec = Vec2(east: windVecTuple.east, north: windVecTuple.north)

    let trackUnit = headingToUnitVector(trackHeadingDeg)
    let rightUnit = Vec2(east: trackUnit.north, north: -trackUnit.east)

    let windAlong = dot(windVec, trackUnit)
    let windCross = dot(windVec, rightUnit)

    if abs(windCross) >= airspeedKt {
        return SegmentSolveResult(
            segment: nil,
            blockedReason: "\(name.rawValue) leg crosswind (\(String(format: "%.1f", abs(windCross))) kt) exceeds airspeed capability."
        )
    }

    let airAlong = sqrt(max(airspeedKt * airspeedKt - windCross * windCross, 0))
    let groundAlong = airAlong + windAlong
    if abs(groundAlong) < 0.1 {
        return SegmentSolveResult(
            segment: nil,
            blockedReason: "\(name.rawValue) leg has near-zero along-track ground speed."
        )
    }

    let airVec = addVec(scaleVec(trackUnit, airAlong), scaleVec(rightUnit, -windCross))
    let groundVec = scaleVec(trackUnit, groundAlong)
    let altitudeLoss = segmentStartAltFt - segmentEndAltFt
    let timeSec = altitudeLoss / sinkFps
    let distanceFt = knotsToFeetPerSecond(abs(groundAlong)) * timeSec

    let segment = SegmentComputation(
        name: name,
        headingDeg: vectorToHeadingDeg(airVec),
        trackHeadingDeg: trackHeadingDeg,
        alongLegSpeedKt: groundAlong,
        groundVectorKt: groundVec,
        groundSpeedKt: abs(groundAlong),
        timeSec: timeSec,
        distanceFt: distanceFt
    )

    return SegmentSolveResult(segment: segment, blockedReason: nil)
}

private func defaultMetrics(for mode: FlightMode) -> PatternMetrics {
    PatternMetrics(wingLoading: mode == .canopy ? 0 : nil, estAirspeedKt: 0, estSinkFps: 0)
}

private func waypointName(for segment: SegmentName) -> PatternWaypointName {
    switch segment {
    case .downwind:
        return .downwindStart
    case .base:
        return .baseStart
    case .final:
        return .finalStart
    }
}

public func validatePatternInput(_ input: PatternInput) -> ValidationResult {
    var errors: [String] = []
    var warnings: [String] = []

    if !input.touchdownLat.isFinite || !input.touchdownLng.isFinite {
        errors.append("Touchdown location must be valid latitude/longitude values.")
    }

    if !input.landingHeadingDeg.isFinite {
        errors.append("Landing heading must be a finite degree value.")
    }

    if input.mode == .canopy {
        if !input.jumper.exitWeightLb.isFinite ||
            !input.jumper.canopyAreaSqft.isFinite ||
            input.jumper.exitWeightLb <= 0 ||
            input.jumper.canopyAreaSqft <= 0 {
            errors.append("Exit weight and canopy area must be finite and positive.")
        }

        if !input.canopy.wlRef.isFinite ||
            !input.canopy.airspeedRefKt.isFinite ||
            !input.canopy.glideRatio.isFinite ||
            input.canopy.wlRef <= 0 ||
            input.canopy.airspeedRefKt <= 0 ||
            input.canopy.glideRatio <= 0 {
            errors.append("Canopy reference values must be finite and positive.")
        }

        let hasNonFiniteCanopyTuning =
            (input.canopy.airspeedWlExponent?.isFinite == false) ||
            (input.canopy.airspeedMinKt?.isFinite == false) ||
            (input.canopy.airspeedMaxKt?.isFinite == false)
        if hasNonFiniteCanopyTuning {
            errors.append("Canopy tuning values must be finite when provided.")
        }
    } else if !input.wingsuit.flightSpeedKt.isFinite ||
        !input.wingsuit.fallRateFps.isFinite ||
        input.wingsuit.flightSpeedKt <= 0 ||
        input.wingsuit.fallRateFps <= 0 {
        errors.append("Wingsuit flight speed and fall rate must be finite and positive.")
    }

    if input.gatesFt.count != 4 {
        errors.append("Gate altitudes must contain exactly 4 values.")
    } else if !input.gatesFt.allSatisfy(\.isFinite) {
        errors.append("Gate altitudes must be finite numeric values.")
    } else {
        let downwind = input.gatesFt[0]
        let base = input.gatesFt[1]
        let final = input.gatesFt[2]
        let touchdown = input.gatesFt[3]

        if input.mode == .canopy {
            if !(downwind > base && base > final && final > touchdown) {
                errors.append("Gate altitudes must be strictly descending, for example 900 > 600 > 300 > 0.")
            }
        } else {
            if !(downwind >= base && base >= final && final > touchdown) {
                errors.append("Wingsuit gate altitudes must be non-increasing with an active final leg, for example 3000 >= 2000 >= 1000 > 0.")
            }
            if downwind == base && base == final {
                errors.append("Wingsuit mode requires at least two active legs. Only one of the first two legs may disappear.")
            }
        }

        if touchdown != 0 {
            warnings.append("Touchdown gate is expected to be 0 ft AGL in this model.")
        }
    }

    for (index, wind) in input.winds.enumerated() {
        if !wind.altitudeFt.isFinite || !wind.speedKt.isFinite || !wind.dirFromDeg.isFinite {
            errors.append("Wind layer values must be finite (index \(index)).")
            continue
        }
        if wind.speedKt < 0 {
            errors.append("Wind speed cannot be negative at \(Int(round(wind.altitudeFt))) ft.")
        }
    }

    errors.append(contentsOf: findRequiredWinds(input: input, winds: input.winds))
    return ValidationResult(valid: errors.isEmpty, errors: errors, warnings: warnings)
}

public func computePattern(_ input: PatternInput) -> PatternOutput {
    let validation = validatePatternInput(input)
    var warnings = validation.warnings
    let touchdownAltFt = input.gatesFt.indices.contains(3) ? input.gatesFt[3] : (input.gatesFt.last ?? 0)

    if !validation.valid {
        return PatternOutput(
            waypoints: [
                PatternWaypoint(
                    name: .touchdown,
                    lat: input.touchdownLat,
                    lng: input.touchdownLng,
                    altFt: touchdownAltFt
                ),
            ],
            segments: [],
            metrics: defaultMetrics(for: input.mode),
            warnings: warnings + validation.errors,
            blocked: true
        )
    }

    let wingLoading = input.mode == .canopy
        ? computeWingLoading(exitWeightLb: input.jumper.exitWeightLb, canopyAreaSqft: input.jumper.canopyAreaSqft)
        : nil
    let airspeedKt = input.mode == .canopy
        ? computeAirspeedKt(canopy: input.canopy, wingLoading: wingLoading ?? 0)
        : input.wingsuit.flightSpeedKt
    let sinkFps = input.mode == .canopy
        ? computeSinkFps(airspeedKt: airspeedKt, glideRatio: input.canopy.glideRatio)
        : input.wingsuit.fallRateFps

    if input.mode == .canopy, let wingLoading, wingLoading > wlMax {
        warnings.append(
            "Wing loading \(String(format: "%.2f", wingLoading)) exceeds model limit (\(String(format: "%.1f", wlMax))). Pattern output is disabled."
        )
    }

    let activeDefinitions = activeSegmentDefinitions(input)
    let solveResults = activeDefinitions.map { definition in
        switch definition.solveKind {
        case .drift:
            return computeDriftSegment(
                name: definition.name,
                headingDeg: definition.headingDeg,
                segmentStartAltFt: definition.startAltFt,
                segmentEndAltFt: definition.endAltFt,
                winds: input.winds,
                airspeedKt: airspeedKt,
                sinkFps: sinkFps
            )
        case .trackLocked:
            return computeTrackLockedSegment(
                name: definition.name,
                trackHeadingDeg: definition.headingDeg,
                segmentStartAltFt: definition.startAltFt,
                segmentEndAltFt: definition.endAltFt,
                winds: input.winds,
                airspeedKt: airspeedKt,
                sinkFps: sinkFps
            )
        }
    }

    for result in solveResults {
        if let reason = result.blockedReason {
            warnings.append(reason)
        }
    }

    let activeSegments = solveResults.compactMap(\.segment)

    for segment in activeSegments where segment.alongLegSpeedKt < 0 {
        warnings.append(
            "\(segment.name.rawValue.capitalized) leg tracks backward (\(String(format: "%.1f", segment.alongLegSpeedKt)) kt)."
        )
    }

    let finalForwardSpeedKt = activeSegments.first(where: { $0.name == .final })?.alongLegSpeedKt ?? 0
    if finalForwardSpeedKt < minFinalForwardGroundSpeedKt {
        warnings.append(
            "Final-leg penetration is low (\(String(format: "%.1f", finalForwardSpeedKt)) kt along final). Consider a safer landing direction."
        )
    }

    let blocked =
        (input.mode == .canopy && (wingLoading ?? 0) > wlMax) ||
        !sinkFps.isFinite ||
        sinkFps <= 0 ||
        activeSegments.count != activeDefinitions.count

    let metrics = PatternMetrics(wingLoading: wingLoading, estAirspeedKt: airspeedKt, estSinkFps: sinkFps)

    if blocked {
        return PatternOutput(
            waypoints: [
                PatternWaypoint(
                    name: .touchdown,
                    lat: input.touchdownLat,
                    lng: input.touchdownLng,
                    altFt: touchdownAltFt
                ),
            ],
            segments: [],
            metrics: metrics,
            warnings: warnings,
            blocked: true
        )
    }

    let touchdown = LocalPoint(eastFt: 0, northFt: 0)
    var segmentStarts: [SegmentName: LocalPoint] = [:]
    var segmentEnd = touchdown

    for segment in activeSegments.reversed() {
        let groundUnit = unitOrZero(segment.groundVectorKt)
        let segmentStart = LocalPoint(
            eastFt: segmentEnd.eastFt - groundUnit.east * segment.distanceFt,
            northFt: segmentEnd.northFt - groundUnit.north * segment.distanceFt
        )
        segmentStarts[segment.name] = segmentStart
        segmentEnd = segmentStart
    }

    let waypoints = activeDefinitions.compactMap { definition -> PatternWaypoint? in
        guard let point = segmentStarts[definition.name] else { return nil }
        let geo = localFeetToLatLng(
            refLat: input.touchdownLat,
            refLng: input.touchdownLng,
            eastFt: point.eastFt,
            northFt: point.northFt
        )
        return PatternWaypoint(
            name: waypointName(for: definition.name),
            lat: geo.lat,
            lng: geo.lng,
            altFt: definition.startAltFt
        )
    }

    let touchdownGeo = localFeetToLatLng(
        refLat: input.touchdownLat,
        refLng: input.touchdownLng,
        eastFt: touchdown.eastFt,
        northFt: touchdown.northFt
    )

    return PatternOutput(
        waypoints: waypoints + [
            PatternWaypoint(
                name: .touchdown,
                lat: touchdownGeo.lat,
                lng: touchdownGeo.lng,
                altFt: touchdownAltFt
            ),
        ],
        segments: activeSegments.map {
            SegmentOutput(
                name: $0.name,
                headingDeg: $0.headingDeg,
                trackHeadingDeg: $0.trackHeadingDeg,
                alongLegSpeedKt: $0.alongLegSpeedKt,
                groundSpeedKt: $0.groundSpeedKt,
                timeSec: $0.timeSec,
                distanceFt: $0.distanceFt
            )
        },
        metrics: metrics,
        warnings: warnings,
        blocked: false
    )
}

private func localPointFromGeoPoint(reference: GeoPoint, point: GeoPoint) -> LocalPoint {
    let local = latLngToLocalFeet(refLat: reference.lat, refLng: reference.lng, lat: point.lat, lng: point.lng)
    return LocalPoint(eastFt: local.eastFt, northFt: local.northFt)
}

private func geoPointFromLocal(reference: GeoPoint, point: LocalPoint) -> GeoPoint {
    let geo = localFeetToLatLng(refLat: reference.lat, refLng: reference.lng, eastFt: point.eastFt, northFt: point.northFt)
    return GeoPoint(lat: geo.lat, lng: geo.lng)
}

private func pointToUnitVector(headingDeg: Double) -> LocalPoint {
    let unit = headingToUnitVector(headingDeg)
    return LocalPoint(eastFt: unit.east, northFt: unit.north)
}

private func localPointMagnitude(_ point: LocalPoint) -> Double {
    hypot(point.eastFt, point.northFt)
}

private func localPointDifference(_ a: LocalPoint, _ b: LocalPoint) -> LocalPoint {
    LocalPoint(eastFt: a.eastFt - b.eastFt, northFt: a.northFt - b.northFt)
}

private func localPointAdd(_ a: LocalPoint, _ b: LocalPoint) -> LocalPoint {
    LocalPoint(eastFt: a.eastFt + b.eastFt, northFt: a.northFt + b.northFt)
}

private func scaleLocalPoint(_ point: LocalPoint, _ scalar: Double) -> LocalPoint {
    LocalPoint(eastFt: point.eastFt * scalar, northFt: point.northFt * scalar)
}

private func dotLocalPoint(_ a: LocalPoint, _ b: LocalPoint) -> Double {
    a.eastFt * b.eastFt + a.northFt * b.northFt
}

private func crossLocalPoint(_ a: LocalPoint, _ b: LocalPoint) -> Double {
    a.eastFt * b.northFt - a.northFt * b.eastFt
}

private func normalizeLocalPoint(_ point: LocalPoint) -> LocalPoint {
    let length = localPointMagnitude(point)
    if length <= epsilon {
        return LocalPoint(eastFt: 0, northFt: 0)
    }
    return scaleLocalPoint(point, 1 / length)
}

private func buildJumpRunFrame(landingPoint: GeoPoint, jumpRun: JumpRunLine) -> JumpRunFrame? {
    let start = localPointFromGeoPoint(reference: landingPoint, point: jumpRun.start)
    let end = localPointFromGeoPoint(reference: landingPoint, point: jumpRun.end)
    let raw = localPointDifference(end, start)
    let lengthFt = localPointMagnitude(raw)
    if !lengthFt.isFinite || lengthFt <= epsilon {
        return nil
    }

    let unit = normalizeLocalPoint(raw)
    return JumpRunFrame(
        start: start,
        end: end,
        unit: unit,
        leftUnit: LocalPoint(eastFt: -unit.northFt, northFt: unit.eastFt),
        lengthFt: lengthFt
    )
}

private func signedCrossTrackDistanceFt(frame: JumpRunFrame, point: LocalPoint) -> Double {
    dotLocalPoint(localPointDifference(point, frame.start), frame.leftUnit)
}

private func alongJumpRunDistanceFt(frame: JumpRunFrame, point: LocalPoint) -> Double {
    dotLocalPoint(localPointDifference(point, frame.start), frame.unit)
}

private func circularDifferenceDeg(_ a: Double, _ b: Double) -> Double {
    let delta = abs(normalizeHeading(a) - normalizeHeading(b))
    return min(delta, 360 - delta)
}

private func resolveTurnRatios(_ turnRatios: WingsuitAutoTurnRatios?) -> WingsuitAutoTurnRatios {
    WingsuitAutoTurnRatios(
        turn1: turnRatios?.turn1 ?? defaultWingsuitAutoTurnRatiosResolved.turn1,
        turn2: turnRatios?.turn2 ?? defaultWingsuitAutoTurnRatiosResolved.turn2
    )
}

private func resolveWingsuitAutoTuning(_ tuning: WingsuitAutoTuning?) -> ResolvedWingsuitAutoTuning {
    ResolvedWingsuitAutoTuning(
        corridorHalfWidthFt: tuning?.corridorHalfWidthFt ?? defaultWingsuitAutoTuningResolved.corridorHalfWidthFt,
        canopySweepStepDeg: tuning?.canopySweepStepDeg ?? defaultWingsuitAutoTuningResolved.canopySweepStepDeg,
        deployBearingStepDeg: tuning?.deployBearingStepDeg ?? defaultWingsuitAutoTuningResolved.deployBearingStepDeg,
        deployRadiusStepFt: tuning?.deployRadiusStepFt ?? defaultWingsuitAutoTuningResolved.deployRadiusStepFt,
        deployBearingWindowHalfDeg: tuning?.deployBearingWindowHalfDeg ?? defaultWingsuitAutoTuningResolved.deployBearingWindowHalfDeg,
        minDeployRadiusFt: tuning?.minDeployRadiusFt ?? defaultWingsuitAutoTuningResolved.minDeployRadiusFt,
        refinementIterations: tuning?.refinementIterations ?? defaultWingsuitAutoTuningResolved.refinementIterations,
        exitOnJumpRunToleranceFt: tuning?.exitOnJumpRunToleranceFt ?? defaultWingsuitAutoTuningResolved.exitOnJumpRunToleranceFt
    )
}

private func deriveTurnHeightsFt(input: WingsuitAutoInput, ratios: WingsuitAutoTurnRatios) -> [Double] {
    let span = input.exitHeightFt - input.deployHeightFt
    return [
        input.deployHeightFt + span * ratios.turn1,
        input.deployHeightFt + span * ratios.turn2,
    ]
}

private func buildAutoGatesFt(input: WingsuitAutoInput, ratios: WingsuitAutoTurnRatios) -> [Double] {
    let turnHeightsFt = deriveTurnHeightsFt(input: input, ratios: ratios)
    return [input.exitHeightFt, turnHeightsFt[0], turnHeightsFt[1], input.deployHeightFt]
}

private func isFiniteGeoPoint(_ point: GeoPoint) -> Bool {
    point.lat.isFinite &&
        point.lng.isFinite &&
        (-90 ... 90).contains(point.lat) &&
        (-180 ... 180).contains(point.lng)
}

public func validateWingsuitAutoInput(_ input: WingsuitAutoInput) -> ValidationResult {
    var errors: [String] = []
    var warnings: [String] = []
    let tuning = resolveWingsuitAutoTuning(input.tuning)
    let ratios = resolveTurnRatios(input.turnRatios)

    if !isFiniteGeoPoint(input.landingPoint) {
        errors.append("Landing point must be a valid latitude/longitude value.")
    }
    if !isFiniteGeoPoint(input.jumpRun.start) || !isFiniteGeoPoint(input.jumpRun.end) {
        errors.append("Jump run start and end must be valid latitude/longitude values.")
    }

    let jumpRunFrame = isFiniteGeoPoint(input.landingPoint)
        ? buildJumpRunFrame(landingPoint: input.landingPoint, jumpRun: input.jumpRun)
        : nil
    if jumpRunFrame == nil || (jumpRunFrame?.lengthFt ?? 0) < 500 {
        errors.append("Jump run must be at least 500 ft long.")
    }

    if !input.exitHeightFt.isFinite || !input.deployHeightFt.isFinite {
        errors.append("Exit and deploy heights must be finite numeric values.")
    } else if !(input.exitHeightFt > input.deployHeightFt && input.deployHeightFt > 0) {
        errors.append("Exit height must be above deploy height, and deploy height must be above 0 ft.")
    }

    if !ratios.turn1.isFinite ||
        !ratios.turn2.isFinite ||
        !(ratios.turn1 < 1 && ratios.turn1 > ratios.turn2 && ratios.turn2 > 0) {
        errors.append("Turn ratios must satisfy 1 > turn1 > turn2 > 0.")
    }

    if !input.jumper.exitWeightLb.isFinite ||
        !input.jumper.canopyAreaSqft.isFinite ||
        input.jumper.exitWeightLb <= 0 ||
        input.jumper.canopyAreaSqft <= 0 {
        errors.append("Exit weight and canopy area must be finite and positive.")
    }

    if !input.canopy.wlRef.isFinite ||
        !input.canopy.airspeedRefKt.isFinite ||
        !input.canopy.glideRatio.isFinite ||
        input.canopy.wlRef <= 0 ||
        input.canopy.airspeedRefKt <= 0 ||
        input.canopy.glideRatio <= 0 {
        errors.append("Canopy reference values must be finite and positive.")
    }

    if (input.canopy.airspeedWlExponent?.isFinite == false) ||
        (input.canopy.airspeedMinKt?.isFinite == false) ||
        (input.canopy.airspeedMaxKt?.isFinite == false) {
        errors.append("Canopy tuning values must be finite when provided.")
    }

    if !input.wingsuit.flightSpeedKt.isFinite ||
        !input.wingsuit.fallRateFps.isFinite ||
        input.wingsuit.flightSpeedKt <= 0 ||
        input.wingsuit.fallRateFps <= 0 {
        errors.append("Wingsuit flight speed and fall rate must be finite and positive.")
    }

    if input.winds.isEmpty {
        errors.append("At least one wind layer is required.")
    }

    for (index, wind) in input.winds.enumerated() {
        if !wind.altitudeFt.isFinite || !wind.speedKt.isFinite || !wind.dirFromDeg.isFinite {
            errors.append("Wind layer values must be finite (index \(index)).")
            continue
        }
        if wind.speedKt < 0 {
            errors.append("Wind speed cannot be negative at \(wind.altitudeFt) ft.")
        }
    }

    let highestWind = input.winds.reduce(Double.leastNormalMagnitude * -1) { max($0, $1.altitudeFt) }
    let lowestWind = input.winds.reduce(Double.greatestFiniteMagnitude) { min($0, $1.altitudeFt) }
    if highestWind.isFinite && highestWind < input.exitHeightFt {
        warnings.append("Highest wind layer is below exit height; upper winds will be extrapolated.")
    }
    if lowestWind.isFinite && lowestWind > input.deployHeightFt {
        warnings.append("Lowest wind layer is above deploy height; low winds will be extrapolated.")
    }

    let tuningValues = [
        tuning.corridorHalfWidthFt,
        tuning.canopySweepStepDeg,
        tuning.deployBearingStepDeg,
        tuning.deployRadiusStepFt,
        tuning.deployBearingWindowHalfDeg,
        tuning.minDeployRadiusFt,
        tuning.refinementIterations,
        tuning.exitOnJumpRunToleranceFt,
    ]
    if tuningValues.contains(where: { !$0.isFinite }) {
        errors.append("Auto-solver tuning values must be finite when provided.")
    }

    return ValidationResult(valid: errors.isEmpty, errors: errors, warnings: warnings)
}

private func createAutoWaypoint(
    name: WingsuitAutoWaypointName,
    point: GeoPoint,
    altFt: Double
) -> WingsuitAutoWaypoint {
    WingsuitAutoWaypoint(name: name, lat: point.lat, lng: point.lng, altFt: altFt)
}

private func integrateConstantHeadingDisplacement(
    headingDeg: Double,
    startAltFt: Double,
    endAltFt: Double,
    winds: [WindLayer],
    airspeedKt: Double,
    sinkFps: Double
) -> LocalPoint {
    var eastFt = 0.0
    var northFt = 0.0
    var currentAltFt = startAltFt
    let altitudeStepFt = 250.0
    let airVecKt = scaleVec(headingToUnitVector(headingDeg), airspeedKt)

    while currentAltFt > endAltFt + epsilon {
        let nextAltFt = max(endAltFt, currentAltFt - altitudeStepFt)
        let sampleAltFt = (currentAltFt + nextAltFt) / 2
        let altitudeLossFt = currentAltFt - nextAltFt
        let dtSec = altitudeLossFt / sinkFps
        let wind = getWindForAltitude(sampleAltFt, winds: winds)
        let windVecTuple = windFromToGroundVector(speedKt: wind?.speedKt ?? 0, dirFromDeg: wind?.dirFromDeg ?? 0)
        let windVecKt = Vec2(east: windVecTuple.east, north: windVecTuple.north)
        let groundVecKt = addVec(airVecKt, windVecKt)
        eastFt += knotsToFeetPerSecond(groundVecKt.east) * dtSec
        northFt += knotsToFeetPerSecond(groundVecKt.north) * dtSec
        currentAltFt = nextAltFt
    }

    return LocalPoint(eastFt: eastFt, northFt: northFt)
}

private func buildCanopyEnvelopeLocalPoints(
    input: WingsuitAutoInput,
    tuning: ResolvedWingsuitAutoTuning
) -> [LocalPoint] {
    let wingLoading = computeWingLoading(
        exitWeightLb: input.jumper.exitWeightLb,
        canopyAreaSqft: input.jumper.canopyAreaSqft
    )
    let airspeedKt = computeAirspeedKt(canopy: input.canopy, wingLoading: wingLoading)
    let sinkFps = computeSinkFps(airspeedKt: airspeedKt, glideRatio: input.canopy.glideRatio)

    var points: [LocalPoint] = []
    var headingDeg = 0.0
    while headingDeg < 360 {
        let deployToLanding = integrateConstantHeadingDisplacement(
            headingDeg: headingDeg,
            startAltFt: input.deployHeightFt,
            endAltFt: 0,
            winds: input.winds,
            airspeedKt: airspeedKt,
            sinkFps: sinkFps
        )
        points.append(LocalPoint(eastFt: -deployToLanding.eastFt, northFt: -deployToLanding.northFt))
        headingDeg += tuning.canopySweepStepDeg
    }
    return points
}

private func rayPolygonRadiusFt(points: [LocalPoint], bearingDeg: Double) -> Double {
    if points.count < 3 {
        return 0
    }

    let ray = pointToUnitVector(headingDeg: bearingDeg)
    var bestRadiusFt = 0.0

    for index in points.indices {
        let start = points[index]
        let end = points[(index + 1) % points.count]
        let edge = localPointDifference(end, start)
        let denominator = crossLocalPoint(ray, edge)
        if abs(denominator) <= epsilon {
            continue
        }

        let radiusFt = crossLocalPoint(start, edge) / denominator
        let segmentT = crossLocalPoint(start, ray) / denominator
        if radiusFt >= -epsilon && segmentT >= -epsilon && segmentT <= 1 + epsilon {
            bestRadiusFt = max(bestRadiusFt, radiusFt)
        }
    }

    return bestRadiusFt
}

private func buildBearingSweep(
    preferredBearingDeg: Double,
    stepDeg: Double,
    windowHalfDeg: Double
) -> [Double] {
    let count = max(1, Int(floor((windowHalfDeg * 2) / stepDeg)))
    var deduped: [Double] = []
    for index in 0 ... count {
        let offsetDeg = -windowHalfDeg + Double(index) * stepDeg
        let rounded = (normalizeHeading(preferredBearingDeg + offsetDeg) * 1_000_000).rounded() / 1_000_000
        if !deduped.contains(where: { abs($0 - rounded) <= 1e-9 }) {
            deduped.append(rounded)
        }
    }
    return deduped
}

private func buildForbiddenZonePolygon(
    landingPoint: GeoPoint,
    frame: JumpRunFrame,
    corridorHalfWidthFt: Double,
    extentFt: Double
) -> [GeoPoint] {
    let extensionFt = extentFt + frame.lengthFt
    let startExtended = localPointAdd(frame.start, scaleLocalPoint(frame.unit, -extensionFt))
    let endExtended = localPointAdd(frame.end, scaleLocalPoint(frame.unit, extensionFt))
    let leftOffset = scaleLocalPoint(frame.leftUnit, corridorHalfWidthFt)

    return [
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(startExtended, leftOffset)),
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(endExtended, leftOffset)),
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(endExtended, scaleLocalPoint(leftOffset, -1))),
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(startExtended, scaleLocalPoint(leftOffset, -1))),
    ]
}

private func buildBandsPolygon(landingPoint: GeoPoint, bands: [RadiusBand]) -> [GeoPoint] {
    if bands.isEmpty {
        return []
    }

    let outer = bands.map { band -> GeoPoint in
        let direction = pointToUnitVector(headingDeg: band.bearingDeg)
        return geoPointFromLocal(reference: landingPoint, point: scaleLocalPoint(direction, band.maxRadiusFt))
    }

    let inner = bands.reversed().map { band -> GeoPoint in
        let direction = pointToUnitVector(headingDeg: band.bearingDeg)
        return geoPointFromLocal(reference: landingPoint, point: scaleLocalPoint(direction, max(0, band.minRadiusFt)))
    }

    return outer + inner
}

private func compareCandidatesWithPreferredBearing(
    _ a: CandidateEvaluation,
    _ b: CandidateEvaluation,
    preferredBearingDeg: Double
) -> Double {
    if abs(a.exitToJumpRunErrorFt - b.exitToJumpRunErrorFt) > epsilon {
        return a.exitToJumpRunErrorFt - b.exitToJumpRunErrorFt
    }
    if abs(a.corridorMarginFt - b.corridorMarginFt) > epsilon {
        return b.corridorMarginFt - a.corridorMarginFt
    }

    let preferredDelta = circularDifferenceDeg(a.bearingDeg, preferredBearingDeg) -
        circularDifferenceDeg(b.bearingDeg, preferredBearingDeg)
    if abs(preferredDelta) > epsilon {
        return preferredDelta
    }

    if abs(a.deployEnvelopeMarginFt - b.deployEnvelopeMarginFt) > epsilon {
        return b.deployEnvelopeMarginFt - a.deployEnvelopeMarginFt
    }

    return b.exitAlongRunFt - a.exitAlongRunFt
}

private func evaluateDeployCandidate(
    input: WingsuitAutoInput,
    frame: JumpRunFrame,
    turnRatios: WingsuitAutoTurnRatios,
    corridorHalfWidthFt: Double,
    bearingDeg: Double,
    radiusFt: Double,
    maxRadiusFt: Double
) -> CandidateEvaluation? {
    let landingPoint = input.landingPoint
    let deployLocal = scaleLocalPoint(pointToUnitVector(headingDeg: bearingDeg), radiusFt)
    let deployCrossTrackFt = signedCrossTrackDistanceFt(frame: frame, point: deployLocal)
    let deployIsOnChosenSide = input.side == .left
        ? deployCrossTrackFt > corridorHalfWidthFt
        : deployCrossTrackFt < -corridorHalfWidthFt
    if !deployIsOnChosenSide {
        return nil
    }

    let deployGeo = geoPointFromLocal(reference: landingPoint, point: deployLocal)
    let routeOutput = computePattern(
        PatternInput(
            mode: .wingsuit,
            touchdownLat: deployGeo.lat,
            touchdownLng: deployGeo.lng,
            landingHeadingDeg: bearingDeg,
            side: input.side,
            baseLegDrift: true,
            gatesFt: buildAutoGatesFt(input: input, ratios: turnRatios),
            winds: input.winds,
            canopy: input.canopy,
            jumper: input.jumper,
            wingsuit: input.wingsuit
        )
    )

    if routeOutput.blocked || routeOutput.waypoints.count != 4 || routeOutput.segments.count != 3 {
        return nil
    }

    if routeOutput.segments.contains(where: { $0.alongLegSpeedKt <= 0 }) {
        return nil
    }

    let routeWarnings = routeOutput.warnings.filter {
        $0 != "Touchdown gate is expected to be 0 ft AGL in this model."
    }

    let routeWaypointNames: [WingsuitAutoWaypointName] = [.exit, .turn1, .turn2, .deploy]
    let routeWaypoints = routeOutput.waypoints.enumerated().map { index, waypoint in
        createAutoWaypoint(
            name: routeWaypointNames[index],
            point: GeoPoint(lat: waypoint.lat, lng: waypoint.lng),
            altFt: waypoint.altFt
        )
    }

    let routeLocals = routeWaypoints.map {
        localPointFromGeoPoint(reference: landingPoint, point: GeoPoint(lat: $0.lat, lng: $0.lng))
    }
    let exitPoint = routeWaypoints[0]
    let turn1Point = routeWaypoints[1]
    let turn2Point = routeWaypoints[2]
    let exitLocal = routeLocals[0]
    let turn1Local = routeLocals[1]
    let turn2Local = routeLocals[2]

    let turnAndDeployLocals = [turn1Local, turn2Local, deployLocal]
    let sideOkay = turnAndDeployLocals.allSatisfy { point in
        input.side == .left
            ? signedCrossTrackDistanceFt(frame: frame, point: point) > corridorHalfWidthFt
            : signedCrossTrackDistanceFt(frame: frame, point: point) < -corridorHalfWidthFt
    }
    if !sideOkay {
        return nil
    }

    let segmentMargins = [
        input.side == .left
            ? min(
                signedCrossTrackDistanceFt(frame: frame, point: turn1Local),
                signedCrossTrackDistanceFt(frame: frame, point: turn2Local)
            ) - corridorHalfWidthFt
            : -max(
                signedCrossTrackDistanceFt(frame: frame, point: turn1Local),
                signedCrossTrackDistanceFt(frame: frame, point: turn2Local)
            ) - corridorHalfWidthFt,
        input.side == .left
            ? min(
                signedCrossTrackDistanceFt(frame: frame, point: turn2Local),
                signedCrossTrackDistanceFt(frame: frame, point: deployLocal)
            ) - corridorHalfWidthFt
            : -max(
                signedCrossTrackDistanceFt(frame: frame, point: turn2Local),
                signedCrossTrackDistanceFt(frame: frame, point: deployLocal)
            ) - corridorHalfWidthFt,
    ]

    if segmentMargins.contains(where: { $0 <= 0 }) {
        return nil
    }

    let pointMargins = turnAndDeployLocals.map {
        abs(signedCrossTrackDistanceFt(frame: frame, point: $0)) - corridorHalfWidthFt
    }
    let corridorMarginFt = (pointMargins + segmentMargins).min() ?? 0
    let exitToJumpRunErrorFt = abs(signedCrossTrackDistanceFt(frame: frame, point: exitLocal))
    let deployEnvelopeMarginFt = maxRadiusFt - radiusFt

    return CandidateEvaluation(
        bearingDeg: bearingDeg,
        radiusFt: radiusFt,
        maxRadiusFt: maxRadiusFt,
        deployPoint: routeWaypoints[3],
        exitPoint: exitPoint,
        turnPoints: [turn1Point, turn2Point],
        routeWaypoints: routeWaypoints,
        routeSegments: routeOutput.segments,
        warnings: routeWarnings,
        exitToJumpRunErrorFt: exitToJumpRunErrorFt,
        corridorMarginFt: corridorMarginFt,
        deployEnvelopeMarginFt: deployEnvelopeMarginFt,
        exitAlongRunFt: alongJumpRunDistanceFt(frame: frame, point: exitLocal)
    )
}

private func refineCandidate(
    input: WingsuitAutoInput,
    frame: JumpRunFrame,
    turnRatios: WingsuitAutoTurnRatios,
    tuning: ResolvedWingsuitAutoTuning,
    canopyEnvelopeLocal: [LocalPoint],
    preferredBearingDeg: Double,
    bestCandidate: CandidateEvaluation
) -> CandidateEvaluation {
    var current = bestCandidate
    var bearingStepDeg = tuning.deployBearingStepDeg / 2
    var radiusStepFt = tuning.deployRadiusStepFt / 2
    var iteration = 0.0

    while iteration < tuning.refinementIterations {
        var improved = current

        for bearingDelta in [-bearingStepDeg, 0, bearingStepDeg] {
            let nextBearingDeg = normalizeHeading(current.bearingDeg + bearingDelta)
            let maxRadiusFt = rayPolygonRadiusFt(points: canopyEnvelopeLocal, bearingDeg: nextBearingDeg)
            if maxRadiusFt <= 0 {
                continue
            }

            for radiusDelta in [-radiusStepFt, 0, radiusStepFt] {
                let nextRadiusFt = clamp(
                    current.radiusFt + radiusDelta,
                    min: tuning.minDeployRadiusFt,
                    max: maxRadiusFt
                )
                guard let candidate = evaluateDeployCandidate(
                    input: input,
                    frame: frame,
                    turnRatios: turnRatios,
                    corridorHalfWidthFt: tuning.corridorHalfWidthFt,
                    bearingDeg: nextBearingDeg,
                    radiusFt: nextRadiusFt,
                    maxRadiusFt: maxRadiusFt
                ) else {
                    continue
                }
                if compareCandidatesWithPreferredBearing(candidate, improved, preferredBearingDeg: preferredBearingDeg) < 0 {
                    improved = candidate
                }
            }
        }

        current = improved
        bearingStepDeg /= 2
        radiusStepFt /= 2
        iteration += 1
    }

    return current
}

private func emptyAutoOutput(
    landingPoint: WingsuitAutoWaypoint,
    forbiddenZonePolygon: [GeoPoint],
    diagnostics: WingsuitAutoDiagnostics,
    warnings: [String]
) -> WingsuitAutoOutput {
    WingsuitAutoOutput(
        blocked: true,
        warnings: warnings,
        landingPoint: landingPoint,
        deployPoint: nil,
        exitPoint: nil,
        turnPoints: [],
        routeWaypoints: [],
        routeSegments: [],
        forbiddenZonePolygon: forbiddenZonePolygon,
        feasibleDeployRegionPolygon: [],
        deployBandsByBearing: [],
        diagnostics: diagnostics
    )
}

public func solveWingsuitAuto(_ input: WingsuitAutoInput) -> WingsuitAutoOutput {
    let validation = validateWingsuitAutoInput(input)
    let turnRatios = resolveTurnRatios(input.turnRatios)
    let tuning = resolveWingsuitAutoTuning(input.tuning)
    let landingPoint = createAutoWaypoint(name: .landing, point: input.landingPoint, altFt: 0)
    let jumpRunFrame = buildJumpRunFrame(landingPoint: input.landingPoint, jumpRun: input.jumpRun)
    let turnHeightsFt = deriveTurnHeightsFt(input: input, ratios: turnRatios)

    if !validation.valid || jumpRunFrame == nil {
        let failureReason = validation.errors.first ?? "Wingsuit auto input is invalid."
        return emptyAutoOutput(
            landingPoint: landingPoint,
            forbiddenZonePolygon: [],
            diagnostics: WingsuitAutoDiagnostics(
                preferredDeployBearingDeg: nil,
                selectedDeployBearingDeg: nil,
                selectedDeployRadiusFt: nil,
                exitToJumpRunErrorFt: nil,
                deployEnvelopeMarginFt: nil,
                corridorMarginFt: nil,
                turnHeightsFt: turnHeightsFt,
                failureReason: failureReason
            ),
            warnings: validation.warnings + validation.errors
        )
    }

    let resolvedJumpRunFrame = jumpRunFrame!
    let canopyEnvelopeLocal = buildCanopyEnvelopeLocalPoints(input: input, tuning: tuning)
    let envelopeMaxRadiusFt = canopyEnvelopeLocal.reduce(0) { max($0, localPointMagnitude($1)) }
    let forbiddenZonePolygon = buildForbiddenZonePolygon(
        landingPoint: input.landingPoint,
        frame: resolvedJumpRunFrame,
        corridorHalfWidthFt: tuning.corridorHalfWidthFt,
        extentFt: max(envelopeMaxRadiusFt, resolvedJumpRunFrame.lengthFt)
    )

    let lowestWindLayer = input.winds.sorted { $0.altitudeFt < $1.altitudeFt }.first
    let preferredBearingDeg = lowestWindLayer.map { normalizeHeading($0.dirFromDeg) }

    guard let preferredBearingDeg else {
        return emptyAutoOutput(
            landingPoint: landingPoint,
            forbiddenZonePolygon: forbiddenZonePolygon,
            diagnostics: WingsuitAutoDiagnostics(
                preferredDeployBearingDeg: nil,
                selectedDeployBearingDeg: nil,
                selectedDeployRadiusFt: nil,
                exitToJumpRunErrorFt: nil,
                deployEnvelopeMarginFt: nil,
                corridorMarginFt: nil,
                turnHeightsFt: turnHeightsFt,
                failureReason: "Wind model missing required altitude coverage."
            ),
            warnings: validation.warnings + ["Wind model missing required altitude coverage."]
        )
    }

    let searchBearings = buildBearingSweep(
        preferredBearingDeg: preferredBearingDeg,
        stepDeg: tuning.deployBearingStepDeg,
        windowHalfDeg: tuning.deployBearingWindowHalfDeg
    )
    var validCandidates: [CandidateEvaluation] = []
    var bandsByBearing: [Double: RadiusBand] = [:]
    var anyCanopyReachable = false
    var anyOutsideCorridor = false

    for bearingDeg in searchBearings {
        let maxRadiusFt = rayPolygonRadiusFt(points: canopyEnvelopeLocal, bearingDeg: bearingDeg)
        if maxRadiusFt <= 0 {
            continue
        }
        anyCanopyReachable = true

        let startRadiusFt = min(maxRadiusFt, max(tuning.minDeployRadiusFt, tuning.deployRadiusStepFt))
        var radiusFt = startRadiusFt
        while radiusFt <= maxRadiusFt + epsilon {
            let deployLocal = scaleLocalPoint(pointToUnitVector(headingDeg: bearingDeg), radiusFt)
            let deployCrossTrackFt = signedCrossTrackDistanceFt(frame: resolvedJumpRunFrame, point: deployLocal)
            let deployOutsideCorridor = input.side == .left
                ? deployCrossTrackFt > tuning.corridorHalfWidthFt
                : deployCrossTrackFt < -tuning.corridorHalfWidthFt
            if deployOutsideCorridor {
                anyOutsideCorridor = true
                if let candidate = evaluateDeployCandidate(
                    input: input,
                    frame: resolvedJumpRunFrame,
                    turnRatios: turnRatios,
                    corridorHalfWidthFt: tuning.corridorHalfWidthFt,
                    bearingDeg: bearingDeg,
                    radiusFt: radiusFt,
                    maxRadiusFt: maxRadiusFt
                ) {
                    validCandidates.append(candidate)
                    let key = (normalizeHeading(bearingDeg) * 1_000_000).rounded() / 1_000_000
                    if var existing = bandsByBearing[key] {
                        existing.minRadiusFt = min(existing.minRadiusFt, radiusFt)
                        existing.maxRadiusFt = max(existing.maxRadiusFt, radiusFt)
                        bandsByBearing[key] = existing
                    } else {
                        bandsByBearing[key] = RadiusBand(
                            bearingDeg: key,
                            minRadiusFt: radiusFt,
                            maxRadiusFt: radiusFt
                        )
                    }
                }
            }
            radiusFt += tuning.deployRadiusStepFt
        }
    }

    if validCandidates.isEmpty {
        var failureReason = "No deploy point survives route solving on the selected side."
        if !anyCanopyReachable {
            failureReason = "No deploy point survives canopy reachability."
        } else if !anyOutsideCorridor {
            failureReason = "No deploy point survives jump-run corridor exclusion."
        }

        return emptyAutoOutput(
            landingPoint: landingPoint,
            forbiddenZonePolygon: forbiddenZonePolygon,
            diagnostics: WingsuitAutoDiagnostics(
                preferredDeployBearingDeg: preferredBearingDeg,
                selectedDeployBearingDeg: nil,
                selectedDeployRadiusFt: nil,
                exitToJumpRunErrorFt: nil,
                deployEnvelopeMarginFt: nil,
                corridorMarginFt: nil,
                turnHeightsFt: turnHeightsFt,
                failureReason: failureReason
            ),
            warnings: validation.warnings + [failureReason]
        )
    }

    var bestCandidate = validCandidates.dropFirst().reduce(validCandidates[0]) { best, candidate in
        compareCandidatesWithPreferredBearing(candidate, best, preferredBearingDeg: preferredBearingDeg) < 0 ? candidate : best
    }

    bestCandidate = refineCandidate(
        input: input,
        frame: resolvedJumpRunFrame,
        turnRatios: turnRatios,
        tuning: tuning,
        canopyEnvelopeLocal: canopyEnvelopeLocal,
        preferredBearingDeg: preferredBearingDeg,
        bestCandidate: bestCandidate
    )

    let deployBandsByBearing = bandsByBearing.values.sorted { $0.bearingDeg < $1.bearingDeg }
    let feasibleDeployRegionPolygon = buildBandsPolygon(landingPoint: input.landingPoint, bands: deployBandsByBearing)
    var warnings = validation.warnings + bestCandidate.warnings
    if bestCandidate.exitToJumpRunErrorFt > tuning.exitOnJumpRunToleranceFt {
        warnings.append(
            "Exit remains \(String(format: "%.0f", bestCandidate.exitToJumpRunErrorFt)) ft from jump run; adjust landing point or expand search."
        )
    }

    return WingsuitAutoOutput(
        blocked: false,
        warnings: warnings,
        landingPoint: landingPoint,
        deployPoint: bestCandidate.deployPoint,
        exitPoint: bestCandidate.exitPoint,
        turnPoints: bestCandidate.turnPoints,
        routeWaypoints: bestCandidate.routeWaypoints,
        routeSegments: bestCandidate.routeSegments,
        forbiddenZonePolygon: forbiddenZonePolygon,
        feasibleDeployRegionPolygon: feasibleDeployRegionPolygon,
        deployBandsByBearing: deployBandsByBearing,
        diagnostics: WingsuitAutoDiagnostics(
            preferredDeployBearingDeg: preferredBearingDeg,
            selectedDeployBearingDeg: bestCandidate.bearingDeg,
            selectedDeployRadiusFt: bestCandidate.radiusFt,
            exitToJumpRunErrorFt: bestCandidate.exitToJumpRunErrorFt,
            deployEnvelopeMarginFt: bestCandidate.deployEnvelopeMarginFt,
            corridorMarginFt: bestCandidate.corridorMarginFt,
            turnHeightsFt: turnHeightsFt,
            failureReason: nil
        )
    )
}
