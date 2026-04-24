import Foundation

// MARK: - Bearing Sweep

func buildBearingSweep(preferredBearingDeg: Double, stepDeg: Double, windowHalfDeg: Double) -> [Double] {
    let count = max(1, Int(floor((windowHalfDeg * 2) / stepDeg)))
    var deduped = [Double]()
    for index in 0...count {
        let offsetDeg = -windowHalfDeg + Double(index) * stepDeg
        let rounded = (normalizeHeading(preferredBearingDeg + offsetDeg) * 1_000_000).rounded() / 1_000_000
        if !deduped.contains(where: { abs($0 - rounded) <= 1e-9 }) { deduped.append(rounded) }
    }
    return deduped
}



func computeForwardDriftLeg(
    _ leg: ForwardRouteLeg, startPoint: LocalPoint,
    winds: [WindLayer], airspeedKt: Double, fallRateFps: Double
) -> (leg: ForwardRouteLegResult?, blockedReason: String?) {
    let altLoss = leg.startAltFt - leg.endAltFt
    guard altLoss > 0, fallRateFps > 0 else {
        return (nil, "\(leg.name.rawValue) leg has invalid altitude or fall-rate inputs.")
    }
    let totalTimeSec = altLoss / fallRateFps
    let stepCount = max(1, Int(ceil(totalTimeSec / forwardIntegrationMaxStepSec)))
    let stepAltLoss = altLoss / Double(stepCount)
    let airUnit = headingToUnitVector(leg.headingDeg)
    let airVec = scaleVec(airUnit, airspeedKt)
    var current = startPoint
    var distanceFt = 0.0
    for i in 0..<stepCount {
        let stepStartAlt = leg.startAltFt - stepAltLoss * Double(i)
        let sampleAlt = stepStartAlt - stepAltLoss / 2
        let wind = getWindForAltitude(sampleAlt, winds: winds)
        let wv = wind.map { windFromToGroundVector(speedKt: $0.speedKt, dirFromDeg: $0.dirFromDeg) } ?? (east: 0.0, north: 0.0)
        let gv = addVec(Vec2(east: airVec.east, north: airVec.north), Vec2(east: wv.east, north: wv.north))
        let stepTime = stepAltLoss / fallRateFps
        let disp = LocalPoint(eastFt: gv.east * knotsToFeetPerSecond(1) * stepTime,
                              northFt: gv.north * knotsToFeetPerSecond(1) * stepTime)
        current = localPointAdd(current, disp)
        distanceFt += localPointMagnitude(disp)
    }
    let totalDisp = localPointDifference(current, startPoint)
    let avgGV = Vec2(east: totalDisp.eastFt / max(knotsToFeetPerSecond(1) * totalTimeSec, 1e-6),
                     north: totalDisp.northFt / max(knotsToFeetPerSecond(1) * totalTimeSec, 1e-6))
    let gs = magnitude(avgGV)
    guard gs >= 0.1 else {
        return (nil, "\(leg.name.rawValue) leg has near-zero ground speed.")
    }
    let seg = ForwardSegmentComputation(
        name: leg.name, headingDeg: leg.headingDeg,
        trackHeadingDeg: vectorToHeadingDeg(avgGV),
        alongLegSpeedKt: dot(avgGV, airUnit),
        groundSpeedKt: gs, timeSec: totalTimeSec, distanceFt: distanceFt)
    return (ForwardRouteLegResult(segment: seg, start: startPoint, end: current), nil)
}

func simulateForwardRoute(
    _ legs: [ForwardRouteLeg], startPoint: LocalPoint, input: WingsuitAutoInput
) -> (legs: [ForwardRouteLegResult], blockedReason: String?) {
    var results: [ForwardRouteLegResult] = []
    var current = startPoint
    for leg in legs {
        let solved = computeForwardDriftLeg(leg, startPoint: current,
            winds: input.winds, airspeedKt: input.wingsuit.flightSpeedKt,
            fallRateFps: input.wingsuit.fallRateFps)
        guard let r = solved.leg else {
            return (results, solved.blockedReason ?? "\(leg.name.rawValue) leg could not be solved.")
        }
        results.append(r)
        current = r.end
    }
    return (results, nil)
}

