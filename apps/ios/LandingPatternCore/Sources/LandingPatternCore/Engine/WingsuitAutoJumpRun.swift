import Foundation

// MARK: - Jump Run Resolution (matches web resolveJumpRunPlan / resolveDistanceJumpRunPlan)

private func createResolvedJumpRunSlot(
    input: WingsuitAutoInput, point: LocalPoint, index: Int, totalSlots: Int
) -> ResolvedJumpRunSlot {
    let geo = geoPointFromLocal(reference: input.landingPoint, point: point)
    return ResolvedJumpRunSlot(
        lat: geo.lat, lng: geo.lng,
        label: index == totalSlots - 1 ? "WS" : "G\(index + 1)",
        index: index, kind: index == totalSlots - 1 ? "wingsuit" : "group",
        altFt: input.exitHeightFt
    )
}

func resolveJumpRunHeading(_ input: WingsuitAutoInput) -> (headingDeg: Double, headingSource: WingsuitAutoJumpRunHeadingSource, constrainedHeadingApplied: Bool)? {
    let headingSource: WingsuitAutoJumpRunHeadingSource = input.jumpRun.directionMode == .manual ? .manual : .autoHeadwind
    let lowestWind = input.winds.sorted(by: { $0.altitudeFt < $1.altitudeFt }).first
    let sourceHeadingDeg: Double? = headingSource == .manual ? input.jumpRun.manualHeadingDeg : lowestWind?.dirFromDeg
    guard let raw = sourceHeadingDeg, raw.isFinite else { return nil }
    let normalized = normalizeHeading(raw)
    guard input.jumpRun.constraintMode == .reciprocal else {
        return (normalized, headingSource, false)
    }
    guard let ch = input.jumpRun.constraintHeadingDeg, ch.isFinite else { return nil }
    let base = normalizeHeading(ch)
    let opposite = normalizeHeading(base + 180)
    let selected = absoluteHeadingDeltaDeg(normalized, base) <= absoluteHeadingDeltaDeg(normalized, opposite) ? base : opposite
    return (selected, headingSource, absoluteHeadingDeltaDeg(normalized, selected) > 1e-6)
}

