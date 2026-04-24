import XCTest
@testable import LandingPatternCore

final class EngineUnitTests: XCTestCase {
    private var baseInput: PatternInput {
        PatternInput(
            mode: .canopy,
            touchdownLat: 37,
            touchdownLng: -122,
            landingHeadingDeg: 180,
            side: .left,
            baseLegDrift: true,
            gatesFt: [900, 600, 300, 0],
            winds: [
                WindLayer(altitudeFt: 900, speedKt: 5, dirFromDeg: 270, source: .auto),
                WindLayer(altitudeFt: 600, speedKt: 5, dirFromDeg: 270, source: .auto),
                WindLayer(altitudeFt: 300, speedKt: 5, dirFromDeg: 270, source: .auto),
            ],
            canopy: CanopyProfile(
                manufacturer: "PD",
                model: "Sabre3",
                sizeSqft: 170,
                wlRef: 1,
                airspeedRefKt: 20,
                airspeedWlExponent: 0.5,
                airspeedMinKt: 8,
                airspeedMaxKt: 35,
                glideRatio: 2.7
            ),
            jumper: JumperInput(exitWeightLb: 170, canopyAreaSqft: 170),
            wingsuit: WingsuitProfile(name: "Generic Wingsuit", flightSpeedKt: 60, fallRateFps: 12)
        )
    }

    private var wingsuitInput: PatternInput {
        PatternInput(
            mode: .wingsuit,
            touchdownLat: 37,
            touchdownLng: -122,
            landingHeadingDeg: 180,
            side: .left,
            baseLegDrift: true,
            gatesFt: [3000, 2000, 1000, 0],
            winds: [
                WindLayer(altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: .auto),
                WindLayer(altitudeFt: 2000, speedKt: 18, dirFromDeg: 230, source: .auto),
                WindLayer(altitudeFt: 1000, speedKt: 14, dirFromDeg: 220, source: .auto),
            ],
            canopy: baseInput.canopy,
            jumper: baseInput.jumper,
            wingsuit: WingsuitProfile(name: "Swift", flightSpeedKt: 60, fallRateFps: 12)
        )
    }

    private var autoLanding: GeoPoint {
        GeoPoint(lat: 37, lng: -122)
    }

    private var autoInput: WingsuitAutoInput {
        WingsuitAutoInput(
            landingPoint: autoLanding,
            jumpRun: WingsuitAutoJumpRunConfig(
                directionMode: .manual,
                manualHeadingDeg: 0
            ),
            side: .left,
            exitHeightFt: 12000,
            deployHeightFt: 4000,
            winds: [
                WindLayer(altitudeFt: 12000, speedKt: 20, dirFromDeg: 270, source: .manual),
                WindLayer(altitudeFt: 8000, speedKt: 16, dirFromDeg: 270, source: .manual),
                WindLayer(altitudeFt: 4000, speedKt: 12, dirFromDeg: 270, source: .manual),
            ],
            wingsuit: WingsuitProfile(name: "Squirrel FREAK", flightSpeedKt: 84, fallRateFps: 68),
            tuning: WingsuitAutoTuning(
                corridorHalfWidthFt: 750,
                deployRadiusStepFt: 250,
                deployBearingWindowHalfDeg: 70,
                minDeployRadiusFt: 1000
            )
        )
    }

    private func signedCrossTrackForVerticalJumpRun(_ point: GeoPoint) -> Double {
        let local = latLngToLocalFeet(refLat: autoLanding.lat, refLng: autoLanding.lng, lat: point.lat, lng: point.lng)
        return local.eastFt
    }