// MARK: - Corridor / Side / Polygon Checks

func pointToCorridorMarginFt(_ frame: JumpRunFrame, _ point: LocalPoint, _ corridorHalfWidthFt: Double) -> Double {
    let along = alongJumpRunDistanceFt(frame: frame, point: point)
    let cross = abs(signedCrossTrackDistanceFt(frame: frame, point: point))
    if along < 0 {
        return cross <= corridorHalfWidthFt ? -along : hypot(-along, cross - corridorHalfWidthFt)
    }
    if along > frame.lengthFt {
        return cross <= corridorHalfWidthFt ? along - frame.lengthFt : hypot(along - frame.lengthFt, cross - corridorHalfWidthFt)
    }
    return cross - corridorHalfWidthFt
}

func pointIsOnSelectedSide(_ point: LocalPoint, _ frame: JumpRunFrame, _ side: PatternSide) -> Bool {
    let ct = signedCrossTrackDistanceFt(frame: frame, point: point)
    return side == .left ? ct > 0 : ct < 0
}

func segmentOutsideFiniteCorridor(
    _ frame: JumpRunFrame, _ startPt: LocalPoint, _ endPt: LocalPoint,
    _ corridorHalfWidthFt: Double, _ side: PatternSide, _ samples: Int = 12
) -> (valid: Bool, marginFt: Double) {
    var minMargin = Double.infinity
    for i in 0...samples {
        let t = Double(i) / Double(samples)
        let pt = interpolateLocalPoint(startPt, endPt, t)
        guard pointIsOnSelectedSide(pt, frame, side) else { return (false, -.infinity) }
        let m = pointToCorridorMarginFt(frame, pt, corridorHalfWidthFt)
        guard m > 0 else { return (false, m) }
        minMargin = min(minMargin, m)
    }
    return (true, minMargin)
}

func isStrictThreeLegGate(_ c: AutoGateCandidate) -> Bool {
    c.gatesFt[0] > c.gatesFt[1] && c.gatesFt[1] > c.gatesFt[2] && c.gatesFt[2] > c.gatesFt[3]
}

// MARK: - Gate Candidates

func buildAutoGateCandidates(_ input: WingsuitAutoInput, _ ratios: WingsuitAutoTurnRatios) -> [AutoGateCandidate] {
    let span = input.exitHeightFt - input.deployHeightFt
    let pref = buildAutoGatesFt(input: input, ratios: ratios)
    var candidates = [AutoGateCandidate(gatesFt: pref, turnHeightsFt: [pref[1], pref[2]])]
    let pd1 = 1 - ratios.turn1; let pd2 = ratios.turn1 - ratios.turn2
    let fracs: [(Double, Double)] = [
        (pd1 - 0.07, pd2 + 0.08), (pd1 + 0.07, pd2 - 0.08),
        (0.18, 0.35), (0.18, 0.44), (0.25, 0.44), (0.25, 0.52), (0.32, 0.35), (0.32, 0.44)]
    for (rd1, rd2) in fracs {
        let d1 = clamp(rd1, min: 0.1, max: 0.6)
        let d2 = clamp(rd2, min: 0.2, max: 0.7)
        let d3 = 1 - d1 - d2
        guard d1 > 0, d2 > 0, d3 >= 0.15 else { continue }
        let t1r = 1 - d1; let t2r = d3
        let t1 = input.deployHeightFt + span * t1r; let t2 = input.deployHeightFt + span * t2r
        candidates.append(AutoGateCandidate(gatesFt: [input.exitHeightFt, t1, t2, input.deployHeightFt], turnHeightsFt: [t1, t2]))
    }
    var deduped = [String: AutoGateCandidate]()
    for c in candidates { deduped[c.gatesFt.map { String(format: "%.2f", $0) }.joined(separator: "|")] = c }
    return Array(deduped.values)
}