func resolveJumpRunPlan(_ input: WingsuitAutoInput) -> ResolvedJumpRunPlan? {
    if resolveJumpRunPlacementMode(input.jumpRun.placementMode) == .distance {
        return resolveDistanceJumpRunPlan(input)
    }
    let assumptions = resolveJumpRunAssumptions(input.jumpRun.assumptions)
    guard let hr = resolveJumpRunHeading(input) else { return nil }
    let jumpRunUnit = pointToUnitVector(headingDeg: hr.headingDeg)
    let leftUnit = LocalPoint(eastFt: -jumpRunUnit.northFt, northFt: jumpRunUnit.eastFt)
    let exitWind = getWindForAltitude(input.exitHeightFt, winds: input.winds)
    let deployWind = getWindForAltitude(assumptions.slickDeployHeightFt, winds: input.winds) ?? exitWind
    let planeAirVec = scaleVec(localPointToVec(jumpRunUnit), assumptions.planeAirspeedKt)
    let exitWindVec = exitWind.map { windFromToGroundVector(speedKt: $0.speedKt, dirFromDeg: $0.dirFromDeg) } ?? (east: 0.0, north: 0.0)
    let planeGSKt = max(45, dot(addVec(Vec2(east: planeAirVec.east, north: planeAirVec.north), Vec2(east: exitWindVec.east, north: exitWindVec.north)), localPointToVec(jumpRunUnit)))
    let deployWindVec = deployWind.map { windFromToGroundVector(speedKt: $0.speedKt, dirFromDeg: $0.dirFromDeg) } ?? (east: 0.0, north: 0.0)
    let headwindKt = -dot(Vec2(east: deployWindVec.east, north: deployWindVec.north), localPointToVec(jumpRunUnit))
    let crosswindKt = dot(Vec2(east: deployWindVec.east, north: deployWindVec.north), localPointToVec(leftUnit))
    let preferredSpotOffset = lookupJumpRunSpotOffsetFt(headwindKt)
    let crosswindOffset = -lookupJumpRunCrosswindOffsetFt(crosswindKt)
    let priorSlickGroupCount = max(0, assumptions.groupCount - 1)
    let slickSpanFt = assumptions.groupSeparationFt * Double(max(0, priorSlickGroupCount - 1))
    let lineLengthFt = assumptions.groupSeparationFt * Double(assumptions.groupCount)
    let lineOffset = scaleLocalPoint(leftUnit, crosswindOffset)
    let slickCenterAlongMinFt = -assumptions.slickReturnRadiusFt + slickSpanFt / 2
    let slickCenterAlongMaxFt = assumptions.slickReturnRadiusFt - slickSpanFt / 2
    let preferredSlickCenter = preferredSpotOffset + assumptions.groupSeparationFt
    let slickCenterAlongFt = clamp(preferredSlickCenter, min: slickCenterAlongMinFt, max: slickCenterAlongMaxFt)
    let firstSlickExitAlongFt: Double? = priorSlickGroupCount > 0 ? slickCenterAlongFt - slickSpanFt / 2 : nil
    let lastSlickExitAlongFt: Double? = priorSlickGroupCount > 0 ? slickCenterAlongFt + slickSpanFt / 2 : nil
    let firstSlotAlongFt = firstSlickExitAlongFt ?? preferredSpotOffset
    let startLocal = localPointAdd(lineOffset, scaleLocalPoint(jumpRunUnit, firstSlotAlongFt - assumptions.groupSeparationFt))
    let endLocal = localPointAdd(startLocal, scaleLocalPoint(jumpRunUnit, lineLengthFt))
    let slots = (0..<assumptions.groupCount).map { i in
        createResolvedJumpRunSlot(input: input,
            point: localPointAdd(startLocal, scaleLocalPoint(jumpRunUnit, assumptions.groupSeparationFt * Double(i + 1))),
            index: i, totalSlots: assumptions.groupCount)
    }
    let resolved = ResolvedJumpRun(
        line: JumpRunLine(start: geoPointFromLocal(reference: input.landingPoint, point: startLocal),
                          end: geoPointFromLocal(reference: input.landingPoint, point: endLocal)),
        headingDeg: vectorToHeadingDeg(localPointToVec(jumpRunUnit)),
        lengthFt: lineLengthFt, crosswindOffsetFt: crosswindOffset,
        planeGroundSpeedKt: planeGSKt,
        groupSpacingFt: assumptions.groupSeparationFt,
        groupSpacingSec: assumptions.groupSeparationFt / max(knotsToFeetPerSecond(planeGSKt), 1e-6),
        slots: slots)
    guard let frame = buildJumpRunFrame(landingPoint: input.landingPoint, jumpRun: resolved.line) else { return nil }
    let targetExitLocal = localPointFromGeoPoint(reference: input.landingPoint,
        point: GeoPoint(lat: slots[slots.count - 1].lat, lng: slots[slots.count - 1].lng))
    let blockedReason: String? = priorSlickGroupCount > 0 && slickCenterAlongMaxFt < slickCenterAlongMinFt
        ? "Jump run cannot fit \(priorSlickGroupCount) slick groups inside the \(String(format: "%.0f", assumptions.slickReturnRadiusFt)) ft return radius."
        : nil
    let warns: [String] = planeGSKt <= 45 + 1e-6 ? ["Aircraft ground speed was clamped to 45 kt for exit-spacing stability."] : []
    return ResolvedJumpRunPlan(
        resolved: resolved, frame: frame, targetExitLocal: targetExitLocal,
        jumpRunUnit: jumpRunUnit, groupSpacingFt: assumptions.groupSeparationFt,
        placementMode: .normal, headingSource: hr.headingSource,
        constrainedHeadingApplied: hr.constrainedHeadingApplied,
        normalJumpRunHeadingDeg: resolved.headingDeg, distanceOffsiteFt: nil,
        headwindComponentKt: headwindKt, crosswindComponentKt: crosswindKt,
        firstSlickReturnMarginFt: firstSlickExitAlongFt.map { assumptions.slickReturnRadiusFt - abs($0) },
        lastSlickReturnMarginFt: lastSlickExitAlongFt.map { assumptions.slickReturnRadiusFt - abs($0) },
        preferredSpotOffsetAlongFt: preferredSpotOffset,
        warnings: warns, blockedReason: blockedReason)
}

