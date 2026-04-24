import Foundation

// MARK: - Forward-parametric wingsuit auto solver (matches web solveWingsuitAuto)

private func emptyAutoOutput(
    landingPoint: WingsuitAutoWaypoint, resolvedJumpRun: ResolvedJumpRun?,
    landingNoDeployZonePolygon: [GeoPoint],
    downwindDeployForbiddenZonePolygon: [GeoPoint],
    forbiddenZonePolygon: [GeoPoint],
    diagnostics: WingsuitAutoDiagnostics,
    warnings: [String]
) -> WingsuitAutoOutput {
    WingsuitAutoOutput(
        blocked: true, warnings: warnings, landingPoint: landingPoint,
        resolvedJumpRun: resolvedJumpRun, deployPoint: nil, exitPoint: nil,
        turnPoints: [], routeWaypoints: [], routeSegments: [],
        landingNoDeployZonePolygon: landingNoDeployZonePolygon,
        downwindDeployForbiddenZonePolygon: downwindDeployForbiddenZonePolygon,
        forbiddenZonePolygon: forbiddenZonePolygon, feasibleDeployRegionPolygon: [],
        deployBandsByBearing: [], diagnostics: diagnostics)
}

private func evaluateForwardRouteCandidate(
    input: WingsuitAutoInput, plan: ResolvedJumpRunPlan,
    tuning: ResolvedWingsuitAutoTuning, gate: AutoGateCandidate,
    forbiddenDeployBearingDeg: Double?,
    firstLegHeadingDeg: Double,
    offsetHeadingDeg: Double,
    returnHeadingDeg: Double
) -> (candidate: ForwardCandidateEvaluation?, rejectionReason: String?) {
    guard isStrictThreeLegGate(gate) else { return (nil, "inactive-leg") }

    let legs: [ForwardRouteLeg] = [
        ForwardRouteLeg(name: .downwind, headingDeg: firstLegHeadingDeg, startAltFt: gate.gatesFt[0], endAltFt: gate.gatesFt[1]),
        ForwardRouteLeg(name: .base, headingDeg: offsetHeadingDeg, startAltFt: gate.gatesFt[1], endAltFt: gate.gatesFt[2]),
        ForwardRouteLeg(name: .final, headingDeg: returnHeadingDeg, startAltFt: gate.gatesFt[2], endAltFt: gate.gatesFt[3]),
    ]
    let sim = simulateForwardRoute(legs, startPoint: plan.targetExitLocal, input: input)
    guard let firstLeg = sim.legs.first else { return (nil, "nonpositive-ground-speed") }
    guard sim.legs.count == 3 else { return (nil, sim.blockedReason) }
    let threeLegs = sim.legs
    let turn1Local = threeLegs[0].end
    let turn2Local = threeLegs[1].end
    let deployLocal = threeLegs[2].end

    // Hard filter: first leg track delta
    let signedFirstLegTrackDelta = signedHeadingDeltaDeg(plan.resolved.headingDeg, firstLeg.segment.trackHeadingDeg)
    let firstLegWithinBound = input.side == .left
        ? signedFirstLegTrackDelta >= -tuning.maxFirstLegTrackDeltaDeg && signedFirstLegTrackDelta <= 0
        : signedFirstLegTrackDelta >= 0 && signedFirstLegTrackDelta <= tuning.maxFirstLegTrackDeltaDeg
    guard firstLegWithinBound else {
        return (nil, "first-leg-track")
    }

    let checkedPoints = [turn1Local, turn2Local, deployLocal]
    guard checkedPoints.allSatisfy({ pointIsOnSelectedSide($0, plan.frame, input.side) }) else {
        return (nil, "selected-side")
    }

    let pointMargins = checkedPoints.map { pointToCorridorMarginFt(plan.frame, $0, tuning.corridorHalfWidthFt) }
    let routeMargins = [
        segmentOutsideFiniteCorridor(plan.frame, turn1Local, turn2Local, tuning.corridorHalfWidthFt, input.side, 16),
        segmentOutsideFiniteCorridor(plan.frame, turn2Local, deployLocal, tuning.corridorHalfWidthFt, input.side, 16),
    ]
    guard !pointMargins.contains(where: { $0 <= 0 }),
          !routeMargins.contains(where: { !$0.valid }) else {
        return (nil, "corridor")
    }

    let radiusFt = localPointMagnitude(deployLocal)
    guard radiusFt >= tuning.minDeployRadiusFt && radiusFt <= tuning.maxDeployRadiusFt else {
        return (nil, "deploy-radius")
    }
    let bearingDeg = vectorToHeadingDeg(localPointToVec(deployLocal))
    if let forbiddenDeployBearingDeg,
       absoluteHeadingDeltaDeg(bearingDeg, forbiddenDeployBearingDeg) <= tuning.deployBearingWindowHalfDeg {
        return (nil, "wind-no-deploy-zone")
    }

    // Canopy return margin
    let canopyReturnMarginFt = computeCanopyReturnMarginFt(input, deployLocal)
    guard canopyReturnMarginFt >= 0 else { return (nil, "canopy-return") }

    // Shape penalty
    let shapePenalty: Double
    if plan.placementMode == .distance {
        shapePenalty = computeDistanceShapePenalty(input: input,
            distanceRunHeadingDeg: plan.resolved.headingDeg,
            normalJumpRunHeadingDeg: plan.normalJumpRunHeadingDeg,
            firstTrackDeg: firstLeg.segment.trackHeadingDeg,
            offsetTrackDeg: threeLegs[1].segment.trackHeadingDeg,
            returnTrackDeg: threeLegs[2].segment.trackHeadingDeg,
            firstLegDistanceFt: firstLeg.segment.distanceFt)
    } else {
        shapePenalty = computeForwardShapePenalty(input: input,
            jumpRunHeadingDeg: plan.resolved.headingDeg,
            firstTrackDeg: firstLeg.segment.trackHeadingDeg,
            offsetTrackDeg: threeLegs[1].segment.trackHeadingDeg,
            returnTrackDeg: threeLegs[2].segment.trackHeadingDeg)
    }

    // Build waypoints
    let routeWaypointData: [(WingsuitAutoWaypointName, LocalPoint, Double)] = [
        (.exit, plan.targetExitLocal, gate.gatesFt[0]),
        (.turn1, turn1Local, gate.gatesFt[1]),
        (.turn2, turn2Local, gate.gatesFt[2]),
        (.deploy, deployLocal, gate.gatesFt[3])
    ]
    let waypoints = routeWaypointData.map { n, pt, alt in
        let geo = geoPointFromLocal(reference: input.landingPoint, point: pt)
        return WingsuitAutoWaypoint(name: n, lat: geo.lat, lng: geo.lng, altFt: alt)
    }
    let segments = threeLegs.map {
        SegmentOutput(name: $0.segment.name, headingDeg: $0.segment.headingDeg,
            trackHeadingDeg: $0.segment.trackHeadingDeg, alongLegSpeedKt: $0.segment.alongLegSpeedKt,
            groundSpeedKt: $0.segment.groundSpeedKt, timeSec: $0.segment.timeSec, distanceFt: $0.segment.distanceFt)
    }

    let candidate = ForwardCandidateEvaluation(
        landingHeadingDeg: returnHeadingDeg, bearingDeg: bearingDeg, radiusFt: radiusFt,
        turnHeightsFt: gate.turnHeightsFt, resolvedJumpRun: plan.resolved,
        deployPoint: waypoints[3], exitPoint: waypoints[0],
        turnPoints: [waypoints[1], waypoints[2]],
        routeWaypoints: waypoints,
        routeSegments: segments, warnings: [],
        exitToJumpRunErrorFt: 0,
        firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
        lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
        corridorMarginFt: min(pointMargins.min() ?? .infinity, routeMargins.map(\.marginFt).min() ?? .infinity),
        deployRadiusMarginFt: tuning.maxDeployRadiusFt - radiusFt,
        firstLegTrackDeltaDeg: abs(signedFirstLegTrackDelta),
        exitAlongTargetErrorFt: 0,
        canopyReturnMarginFt: canopyReturnMarginFt,
        shapePenalty: shapePenalty)
    return (candidate, nil)
}

