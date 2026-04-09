import Foundation

private let wlMax: Double = 1.7
private let minFinalForwardGroundSpeedKt: Double = 5
private let airspeedMinKtDefault: Double = 8
private let airspeedMaxKtDefault: Double = 35

private struct LocalPoint {
    let eastFt: Double
    let northFt: Double
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

private func computeAirspeedKt(_ input: PatternInput, wingLoading: Double) -> Double {
    let ratio = wingLoading / input.canopy.wlRef
    let exponent = input.canopy.airspeedWlExponent ?? 0.5
    let raw = input.canopy.airspeedRefKt * pow(max(ratio, 1e-6), exponent)
    let minKt = input.canopy.airspeedMinKt ?? airspeedMinKtDefault
    let maxKt = input.canopy.airspeedMaxKt ?? airspeedMaxKtDefault
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
            headingDeg: computeLegHeading(landingHeadingDeg: input.landingHeadingDeg, side: input.side, segment: .downwind),
            startAltFt: downwindGate,
            endAltFt: baseGate,
            solveKind: .trackLocked
        ),
        SegmentDefinition(
            name: .base,
            headingDeg: computeLegHeading(landingHeadingDeg: input.landingHeadingDeg, side: input.side, segment: .base),
            startAltFt: baseGate,
            endAltFt: finalGate,
            solveKind: baseLegDrift ? .drift : .trackLocked
        ),
        SegmentDefinition(
            name: .final,
            headingDeg: computeLegHeading(landingHeadingDeg: input.landingHeadingDeg, side: input.side, segment: .final),
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
        return SegmentSolveResult(segment: nil, blockedReason: "\(name.rawValue) leg has near-zero along-track ground speed.")
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
        if !input.jumper.exitWeightLb.isFinite || !input.jumper.canopyAreaSqft.isFinite || input.jumper.exitWeightLb <= 0 || input.jumper.canopyAreaSqft <= 0 {
            errors.append("Exit weight and canopy area must be finite and positive.")
        }

        if !input.canopy.wlRef.isFinite || !input.canopy.airspeedRefKt.isFinite || !input.canopy.glideRatio.isFinite || input.canopy.wlRef <= 0 || input.canopy.airspeedRefKt <= 0 || input.canopy.glideRatio <= 0 {
            errors.append("Canopy reference values must be finite and positive.")
        }

        let hasNonFiniteCanopyTuning =
            (input.canopy.airspeedWlExponent?.isFinite == false) ||
            (input.canopy.airspeedMinKt?.isFinite == false) ||
            (input.canopy.airspeedMaxKt?.isFinite == false)
        if hasNonFiniteCanopyTuning {
            errors.append("Canopy tuning values must be finite when provided.")
        }
    } else if !input.wingsuit.flightSpeedKt.isFinite || !input.wingsuit.fallRateFps.isFinite || input.wingsuit.flightSpeedKt <= 0 || input.wingsuit.fallRateFps <= 0 {
        errors.append("Wingsuit flight speed and fall rate must be finite and positive.")
    }

    if input.gatesFt.count != 4 {
        errors.append("Gate altitudes must contain exactly 4 values.")
    } else if !input.gatesFt.allSatisfy({ $0.isFinite }) {
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

    if !validation.valid {
        return PatternOutput(
            waypoints: [PatternWaypoint(name: .touchdown, lat: input.touchdownLat, lng: input.touchdownLng, altFt: input.gatesFt.last ?? 0)],
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
        ? computeAirspeedKt(input, wingLoading: wingLoading ?? 0)
        : input.wingsuit.flightSpeedKt
    let sinkFps = input.mode == .canopy
        ? computeSinkFps(airspeedKt: airspeedKt, glideRatio: input.canopy.glideRatio)
        : input.wingsuit.fallRateFps

    if input.mode == .canopy, let wingLoading, wingLoading > wlMax {
        warnings.append("Wing loading \(String(format: "%.2f", wingLoading)) exceeds model limit (\(String(format: "%.1f", wlMax))). Pattern output is disabled.")
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
        warnings.append("\(segment.name.rawValue.capitalized) leg tracks backward (\(String(format: "%.1f", segment.alongLegSpeedKt)) kt).")
    }

    let finalForwardSpeedKt = activeSegments.first(where: { $0.name == .final })?.alongLegSpeedKt ?? 0
    if finalForwardSpeedKt < minFinalForwardGroundSpeedKt {
        warnings.append("Final-leg penetration is low (\(String(format: "%.1f", finalForwardSpeedKt)) kt along final). Consider a safer landing direction.")
    }

    let blocked =
        (input.mode == .canopy && (wingLoading ?? 0) > wlMax) ||
        !sinkFps.isFinite ||
        sinkFps <= 0 ||
        activeSegments.count != activeDefinitions.count

    let metrics = PatternMetrics(wingLoading: wingLoading, estAirspeedKt: airspeedKt, estSinkFps: sinkFps)

    if blocked {
        return PatternOutput(
            waypoints: [PatternWaypoint(name: .touchdown, lat: input.touchdownLat, lng: input.touchdownLng, altFt: input.gatesFt[3])],
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
        let geo = localFeetToLatLng(refLat: input.touchdownLat, refLng: input.touchdownLng, eastFt: point.eastFt, northFt: point.northFt)
        return PatternWaypoint(name: waypointName(for: definition.name), lat: geo.lat, lng: geo.lng, altFt: definition.startAltFt)
    }

    let touchdownGeo = localFeetToLatLng(refLat: input.touchdownLat, refLng: input.touchdownLng, eastFt: touchdown.eastFt, northFt: touchdown.northFt)

    return PatternOutput(
        waypoints: waypoints + [PatternWaypoint(name: .touchdown, lat: touchdownGeo.lat, lng: touchdownGeo.lng, altFt: input.gatesFt[3])],
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
