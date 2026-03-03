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

private func findRequiredWinds(gatesFt: [Double], winds: [WindLayer]) -> [String] {
    guard gatesFt.count >= 3 else { return ["Gate altitudes must contain at least 4 values."] }
    let required = [gatesFt[0], gatesFt[1], gatesFt[2]]
    var errors: [String] = []
    for altitude in required where getWindForAltitude(altitude, winds: winds) == nil {
        errors.append("Missing wind layer around \(Int(round(altitude))) ft.")
    }
    return errors
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
            blockedReason: "\(name.rawValue) leg crosswind (\(String(format: "%.1f", abs(windCross))) kt) exceeds canopy airspeed capability."
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

public func validatePatternInput(_ input: PatternInput) -> ValidationResult {
    var errors: [String] = []
    var warnings: [String] = []

    if !input.touchdownLat.isFinite || !input.touchdownLng.isFinite {
        errors.append("Touchdown location must be valid latitude/longitude values.")
    }

    if !input.landingHeadingDeg.isFinite {
        errors.append("Landing heading must be a finite degree value.")
    }

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

    if input.gatesFt.count != 4 {
        errors.append("Gate altitudes must contain exactly 4 values.")
    } else if !input.gatesFt.allSatisfy({ $0.isFinite }) {
        errors.append("Gate altitudes must be finite numeric values.")
    } else {
        let downwind = input.gatesFt[0]
        let base = input.gatesFt[1]
        let final = input.gatesFt[2]
        let touchdown = input.gatesFt[3]
        if !(downwind > base && base > final && final > touchdown) {
            errors.append("Gate altitudes must be strictly descending, for example 900 > 600 > 300 > 0.")
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

    errors.append(contentsOf: findRequiredWinds(gatesFt: input.gatesFt, winds: input.winds))
    return ValidationResult(valid: errors.isEmpty, errors: errors, warnings: warnings)
}

public func computePattern(_ input: PatternInput) -> PatternOutput {
    let validation = validatePatternInput(input)
    var warnings = validation.warnings

    if !validation.valid {
        return PatternOutput(
            waypoints: [PatternWaypoint(name: .touchdown, lat: input.touchdownLat, lng: input.touchdownLng, altFt: input.gatesFt.last ?? 0)],
            segments: [],
            metrics: PatternMetrics(wingLoading: 0, estAirspeedKt: 0, estSinkFps: 0),
            warnings: warnings + validation.errors,
            blocked: true
        )
    }

    let wingLoading = computeWingLoading(exitWeightLb: input.jumper.exitWeightLb, canopyAreaSqft: input.jumper.canopyAreaSqft)
    let airspeedKt = computeAirspeedKt(input, wingLoading: wingLoading)
    let sinkFps = computeSinkFps(airspeedKt: airspeedKt, glideRatio: input.canopy.glideRatio)

    if wingLoading > wlMax {
        warnings.append("Wing loading \(String(format: "%.2f", wingLoading)) exceeds model limit (\(String(format: "%.1f", wlMax))). Pattern output is disabled.")
    }

    let downwindHeading = computeLegHeading(landingHeadingDeg: input.landingHeadingDeg, side: input.side, segment: .downwind)
    let baseHeading = computeLegHeading(landingHeadingDeg: input.landingHeadingDeg, side: input.side, segment: .base)
    let finalHeading = computeLegHeading(landingHeadingDeg: input.landingHeadingDeg, side: input.side, segment: .final)
    let baseLegDrift = input.baseLegDrift ?? true

    let downwindResult = computeTrackLockedSegment(
        name: .downwind,
        trackHeadingDeg: downwindHeading,
        segmentStartAltFt: input.gatesFt[0],
        segmentEndAltFt: input.gatesFt[1],
        winds: input.winds,
        airspeedKt: airspeedKt,
        sinkFps: sinkFps
    )

    let baseResult: SegmentSolveResult = baseLegDrift
        ? computeDriftSegment(
            name: .base,
            headingDeg: baseHeading,
            segmentStartAltFt: input.gatesFt[1],
            segmentEndAltFt: input.gatesFt[2],
            winds: input.winds,
            airspeedKt: airspeedKt,
            sinkFps: sinkFps
        )
        : computeTrackLockedSegment(
            name: .base,
            trackHeadingDeg: baseHeading,
            segmentStartAltFt: input.gatesFt[1],
            segmentEndAltFt: input.gatesFt[2],
            winds: input.winds,
            airspeedKt: airspeedKt,
            sinkFps: sinkFps
        )

    let finalResult = computeTrackLockedSegment(
        name: .final,
        trackHeadingDeg: finalHeading,
        segmentStartAltFt: input.gatesFt[2],
        segmentEndAltFt: input.gatesFt[3],
        winds: input.winds,
        airspeedKt: airspeedKt,
        sinkFps: sinkFps
    )

    if let reason = downwindResult.blockedReason { warnings.append(reason) }
    if let reason = baseResult.blockedReason { warnings.append(reason) }
    if let reason = finalResult.blockedReason { warnings.append(reason) }

    let downwind = downwindResult.segment
    let base = baseResult.segment
    let final = finalResult.segment

    if let downwind = downwind, downwind.alongLegSpeedKt < 0 {
        warnings.append("Downwind leg tracks backward (\(String(format: "%.1f", downwind.alongLegSpeedKt)) kt).")
    }
    if let base = base, base.alongLegSpeedKt < 0 {
        warnings.append("Base leg tracks backward (\(String(format: "%.1f", base.alongLegSpeedKt)) kt).")
    }
    if let final = final, final.alongLegSpeedKt < 0 {
        warnings.append("Final leg tracks backward (\(String(format: "%.1f", final.alongLegSpeedKt)) kt).")
    }

    let finalForwardSpeedKt = final?.alongLegSpeedKt ?? 0
    if finalForwardSpeedKt < minFinalForwardGroundSpeedKt {
        warnings.append("Final-leg penetration is low (\(String(format: "%.1f", finalForwardSpeedKt)) kt along final). Consider a safer landing direction.")
    }

    let blocked = wingLoading > wlMax || !sinkFps.isFinite || sinkFps <= 0 || downwind == nil || base == nil || final == nil

    let touchdown = LocalPoint(eastFt: 0, northFt: 0)
    let finalGroundUnit = unitOrZero(final?.groundVectorKt ?? Vec2(east: 0, north: 0))
    let downwindGroundUnit = unitOrZero(downwind?.groundVectorKt ?? Vec2(east: 0, north: 0))

    let finalDistance = final?.distanceFt ?? 0
    let finalStart = LocalPoint(
        eastFt: touchdown.eastFt - finalGroundUnit.east * finalDistance,
        northFt: touchdown.northFt - finalGroundUnit.north * finalDistance
    )

    let baseGroundUnit = unitOrZero(base?.groundVectorKt ?? Vec2(east: 0, north: 0))
    let baseDistance = base?.distanceFt ?? 0
    let baseStart = LocalPoint(
        eastFt: finalStart.eastFt - baseGroundUnit.east * baseDistance,
        northFt: finalStart.northFt - baseGroundUnit.north * baseDistance
    )

    let downwindDistance = downwind?.distanceFt ?? 0
    let downwindStart = LocalPoint(
        eastFt: baseStart.eastFt - downwindGroundUnit.east * downwindDistance,
        northFt: baseStart.northFt - downwindGroundUnit.north * downwindDistance
    )

    let touchdownGeo = localFeetToLatLng(refLat: input.touchdownLat, refLng: input.touchdownLng, eastFt: touchdown.eastFt, northFt: touchdown.northFt)
    let finalStartGeo = localFeetToLatLng(refLat: input.touchdownLat, refLng: input.touchdownLng, eastFt: finalStart.eastFt, northFt: finalStart.northFt)
    let baseStartGeo = localFeetToLatLng(refLat: input.touchdownLat, refLng: input.touchdownLng, eastFt: baseStart.eastFt, northFt: baseStart.northFt)
    let downwindStartGeo = localFeetToLatLng(refLat: input.touchdownLat, refLng: input.touchdownLng, eastFt: downwindStart.eastFt, northFt: downwindStart.northFt)

    let waypoints: [PatternWaypoint] = blocked
        ? [PatternWaypoint(name: .touchdown, lat: input.touchdownLat, lng: input.touchdownLng, altFt: input.gatesFt[3])]
        : [
            PatternWaypoint(name: .downwindStart, lat: downwindStartGeo.lat, lng: downwindStartGeo.lng, altFt: input.gatesFt[0]),
            PatternWaypoint(name: .baseStart, lat: baseStartGeo.lat, lng: baseStartGeo.lng, altFt: input.gatesFt[1]),
            PatternWaypoint(name: .finalStart, lat: finalStartGeo.lat, lng: finalStartGeo.lng, altFt: input.gatesFt[2]),
            PatternWaypoint(name: .touchdown, lat: touchdownGeo.lat, lng: touchdownGeo.lng, altFt: input.gatesFt[3]),
        ]

    let segments: [SegmentOutput] = blocked
        ? []
        : [downwind!, base!, final!].map {
            SegmentOutput(
                name: $0.name,
                headingDeg: $0.headingDeg,
                trackHeadingDeg: $0.trackHeadingDeg,
                alongLegSpeedKt: $0.alongLegSpeedKt,
                groundSpeedKt: $0.groundSpeedKt,
                timeSec: $0.timeSec,
                distanceFt: $0.distanceFt
            )
        }

    return PatternOutput(
        waypoints: waypoints,
        segments: segments,
        metrics: PatternMetrics(wingLoading: wingLoading, estAirspeedKt: airspeedKt, estSinkFps: sinkFps),
        warnings: warnings,
        blocked: blocked
    )
}