func buildDistanceAutoGateCandidates(_ input: WingsuitAutoInput) -> [AutoGateCandidate] {
    let span = input.exitHeightFt - input.deployHeightFt
    var candidates = [AutoGateCandidate]()
    let fracs: [(Double, Double)] = [
        (0.06, 0.47), (0.08, 0.46), (0.1, 0.45), (0.12, 0.44), (0.15, 0.42),
        (0.18, 0.4), (0.22, 0.38), (0.28, 0.34), (0.34, 0.3), (0.45, 0.25), (0.55, 0.2)]
    for (d1, d2) in fracs {
        let d3 = 1 - d1 - d2
        guard d1 > 0, d2 > 0, d3 >= 0.25 else { continue }
        let t1 = input.deployHeightFt + span * (1 - d1)
        let t2 = input.deployHeightFt + span * d3
        candidates.append(AutoGateCandidate(gatesFt: [input.exitHeightFt, t1, t2, input.deployHeightFt], turnHeightsFt: [t1, t2]))
    }
    var deduped = [String: AutoGateCandidate]()
    for c in candidates { deduped[c.gatesFt.map { String(format: "%.2f", $0) }.joined(separator: "|")] = c }
    return Array(deduped.values)
}

// MARK: - Heading Candidates

private func uniqueNormalized(_ headings: [Double]) -> [Double] {
    var result = [Double]()
    for h in headings {
        let n = (normalizeHeading(h) * 1e6).rounded() / 1e6
        if !result.contains(where: { abs($0 - n) < 1e-9 }) { result.append(n) }
    }
    return result
}

func buildFirstLegHeadingCandidates(_ jumpRunHeadingDeg: Double, _ side: PatternSide, _ maxDelta: Double) -> [Double] {
    let s: Double = side == .left ? -1 : 1
    var deltas = [0.0, 10, 20, 30, 40, 45].filter { $0 <= maxDelta + 1e-6 }
    if maxDelta >= 0 && !deltas.contains(where: { abs($0 - maxDelta) < 1e-6 }) { deltas.append(maxDelta) }
    return uniqueNormalized(deltas.filter { $0 >= 0 }.sorted().map { jumpRunHeadingDeg + s * $0 })
}

func buildOffsetHeadingCandidates(_ jumpRunHeadingDeg: Double, _ side: PatternSide) -> [Double] {
    let s: Double = side == .left ? -1 : 1
    return uniqueNormalized([60, 75, 90, 105, 120, 135].map { jumpRunHeadingDeg + s * $0 })
}

func buildReturnHeadingCandidates(_ jumpRunHeadingDeg: Double, _ side: PatternSide, _ turn2Local: LocalPoint?) -> [Double] {
    let rs: Double = side == .left ? 1 : -1
    var headings = [120.0, 135, 150, 165, 180, 195, 210].map { jumpRunHeadingDeg + rs * $0 }
    if let t2 = turn2Local, localPointMagnitude(t2) > 1e-6 {
        let direct = vectorToHeadingDeg(Vec2(east: -t2.eastFt, north: -t2.northFt))
        headings.append(contentsOf: [direct, direct - 15, direct + 15])
    }
    return uniqueNormalized(headings)
}

func buildDistanceFirstLegHeadingCandidates(_ distRunHeadingDeg: Double, _ side: PatternSide, _ maxDelta: Double) -> [Double] {
    let s: Double = side == .left ? -1 : 1
    let deltas = [0.0, 5, 10, 15, 20, 30, 40].filter { $0 <= maxDelta + 1e-6 }
    return uniqueNormalized(deltas.map { distRunHeadingDeg + s * $0 })
}

func buildDistanceReturnHeadingCandidates(_ normalHeadingDeg: Double?) -> [Double] {
    let rh = normalizeHeading((normalHeadingDeg ?? 0) + 180)
    return uniqueNormalized([-35.0, -25, -15, -5, 0, 5, 15, 25, 35].map { rh + $0 })
}