private func addCandidateToBands(
    _ bandsByBearing: inout [Double: RadiusBand],
    _ candidate: ForwardCandidateEvaluation,
    bearingStepDeg: Double,
    forbiddenDeployBearingDeg: Double?,
    forbiddenDeployBearingHalfWidthDeg: Double
) {
    let safeStepDeg = max(1, bearingStepDeg)
    let roundedKey = (normalizeHeading((candidate.bearingDeg / safeStepDeg).rounded() * safeStepDeg) * 1_000_000).rounded() / 1_000_000
    let key: Double
    if let forbiddenDeployBearingDeg,
       absoluteHeadingDeltaDeg(roundedKey, forbiddenDeployBearingDeg) <= forbiddenDeployBearingHalfWidthDeg {
        key = (normalizeHeading(candidate.bearingDeg) * 1_000_000).rounded() / 1_000_000
    } else {
        key = roundedKey
    }

    if var existing = bandsByBearing[key] {
        existing.minRadiusFt = min(existing.minRadiusFt, candidate.radiusFt)
        existing.maxRadiusFt = max(existing.maxRadiusFt, candidate.radiusFt)
        bandsByBearing[key] = existing
    } else {
        bandsByBearing[key] = RadiusBand(
            bearingDeg: key,
            minRadiusFt: candidate.radiusFt,
            maxRadiusFt: candidate.radiusFt
        )
    }
}