private func resolveDistanceJumpRunPlan(_ input: WingsuitAutoInput) -> ResolvedJumpRunPlan? {
    let assumptions = resolveJumpRunAssumptions(input.jumpRun.assumptions)
    guard let hr = resolveJumpRunHeading(input) else { return nil }
    let normalHeading = hr.headingDeg
    let sideSign: Double = input.side == .left ? -1 : 1
    let distRunHeading = normalizeHeading(normalHeading + sideSign * 90)
    let normalUnit = pointToUnitVector(headingDeg: normalHeading)
    let distRunUnit = pointToUnitVector(headingDeg: distRunHeading)
    let distOffsetFt = resolveDistanceOffsetFt(input)
    let postTurnFt = resolveDistancePostTurnFt(input)
    let turnAnchor = scaleLocalPoint(normalUnit, distOffsetFt)
    let targetExitLocal = localPointAdd(turnAnchor, scaleLocalPoint(distRunUnit, postTurnFt))
    let linePaddingFt = max(assumptions.groupSeparationFt, postTurnFt + 750, 1500)
    let startLocal = localPointAdd(targetExitLocal, scaleLocalPoint(distRunUnit, -linePaddingFt))
    let endLocal = localPointAdd(targetExitLocal, scaleLocalPoint(distRunUnit, linePaddingFt))
    let lineLengthFt = 2 * linePaddingFt
    let exitWind = getWindForAltitude(input.exitHeightFt, winds: input.winds)
    let deployWind = getWindForAltitude(input.deployHeightFt, winds: input.winds) ?? exitWind
    let planeAirVec = scaleVec(localPointToVec(distRunUnit), assumptions.planeAirspeedKt)
    let exitWindVec = exitWind.map { windFromToGroundVector(speedKt: $0.speedKt, dirFromDeg: $0.dirFromDeg) } ?? (east: 0.0, north: 0.0)
    let planeGSKt = max(45, dot(addVec(Vec2(east: planeAirVec.east, north: planeAirVec.north), Vec2(east: exitWindVec.east, north: exitWindVec.north)), localPointToVec(distRunUnit)))
    let deployWindVec = deployWind.map { windFromToGroundVector(speedKt: $0.speedKt, dirFromDeg: $0.dirFromDeg) } ?? (east: 0.0, north: 0.0)
    let leftUnit = LocalPoint(eastFt: -distRunUnit.northFt, northFt: distRunUnit.eastFt)
    let headwindKt = -dot(Vec2(east: deployWindVec.east, north: deployWindVec.north), localPointToVec(distRunUnit))
    let crosswindKt = dot(Vec2(east: deployWindVec.east, north: deployWindVec.north), localPointToVec(leftUnit))
    let slot = createResolvedJumpRunSlot(input: input, point: targetExitLocal, index: 0, totalSlots: 1)
    let resolved = ResolvedJumpRun(
        line: JumpRunLine(start: geoPointFromLocal(reference: input.landingPoint, point: startLocal),
                          end: geoPointFromLocal(reference: input.landingPoint, point: endLocal)),
        headingDeg: vectorToHeadingDeg(localPointToVec(distRunUnit)),
        lengthFt: lineLengthFt, crosswindOffsetFt: 0,
        planeGroundSpeedKt: planeGSKt,
        groupSpacingFt: assumptions.groupSeparationFt,
        groupSpacingSec: assumptions.groupSeparationFt / max(knotsToFeetPerSecond(planeGSKt), 1e-6),
        slots: [slot])
    guard let frame = buildJumpRunFrame(landingPoint: input.landingPoint, jumpRun: resolved.line) else { return nil }
    let warns: [String] = planeGSKt <= 45 + 1e-6 ? ["Aircraft ground speed was clamped to 45 kt for exit-spacing stability."] : []
    return ResolvedJumpRunPlan(
        resolved: resolved, frame: frame, targetExitLocal: targetExitLocal,
        jumpRunUnit: distRunUnit, groupSpacingFt: assumptions.groupSeparationFt,
        placementMode: .distance, headingSource: hr.headingSource,
        constrainedHeadingApplied: hr.constrainedHeadingApplied,
        normalJumpRunHeadingDeg: normalHeading, distanceOffsiteFt: distOffsetFt,
        headwindComponentKt: headwindKt, crosswindComponentKt: crosswindKt,
        firstSlickReturnMarginFt: nil, lastSlickReturnMarginFt: nil,
        preferredSpotOffsetAlongFt: distOffsetFt,
        warnings: warns, blockedReason: nil)
}
