import XCTest
@testable import LandingPatternCore

final class EngineUnitTests: XCTestCase {
    private var baseInput: PatternInput {
        PatternInput(
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
            jumper: JumperInput(exitWeightLb: 170, canopyAreaSqft: 170)
        )
    }

    func testRightPatternFlipsBaseHeading() {
        let left = computePattern(baseInput)
        let right = computePattern(PatternInput(
            touchdownLat: baseInput.touchdownLat,
            touchdownLng: baseInput.touchdownLng,
            landingHeadingDeg: baseInput.landingHeadingDeg,
            side: .right,
            baseLegDrift: baseInput.baseLegDrift,
            gatesFt: baseInput.gatesFt,
            winds: baseInput.winds,
            canopy: baseInput.canopy,
            jumper: baseInput.jumper
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
            touchdownLat: baseInput.touchdownLat,
            touchdownLng: baseInput.touchdownLng,
            landingHeadingDeg: baseInput.landingHeadingDeg,
            side: baseInput.side,
            baseLegDrift: baseInput.baseLegDrift,
            gatesFt: baseInput.gatesFt,
            winds: baseInput.winds,
            canopy: baseInput.canopy,
            jumper: JumperInput(exitWeightLb: 260, canopyAreaSqft: 130)
        ))

        XCTAssertTrue(blocked.blocked)
        XCTAssertTrue(blocked.warnings.contains { $0.contains("Wing loading") })
    }

    func testNonFiniteWindDirectionBlocked() {
        var winds = baseInput.winds
        winds[0].dirFromDeg = .nan

        let output = computePattern(PatternInput(
            touchdownLat: baseInput.touchdownLat,
            touchdownLng: baseInput.touchdownLng,
            landingHeadingDeg: baseInput.landingHeadingDeg,
            side: baseInput.side,
            baseLegDrift: baseInput.baseLegDrift,
            gatesFt: baseInput.gatesFt,
            winds: winds,
            canopy: baseInput.canopy,
            jumper: baseInput.jumper
        ))

        XCTAssertTrue(output.blocked)
        XCTAssertTrue(output.warnings.contains { $0.contains("Wind layer values must be finite") })
    }

    func testNormalizeHeading() {
        XCTAssertEqual(normalizeHeading(-90), 270, accuracy: 1e-6)
        XCTAssertEqual(normalizeHeading(450), 90, accuracy: 1e-6)
    }
}