private func failureReasonForForwardRoute(
    gateCount: Int,
    rejectionCounts: [String: Int],
    maxFirstLegTrackDeltaDeg: Double
) -> String {
    var failureReason = "No forward wingsuit route reaches a safe deployment point."
    let dominantReason = rejectionCounts.max { a, b in a.value < b.value }?.key
    if gateCount == 0 {
        failureReason = "No three-leg wingsuit gate layout is available."
    } else if dominantReason == "first-leg-track" {
        failureReason = "No forward route keeps the first leg within \(String(format: "%.0f", maxFirstLegTrackDeltaDeg))° of jump run."
    } else if dominantReason == "selected-side" {
        failureReason = "No deploy point survives the selected side of jump run."
    } else if dominantReason == "corridor" {
        failureReason = "No deploy point survives jump-run corridor exclusion."
    } else if dominantReason == "deploy-radius" {
        failureReason = "No forward route reaches deployment inside the configured radius limits."
    } else if dominantReason == "wind-no-deploy-zone" {
        failureReason = "No deploy point survives the wind no-deploy zone."
    } else if dominantReason == "canopy-return" {
        failureReason = "No forward route leaves enough canopy-return margin from deployment."
    } else if dominantReason == "nonpositive-ground-speed" {
        failureReason = "No forward route can be integrated through the current wind and wingsuit profile."
    }
    return failureReason
}

// MARK: - Main Entry Point

