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

private struct WingsuitAutoFixtureFile: Decodable {
    struct CaseFixture: Decodable {
        let name: String
        let input: WingsuitAutoInput
        let validation: ValidationResult
        let output: WingsuitAutoOutput
    }

    let schemaVersion: Int
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

    func testWingsuitAutoParityAgainstTypeScriptFixtures() throws {
        let fixtureURL = repoRootURL()
            .appendingPathComponent("packages/fixtures/engine/wingsuit-auto-fixtures.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixtureFile = try JSONDecoder().decode(WingsuitAutoFixtureFile.self, from: data)

        XCTAssertEqual(fixtureFile.schemaVersion, 1)

        for fixture in fixtureFile.cases {
            let validation = validateWingsuitAutoInput(fixture.input)
            XCTAssertEqual(validation.valid, fixture.validation.valid, "validation.valid mismatch for \(fixture.name)")
            XCTAssertEqual(validation.errors, fixture.validation.errors, "validation.errors mismatch for \(fixture.name)")
            XCTAssertEqual(validation.warnings, fixture.validation.warnings, "validation.warnings mismatch for \(fixture.name)")

            let output = solveWingsuitAuto(fixture.input)
            XCTAssertEqual(output.blocked, fixture.output.blocked, "blocked mismatch for \(fixture.name)")
            XCTAssertEqual(output.warnings, fixture.output.warnings, "warnings mismatch for \(fixture.name)")
            assertWaypoint(output.landingPoint, fixture.output.landingPoint, context: "\(fixture.name) landing")
            assertOptionalWaypoint(output.deployPoint, fixture.output.deployPoint, context: "\(fixture.name) deploy")
            assertOptionalWaypoint(output.exitPoint, fixture.output.exitPoint, context: "\(fixture.name) exit")
            XCTAssertEqual(output.turnPoints.count, fixture.output.turnPoints.count, "turn point count mismatch for \(fixture.name)")
            XCTAssertEqual(output.routeWaypoints.count, fixture.output.routeWaypoints.count, "route waypoint count mismatch for \(fixture.name)")
            XCTAssertEqual(output.routeSegments.count, fixture.output.routeSegments.count, "route segments mismatch for \(fixture.name)")
            XCTAssertEqual(output.forbiddenZonePolygon.count, fixture.output.forbiddenZonePolygon.count, "forbidden polygon count mismatch for \(fixture.name)")
            XCTAssertEqual(output.feasibleDeployRegionPolygon.count, fixture.output.feasibleDeployRegionPolygon.count, "feasible polygon count mismatch for \(fixture.name)")
            XCTAssertEqual(output.deployBandsByBearing.count, fixture.output.deployBandsByBearing.count, "deploy band count mismatch for \(fixture.name)")

            for (index, expectedWaypoint) in fixture.output.turnPoints.enumerated() {
                assertWaypoint(output.turnPoints[index], expectedWaypoint, context: "\(fixture.name) turn \(index)")
            }

            for (index, expectedWaypoint) in fixture.output.routeWaypoints.enumerated() {
                assertWaypoint(output.routeWaypoints[index], expectedWaypoint, context: "\(fixture.name) route waypoint \(index)")
            }

            for (index, expectedSegment) in fixture.output.routeSegments.enumerated() {
                let actualSegment = output.routeSegments[index]
                XCTAssertEqual(actualSegment.name, expectedSegment.name, "segment name mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualSegment.headingDeg, expectedSegment.headingDeg, accuracy: 1e-9, "heading mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualSegment.trackHeadingDeg, expectedSegment.trackHeadingDeg, accuracy: 1e-9, "track mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualSegment.alongLegSpeedKt, expectedSegment.alongLegSpeedKt, accuracy: 1e-9, "along-speed mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualSegment.groundSpeedKt, expectedSegment.groundSpeedKt, accuracy: 1e-9, "ground-speed mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualSegment.timeSec, expectedSegment.timeSec, accuracy: 1e-9, "time mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualSegment.distanceFt, expectedSegment.distanceFt, accuracy: 1e-9, "distance mismatch for \(fixture.name) @ \(index)")
            }

            for (index, expectedPoint) in fixture.output.forbiddenZonePolygon.enumerated() {
                let actualPoint = output.forbiddenZonePolygon[index]
                XCTAssertEqual(actualPoint.lat, expectedPoint.lat, accuracy: 1e-9, "forbidden lat mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualPoint.lng, expectedPoint.lng, accuracy: 1e-9, "forbidden lng mismatch for \(fixture.name) @ \(index)")
            }

            for (index, expectedPoint) in fixture.output.feasibleDeployRegionPolygon.enumerated() {
                let actualPoint = output.feasibleDeployRegionPolygon[index]
                XCTAssertEqual(actualPoint.lat, expectedPoint.lat, accuracy: 1e-9, "feasible lat mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualPoint.lng, expectedPoint.lng, accuracy: 1e-9, "feasible lng mismatch for \(fixture.name) @ \(index)")
            }

            for (index, expectedBand) in fixture.output.deployBandsByBearing.enumerated() {
                let actualBand = output.deployBandsByBearing[index]
                XCTAssertEqual(actualBand.bearingDeg, expectedBand.bearingDeg, accuracy: 1e-9, "band bearing mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualBand.minRadiusFt, expectedBand.minRadiusFt, accuracy: 1e-9, "band min mismatch for \(fixture.name) @ \(index)")
                XCTAssertEqual(actualBand.maxRadiusFt, expectedBand.maxRadiusFt, accuracy: 1e-9, "band max mismatch for \(fixture.name) @ \(index)")
            }

            assertOptionalEqual(
                output.diagnostics.preferredDeployBearingDeg,
                fixture.output.diagnostics.preferredDeployBearingDeg,
                accuracy: 1e-9,
                context: "\(fixture.name) preferred bearing"
            )
            assertOptionalEqual(
                output.diagnostics.selectedDeployBearingDeg,
                fixture.output.diagnostics.selectedDeployBearingDeg,
                accuracy: 1e-9,
                context: "\(fixture.name) selected bearing"
            )
            assertOptionalEqual(
                output.diagnostics.selectedDeployRadiusFt,
                fixture.output.diagnostics.selectedDeployRadiusFt,
                accuracy: 1e-9,
                context: "\(fixture.name) selected radius"
            )
            assertOptionalEqual(
                output.diagnostics.exitToJumpRunErrorFt,
                fixture.output.diagnostics.exitToJumpRunErrorFt,
                accuracy: 1e-9,
                context: "\(fixture.name) exit error"
            )
            assertOptionalEqual(
                output.diagnostics.deployEnvelopeMarginFt,
                fixture.output.diagnostics.deployEnvelopeMarginFt,
                accuracy: 1e-9,
                context: "\(fixture.name) envelope margin"
            )
            assertOptionalEqual(
                output.diagnostics.corridorMarginFt,
                fixture.output.diagnostics.corridorMarginFt,
                accuracy: 1e-9,
                context: "\(fixture.name) corridor margin"
            )
            XCTAssertEqual(output.diagnostics.turnHeightsFt ?? [], fixture.output.diagnostics.turnHeightsFt ?? [], "turn heights mismatch for \(fixture.name)")
            XCTAssertEqual(output.diagnostics.failureReason, fixture.output.diagnostics.failureReason, "failure reason mismatch for \(fixture.name)")
        }
    }

    private func repoRootURL() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            url.deleteLastPathComponent()
        }
        return url
    }

    private func assertWaypoint(
        _ actual: WingsuitAutoWaypoint,
        _ expected: WingsuitAutoWaypoint,
        context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.name, expected.name, "\(context) name mismatch", file: file, line: line)
        XCTAssertEqual(actual.altFt, expected.altFt, accuracy: 1e-9, "\(context) altitude mismatch", file: file, line: line)
        XCTAssertEqual(actual.lat, expected.lat, accuracy: 1e-9, "\(context) latitude mismatch", file: file, line: line)
        XCTAssertEqual(actual.lng, expected.lng, accuracy: 1e-9, "\(context) longitude mismatch", file: file, line: line)
    }

    private func assertOptionalWaypoint(
        _ actual: WingsuitAutoWaypoint?,
        _ expected: WingsuitAutoWaypoint?,
        context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        switch (actual, expected) {
        case (nil, nil):
            return
        case let (.some(actual), .some(expected)):
            assertWaypoint(actual, expected, context: context, file: file, line: line)
        default:
            XCTFail("\(context) nil mismatch", file: file, line: line)
        }
    }

    private func assertOptionalEqual(
        _ actual: Double?,
        _ expected: Double?,
        accuracy: Double,
        context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        switch (actual, expected) {
        case (nil, nil):
            return
        case let (.some(actual), .some(expected)):
            XCTAssertEqual(actual, expected, accuracy: accuracy, "\(context) mismatch", file: file, line: line)
        default:
            XCTFail("\(context) nil mismatch", file: file, line: line)
        }
    }
}