    func testRightPatternFlipsBaseHeading() {
        let left = computePattern(baseInput)
        let right = computePattern(PatternInput(
            mode: .canopy,
            touchdownLat: baseInput.touchdownLat,
            touchdownLng: baseInput.touchdownLng,
            landingHeadingDeg: baseInput.landingHeadingDeg,
            side: .right,
            baseLegDrift: baseInput.baseLegDrift,
            gatesFt: baseInput.gatesFt,
            winds: baseInput.winds,
            canopy: baseInput.canopy,
            jumper: baseInput.jumper,
            wingsuit: baseInput.wingsuit
        ))

        let leftBase = left.segments.first { $0.name == .base }
        let rightBase = right.segments.first { $0.name == .base }

        XCTAssertNotNil(leftBase)
        XCTAssertNotNil(rightBase)
        XCTAssertEqual(leftBase!.headingDeg, 90, accuracy: 1e-6)
        XCTAssertEqual(rightBase!.headingDeg, 270, accuracy: 1e-6)
    }

    func testWingLoadingBlock() {
        let blocked = computePattern(PatternInput(
            mode: .canopy,
            touchdownLat: baseInput.touchdownLat,
            touchdownLng: baseInput.touchdownLng,
            landingHeadingDeg: baseInput.landingHeadingDeg,
            side: baseInput.side,
            baseLegDrift: baseInput.baseLegDrift,
            gatesFt: baseInput.gatesFt,
            winds: baseInput.winds,
            canopy: baseInput.canopy,
            jumper: JumperInput(exitWeightLb: 260, canopyAreaSqft: 130),
            wingsuit: baseInput.wingsuit
        ))

        XCTAssertTrue(blocked.blocked)
        XCTAssertTrue(blocked.warnings.contains { $0.contains("Wing loading") })
    }

    func testNonFiniteWindDirectionBlocked() {
        var winds = baseInput.winds
        winds[0].dirFromDeg = .nan

        let output = computePattern(PatternInput(
            mode: .canopy,
            touchdownLat: baseInput.touchdownLat,
            touchdownLng: baseInput.touchdownLng,
            landingHeadingDeg: baseInput.landingHeadingDeg,
            side: baseInput.side,
            baseLegDrift: baseInput.baseLegDrift,
            gatesFt: baseInput.gatesFt,
            winds: winds,
            canopy: baseInput.canopy,
            jumper: baseInput.jumper,
            wingsuit: baseInput.wingsuit
        ))

        XCTAssertTrue(output.blocked)
        XCTAssertTrue(output.warnings.contains { $0.contains("Wind layer values must be finite") })
    }

    func testWingsuitFirstLegCollapseProducesTwoLegPattern() {
        let output = computePattern(PatternInput(
            mode: .wingsuit,
            touchdownLat: wingsuitInput.touchdownLat,
            touchdownLng: wingsuitInput.touchdownLng,
            landingHeadingDeg: wingsuitInput.landingHeadingDeg,
            side: wingsuitInput.side,
            baseLegDrift: wingsuitInput.baseLegDrift,
            gatesFt: [3000, 3000, 1000, 0],
            winds: [
                WindLayer(altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: .auto),
                WindLayer(altitudeFt: 1000, speedKt: 14, dirFromDeg: 220, source: .auto),
            ],
            canopy: wingsuitInput.canopy,
            jumper: wingsuitInput.jumper,
            wingsuit: wingsuitInput.wingsuit
        ))

        XCTAssertFalse(output.blocked)
        XCTAssertEqual(output.segments.map(\.name), [.base, .final])
        XCTAssertEqual(output.waypoints.map(\.name), [.baseStart, .finalStart, .touchdown])
        XCTAssertNil(output.metrics.wingLoading)
    }

    func testWingsuitRejectsBothCollapsedEarlyLegs() {
        let output = computePattern(PatternInput(
            mode: .wingsuit,
            touchdownLat: wingsuitInput.touchdownLat,
            touchdownLng: wingsuitInput.touchdownLng,
            landingHeadingDeg: wingsuitInput.landingHeadingDeg,
            side: wingsuitInput.side,
            baseLegDrift: wingsuitInput.baseLegDrift,
            gatesFt: [3000, 3000, 3000, 0],
            winds: [
                WindLayer(altitudeFt: 3000, speedKt: 22, dirFromDeg: 240, source: .auto),
            ],
            canopy: wingsuitInput.canopy,
            jumper: wingsuitInput.jumper,
            wingsuit: wingsuitInput.wingsuit
        ))

        XCTAssertTrue(output.blocked)
        XCTAssertTrue(output.warnings.contains { $0.contains("requires at least two active legs") })
    }