public func solveWingsuitAuto(_ input: WingsuitAutoInput) -> WingsuitAutoOutput {
    let validation = validateWingsuitAutoInput(input)
    let ratios = resolveTurnRatios(input.turnRatios)
    let placementMode = resolveJumpRunPlacementMode(input.jumpRun.placementMode)
    var tuning = resolveWingsuitAutoTuning(input.tuning)
    if placementMode == .distance {
        tuning = ResolvedWingsuitAutoTuning(
            corridorHalfWidthFt: tuning.corridorHalfWidthFt,
            deployBearingStepDeg: tuning.deployBearingStepDeg,
            deployRadiusStepFt: tuning.deployRadiusStepFt,
            deployBearingWindowHalfDeg: tuning.deployBearingWindowHalfDeg,
            maxDeployRadiusFt: max(tuning.maxDeployRadiusFt, resolveDistanceOffsetFt(input)),
            maxFirstLegTrackDeltaDeg: tuning.maxFirstLegTrackDeltaDeg,
            minDeployRadiusFt: tuning.minDeployRadiusFt,
            refinementIterations: tuning.refinementIterations,
            exitOnJumpRunToleranceFt: tuning.exitOnJumpRunToleranceFt
        )
    }
    let landingWp = WingsuitAutoWaypoint(name: .landing, lat: input.landingPoint.lat, lng: input.landingPoint.lng, altFt: 0)
    let turnHeightsFt = deriveTurnHeightsFt(input: input, ratios: ratios)

    guard validation.valid else {
        let fr = validation.errors.first ?? "Wingsuit auto input is invalid."
        return emptyAutoOutput(landingPoint: landingWp, resolvedJumpRun: nil,
            landingNoDeployZonePolygon: [], downwindDeployForbiddenZonePolygon: [],
            forbiddenZonePolygon: [],
            diagnostics: WingsuitAutoDiagnostics(placementMode: placementMode, turnHeightsFt: turnHeightsFt, failureReason: fr),
            warnings: validation.warnings + validation.errors)
    }

    guard let plan = resolveJumpRunPlan(input) else {
        return emptyAutoOutput(landingPoint: landingWp, resolvedJumpRun: nil,
            landingNoDeployZonePolygon: [], downwindDeployForbiddenZonePolygon: [],
            forbiddenZonePolygon: [],
            diagnostics: WingsuitAutoDiagnostics(placementMode: placementMode, turnHeightsFt: turnHeightsFt, failureReason: "Jump run could not be resolved from the current settings."),
            warnings: validation.warnings + ["Jump run could not be resolved from the current settings."])
    }

    let forbiddenZonePolygon = buildForbiddenZonePolygonAuto(
        input.landingPoint,
        plan.frame,
        tuning.corridorHalfWidthFt,
        max(tuning.maxDeployRadiusFt, plan.frame.lengthFt)
    )
    let landingNoDeployZone = buildCirclePolygon(input.landingPoint, tuning.minDeployRadiusFt)
    let downwindShadeRadiusFt = max(tuning.maxDeployRadiusFt, plan.frame.lengthFt, tuning.minDeployRadiusFt * 2)
    let lowestWind = input.winds.sorted { $0.altitudeFt < $1.altitudeFt }.first
    let preferredBearingDeg = lowestWind.map { normalizeHeading($0.dirFromDeg) }
    let forbiddenDeployBearingDeg = preferredBearingDeg.map { normalizeHeading($0 + 180) }
    let downwindDeployForbiddenZone = forbiddenDeployBearingDeg.map {
        buildHalfDiskPolygon(input.landingPoint, $0, downwindShadeRadiusFt)
    } ?? []

    if let br = plan.blockedReason {
        return emptyAutoOutput(landingPoint: landingWp, resolvedJumpRun: plan.resolved,
            landingNoDeployZonePolygon: landingNoDeployZone,
            downwindDeployForbiddenZonePolygon: downwindDeployForbiddenZone,
            forbiddenZonePolygon: forbiddenZonePolygon,
            diagnostics: WingsuitAutoDiagnostics(
                headingSource: plan.headingSource, placementMode: plan.placementMode,
                constrainedHeadingApplied: plan.constrainedHeadingApplied,
                resolvedHeadingDeg: plan.resolved.headingDeg,
                normalJumpRunHeadingDeg: plan.normalJumpRunHeadingDeg,
                distanceOffsiteFt: plan.distanceOffsiteFt,
                headwindComponentKt: plan.headwindComponentKt, crosswindComponentKt: plan.crosswindComponentKt,
                crosswindOffsetFt: plan.resolved.crosswindOffsetFt,
                firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
                lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
                preferredDeployBearingDeg: preferredBearingDeg,
                turnHeightsFt: turnHeightsFt,
                failureReason: br),
            warnings: validation.warnings + plan.warnings + [br])
    }

    guard let preferredBearingDeg else {
        let fr = "Wind model missing required altitude coverage."
        return emptyAutoOutput(landingPoint: landingWp, resolvedJumpRun: plan.resolved,
            landingNoDeployZonePolygon: landingNoDeployZone,
            downwindDeployForbiddenZonePolygon: downwindDeployForbiddenZone,
            forbiddenZonePolygon: forbiddenZonePolygon,
            diagnostics: WingsuitAutoDiagnostics(
                headingSource: plan.headingSource, placementMode: plan.placementMode,
                constrainedHeadingApplied: plan.constrainedHeadingApplied,
                resolvedHeadingDeg: plan.resolved.headingDeg,
                normalJumpRunHeadingDeg: plan.normalJumpRunHeadingDeg,
                distanceOffsiteFt: plan.distanceOffsiteFt,
                headwindComponentKt: plan.headwindComponentKt, crosswindComponentKt: plan.crosswindComponentKt,
                crosswindOffsetFt: plan.resolved.crosswindOffsetFt,
                firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
                lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
                turnHeightsFt: turnHeightsFt,
                failureReason: fr),
            warnings: validation.warnings + plan.warnings + [fr])
    }

    let isDistance = plan.placementMode == .distance
    let maxDelta = tuning.maxFirstLegTrackDeltaDeg
    let gateCandidates = (isDistance ? buildDistanceAutoGateCandidates(input) : buildAutoGateCandidates(input, ratios))
        .filter(isStrictThreeLegGate)

    var validCandidates: [ForwardCandidateEvaluation] = []
    var bandsByBearing = [Double: RadiusBand]()
    var rejectionCounts: [String: Int] = [:]

    for gate in gateCandidates {
        let firstLegHeadings = isDistance
            ? buildDistanceFirstLegHeadingCandidates(plan.resolved.headingDeg, input.side, maxDelta)
            : buildFirstLegHeadingCandidates(plan.resolved.headingDeg, input.side, maxDelta)
        let offsetHeadings = isDistance
            ? buildDistanceReturnHeadingCandidates(plan.normalJumpRunHeadingDeg)
            : buildOffsetHeadingCandidates(plan.resolved.headingDeg, input.side)

        for fh in firstLegHeadings {
            for oh in offsetHeadings {
                let preview = simulateForwardRoute(
                    [
                        ForwardRouteLeg(name: .downwind, headingDeg: fh, startAltFt: gate.gatesFt[0], endAltFt: gate.gatesFt[1]),
                        ForwardRouteLeg(name: .base, headingDeg: oh, startAltFt: gate.gatesFt[1], endAltFt: gate.gatesFt[2]),
                    ],
                    startPoint: plan.targetExitLocal,
                    input: input
                )
                let turn2End = preview.blockedReason == nil && preview.legs.count >= 2 ? preview.legs[1].end : nil
                let returnHeadings = isDistance
                    ? buildDistanceReturnHeadingCandidates(plan.normalJumpRunHeadingDeg)
                    : buildReturnHeadingCandidates(plan.resolved.headingDeg, input.side, turn2End)
                for rh in returnHeadings {
                    let ev = evaluateForwardRouteCandidate(
                        input: input,
                        plan: plan,
                        tuning: tuning,
                        gate: gate,
                        forbiddenDeployBearingDeg: forbiddenDeployBearingDeg,
                        firstLegHeadingDeg: fh,
                        offsetHeadingDeg: oh,
                        returnHeadingDeg: rh
                    )
                    guard let candidate = ev.candidate else {
                        if let reason = ev.rejectionReason {
                            rejectionCounts[reason, default: 0] += 1
                        }
                        continue
                    }
                    validCandidates.append(candidate)
                    addCandidateToBands(
                        &bandsByBearing,
                        candidate,
                        bearingStepDeg: tuning.deployBearingStepDeg,
                        forbiddenDeployBearingDeg: forbiddenDeployBearingDeg,
                        forbiddenDeployBearingHalfWidthDeg: tuning.deployBearingWindowHalfDeg
                    )
                }
            }
        }
    }

    let deployBandsByBearing = bandsByBearing.values.sorted { $0.bearingDeg < $1.bearingDeg }
    let feasiblePolygon = buildBandsPolygonAuto(input.landingPoint, deployBandsByBearing)

    let bestCandidate = validCandidates.dropFirst().reduce(validCandidates.first) { best, candidate in
        if let best {
            return compareForwardCandidates(candidate, best) < 0 ? candidate : best
        }
        return candidate
    }

    guard let best = bestCandidate else {
        let fr = failureReasonForForwardRoute(
            gateCount: gateCandidates.count,
            rejectionCounts: rejectionCounts,
            maxFirstLegTrackDeltaDeg: tuning.maxFirstLegTrackDeltaDeg
        )
        return emptyAutoOutput(landingPoint: landingWp, resolvedJumpRun: plan.resolved,
            landingNoDeployZonePolygon: landingNoDeployZone,
            downwindDeployForbiddenZonePolygon: downwindDeployForbiddenZone,
            forbiddenZonePolygon: forbiddenZonePolygon,
            diagnostics: WingsuitAutoDiagnostics(
                headingSource: plan.headingSource, placementMode: plan.placementMode,
                constrainedHeadingApplied: plan.constrainedHeadingApplied,
                resolvedHeadingDeg: plan.resolved.headingDeg,
                normalJumpRunHeadingDeg: plan.normalJumpRunHeadingDeg,
                distanceOffsiteFt: plan.distanceOffsiteFt,
                headwindComponentKt: plan.headwindComponentKt, crosswindComponentKt: plan.crosswindComponentKt,
                crosswindOffsetFt: plan.resolved.crosswindOffsetFt,
                firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
                lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
                preferredDeployBearingDeg: preferredBearingDeg,
                turnHeightsFt: turnHeightsFt,
                failureReason: fr),
            warnings: validation.warnings + plan.warnings + [fr])
    }

    let outWarnings = validation.warnings + plan.warnings + best.warnings

    return WingsuitAutoOutput(
        blocked: false, warnings: outWarnings, landingPoint: landingWp,
        resolvedJumpRun: plan.resolved,
        deployPoint: best.deployPoint, exitPoint: best.exitPoint,
        turnPoints: best.turnPoints, routeWaypoints: best.routeWaypoints,
        routeSegments: best.routeSegments,
        landingNoDeployZonePolygon: landingNoDeployZone,
        downwindDeployForbiddenZonePolygon: downwindDeployForbiddenZone,
        forbiddenZonePolygon: forbiddenZonePolygon,
        feasibleDeployRegionPolygon: feasiblePolygon,
        deployBandsByBearing: deployBandsByBearing,
        diagnostics: WingsuitAutoDiagnostics(
            headingSource: plan.headingSource,
            placementMode: plan.placementMode,
            constrainedHeadingApplied: plan.constrainedHeadingApplied,
            resolvedHeadingDeg: plan.resolved.headingDeg,
            normalJumpRunHeadingDeg: plan.normalJumpRunHeadingDeg,
            distanceOffsiteFt: plan.distanceOffsiteFt,
            headwindComponentKt: plan.headwindComponentKt,
            crosswindComponentKt: plan.crosswindComponentKt,
            crosswindOffsetFt: plan.resolved.crosswindOffsetFt,
            firstSlickReturnMarginFt: plan.firstSlickReturnMarginFt,
            lastSlickReturnMarginFt: plan.lastSlickReturnMarginFt,
            preferredDeployBearingDeg: preferredBearingDeg,
            selectedDeployBearingDeg: best.bearingDeg,
            selectedDeployRadiusFt: best.radiusFt,
            exitToJumpRunErrorFt: best.exitToJumpRunErrorFt,
            deployRadiusMarginFt: best.deployRadiusMarginFt,
            firstLegTrackDeltaDeg: best.firstLegTrackDeltaDeg,
            corridorMarginFt: best.corridorMarginFt,
            turnHeightsFt: best.turnHeightsFt,
            failureReason: nil))
}