// MARK: - Canopy Return Margin

func computeCanopyReturnMarginFt(_ input: WingsuitAutoInput, _ deployLocal: LocalPoint) -> Double {
    let dist = localPointMagnitude(deployLocal)
    if dist <= 1e-6 {
        return input.deployHeightFt - forwardCanopyDeploymentLossFt - forwardCanopyPatternReserveFt
    }
    let returnUnit = normalizeLocalPoint(scaleLocalPoint(deployLocal, -1))
    let sampleAlt = max(0, input.deployHeightFt / 2)
    let wind = getWindForAltitude(sampleAlt, winds: input.winds)
    let wv = wind.map { windFromToGroundVector(speedKt: $0.speedKt, dirFromDeg: $0.dirFromDeg) } ?? (east: 0.0, north: 0.0)
    let windAlongKt = dot(Vec2(east: wv.east, north: wv.north), localPointToVec(returnUnit))
    let gs = forwardCanopyAirspeedKt + windAlongKt
    guard gs > 5 else { return -.infinity }
    let sinkFps = knotsToFeetPerSecond(forwardCanopyAirspeedKt) / forwardCanopyGlideRatio
    let returnTime = dist / knotsToFeetPerSecond(gs)
    let altLost = forwardCanopyDeploymentLossFt + sinkFps * returnTime
    return input.deployHeightFt - forwardCanopyPatternReserveFt - altLost
}

// MARK: - Zone Polygons

func buildCirclePolygon(_ landingPoint: GeoPoint, _ radiusFt: Double, _ points: Int = 36) -> [GeoPoint] {
    (0..<points).map { i in
        let bearing = Double(i) / Double(points) * 360
        return geoPointFromLocal(reference: landingPoint, point: scaleLocalPoint(pointToUnitVector(headingDeg: bearing), radiusFt))
    }
}

func buildHalfDiskPolygon(_ landingPoint: GeoPoint, _ centerBearingDeg: Double, _ radiusFt: Double, _ points: Int = 24) -> [GeoPoint] {
    var polygon = [landingPoint]
    for i in 0...points {
        let t = Double(i) / Double(points)
        let bearing = normalizeHeading(centerBearingDeg - 90 + t * 180)
        polygon.append(geoPointFromLocal(reference: landingPoint, point: scaleLocalPoint(pointToUnitVector(headingDeg: bearing), radiusFt)))
    }
    return polygon
}

func buildForbiddenZonePolygonAuto(
    _ landingPoint: GeoPoint, _ frame: JumpRunFrame, _ corridorHalfWidthFt: Double, _ extentFt: Double
) -> [GeoPoint] {
    let ext = extentFt + frame.lengthFt
    let se = localPointAdd(frame.start, scaleLocalPoint(frame.unit, -ext))
    let ee = localPointAdd(frame.end, scaleLocalPoint(frame.unit, ext))
    let lo = scaleLocalPoint(frame.leftUnit, corridorHalfWidthFt)
    return [
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(se, lo)),
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(ee, lo)),
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(ee, scaleLocalPoint(lo, -1))),
        geoPointFromLocal(reference: landingPoint, point: localPointAdd(se, scaleLocalPoint(lo, -1))),
    ]
}

func buildBandsPolygonAuto(_ landingPoint: GeoPoint, _ bands: [RadiusBand]) -> [GeoPoint] {
    guard !bands.isEmpty else { return [] }
    let outer = bands.map { b in geoPointFromLocal(reference: landingPoint, point: scaleLocalPoint(pointToUnitVector(headingDeg: b.bearingDeg), b.maxRadiusFt)) }
    let inner = bands.reversed().map { b in geoPointFromLocal(reference: landingPoint, point: scaleLocalPoint(pointToUnitVector(headingDeg: b.bearingDeg), max(0, b.minRadiusFt))) }
    return outer + inner
}
