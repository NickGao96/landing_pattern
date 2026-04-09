import Foundation
import XCTest
@testable import LandingPatternCore

private struct EngineFixtureFile: Decodable {
    struct Tolerance: Decodable {
        let headingDeg: Double
        let distancePct: Double
        let timePct: Double
        let speedKt: Double
    }

    struct CaseFixture: Decodable {
        let name: String
        let input: PatternInput
        let validation: ValidationResult
        let output: PatternOutput
    }

    let schemaVersion: Int
    let tolerance: Tolerance
    let cases: [CaseFixture]
}

final class EngineParityTests: XCTestCase {
    func testEngineParityAgainstTypeScriptFixtures() throws {
        let fixtureURL = try XCTUnwrap(Bundle.module.url(forResource: "fixtures", withExtension: "json", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: fixtureURL)
        let fixtureFile = try JSONDecoder().decode(EngineFixtureFile.self, from: data)

        XCTAssertEqual(fixtureFile.schemaVersion, 2)

        for fixture in fixtureFile.cases {
            let validation = validatePatternInput(fixture.input)
            XCTAssertEqual(validation.valid, fixture.validation.valid, "validation.valid mismatch for \(fixture.name)")
            XCTAssertEqual(validation.errors, fixture.validation.errors, "validation.errors mismatch for \(fixture.name)")
            XCTAssertEqual(validation.warnings, fixture.validation.warnings, "validation.warnings mismatch for \(fixture.name)")

            let output = computePattern(fixture.input)
            XCTAssertEqual(output.blocked, fixture.output.blocked, "blocked mismatch for \(fixture.name)")
            XCTAssertEqual(output.warnings, fixture.output.warnings, "warnings mismatch for \(fixture.name)")
            XCTAssertEqual(output.waypoints.count, fixture.output.waypoints.count, "waypoint count mismatch for \(fixture.name)")
            XCTAssertEqual(output.segments.count, fixture.output.segments.count, "segment count mismatch for \(fixture.name)")

            for (index, expectedWaypoint) in fixture.output.waypoints.enumerated() {
                let actualWaypoint = output.waypoints[index]
                XCTAssertEqual(actualWaypoint.name, expectedWaypoint.name)
                XCTAssertEqual(actualWaypoint.altFt, expectedWaypoint.altFt, accuracy: 0.01)
                XCTAssertEqual(actualWaypoint.lat, expectedWaypoint.lat, accuracy: 1e-6)
                XCTAssertEqual(actualWaypoint.lng, expectedWaypoint.lng, accuracy: 1e-6)
            }

            for (index, expectedSegment) in fixture.output.segments.enumerated() {
                let actualSegment = output.segments[index]
                XCTAssertEqual(actualSegment.name, expectedSegment.name)
                XCTAssertEqual(actualSegment.headingDeg, expectedSegment.headingDeg, accuracy: fixtureFile.tolerance.headingDeg)
                XCTAssertEqual(actualSegment.trackHeadingDeg, expectedSegment.trackHeadingDeg, accuracy: fixtureFile.tolerance.headingDeg)
                XCTAssertEqual(actualSegment.alongLegSpeedKt, expectedSegment.alongLegSpeedKt, accuracy: fixtureFile.tolerance.speedKt)
                XCTAssertEqual(actualSegment.groundSpeedKt, expectedSegment.groundSpeedKt, accuracy: fixtureFile.tolerance.speedKt)

                let expectedDistance = max(abs(expectedSegment.distanceFt), 1)
                let expectedTime = max(abs(expectedSegment.timeSec), 1)
                XCTAssertLessThanOrEqual(abs(actualSegment.distanceFt - expectedSegment.distanceFt) / expectedDistance, fixtureFile.tolerance.distancePct)
                XCTAssertLessThanOrEqual(abs(actualSegment.timeSec - expectedSegment.timeSec) / expectedTime, fixtureFile.tolerance.timePct)
            }

            if let expectedWingLoading = fixture.output.metrics.wingLoading {
                XCTAssertEqual(output.metrics.wingLoading ?? 0, expectedWingLoading, accuracy: 1e-6)
            } else {
                XCTAssertNil(output.metrics.wingLoading)
            }
            XCTAssertEqual(output.metrics.estAirspeedKt, fixture.output.metrics.estAirspeedKt, accuracy: fixtureFile.tolerance.speedKt)
            XCTAssertEqual(output.metrics.estSinkFps, fixture.output.metrics.estSinkFps, accuracy: 1e-3)
        }
    }
}