    func testNormalizeHeading() {
        XCTAssertEqual(normalizeHeading(-90), 270, accuracy: 1e-6)
        XCTAssertEqual(normalizeHeading(450), 90, accuracy: 1e-6)
    }

    func testWingsuitAutoValidationRejectsEmptyWinds() {
        let validation = validateWingsuitAutoInput(
            WingsuitAutoInput(
                landingPoint: autoInput.landingPoint,
                jumpRun: autoInput.jumpRun,
                side: autoInput.side,
                exitHeightFt: autoInput.exitHeightFt,
                deployHeightFt: autoInput.deployHeightFt,
                winds: [],
                wingsuit: autoInput.wingsuit,
                turnRatios: autoInput.turnRatios,
                tuning: autoInput.tuning
            )
        )

        XCTAssertFalse(validation.valid)
        XCTAssertTrue(validation.errors.contains { $0.contains("At least one wind layer is required") })
    }

    func testWingsuitAutoSolvesNominalRoute() {
        let output = solveWingsuitAuto(autoInput)

        XCTAssertFalse(output.blocked)
        XCTAssertEqual(output.routeWaypoints.map(\.name), [.exit, .turn1, .turn2, .deploy])
        XCTAssertEqual(output.turnPoints.map(\.name), [.turn1, .turn2])
        XCTAssertEqual(output.routeSegments.count, 3)
        XCTAssertGreaterThan(output.deployBandsByBearing.count, 0)
        XCTAssertGreaterThan(output.feasibleDeployRegionPolygon.count, 0)
        XCTAssertEqual(output.forbiddenZonePolygon.count, 4)
        XCTAssertNotNil(output.diagnostics.turnHeightsFt)
        XCTAssertNotNil(output.diagnostics.preferredDeployBearingDeg)
        XCTAssertNotNil(output.deployPoint)
        XCTAssertNotNil(output.exitPoint)
        XCTAssertNotNil(output.resolvedJumpRun)
    }

    func testWingsuitAutoUsesCustomTurnRatios() {
        let output = solveWingsuitAuto(
            WingsuitAutoInput(
                landingPoint: autoInput.landingPoint,
                jumpRun: autoInput.jumpRun,
                side: autoInput.side,
                exitHeightFt: autoInput.exitHeightFt,
                deployHeightFt: autoInput.deployHeightFt,
                winds: autoInput.winds,
                wingsuit: autoInput.wingsuit,
                turnRatios: WingsuitAutoTurnRatios(turn1: 0.6, turn2: 0.25),
                tuning: autoInput.tuning
            )
        )

        XCTAssertFalse(output.blocked)
        XCTAssertNotNil(output.diagnostics.turnHeightsFt)
    }

    func testWingsuitAutoBlocksWhenRadiusRemovesCandidates() {
        let output = solveWingsuitAuto(
            WingsuitAutoInput(
                landingPoint: autoInput.landingPoint,
                jumpRun: autoInput.jumpRun,
                side: autoInput.side,
                exitHeightFt: autoInput.exitHeightFt,
                deployHeightFt: autoInput.deployHeightFt,
                winds: autoInput.winds,
                wingsuit: autoInput.wingsuit,
                turnRatios: autoInput.turnRatios,
                tuning: WingsuitAutoTuning(
                    corridorHalfWidthFt: 750,
                    deployRadiusStepFt: 250,
                    deployBearingWindowHalfDeg: 70,
                    maxDeployRadiusFt: 1000,
                    minDeployRadiusFt: 1000
                )
            )
        )

        XCTAssertTrue(output.blocked)
        XCTAssertNotNil(output.diagnostics.failureReason)
        XCTAssertTrue(output.deployBandsByBearing.isEmpty)
    }
}
