import Foundation

struct MapStackCapabilityReport: Codable {
    var stack: MapStackChoice
    var satelliteBasemap: Bool
    var draggableTouchdownMarker: Bool
    var draggableHeadingHandle: Bool
    var overlaysAndArrows: Bool
    var turnPointLabels: Bool
    var stableInteraction60FPS: Bool
    var tokenlessBaseline: Bool

    var passed: Bool {
        satelliteBasemap &&
        draggableTouchdownMarker &&
        draggableHeadingHandle &&
        overlaysAndArrows &&
        turnPointLabels &&
        stableInteraction60FPS &&
        tokenlessBaseline
    }
}

enum MapStackEvaluator {
    static func defaultChoice(mapKitReport: MapStackCapabilityReport, mapboxReport: MapStackCapabilityReport?) -> MapStackChoice {
        if mapKitReport.passed {
            return .mapKit
        }
        if let mapboxReport, mapboxReport.passed {
            return .mapbox
        }
        return .mapKit
    }

    static func evaluationTemplate() -> [MapStackCapabilityReport] {
        [
            MapStackCapabilityReport(
                stack: .mapKit,
                satelliteBasemap: true,
                draggableTouchdownMarker: true,
                draggableHeadingHandle: true,
                overlaysAndArrows: true,
                turnPointLabels: true,
                stableInteraction60FPS: true,
                tokenlessBaseline: true
            ),
            MapStackCapabilityReport(
                stack: .mapbox,
                satelliteBasemap: false,
                draggableTouchdownMarker: false,
                draggableHeadingHandle: false,
                overlaysAndArrows: false,
                turnPointLabels: false,
                stableInteraction60FPS: false,
                tokenlessBaseline: false
            )
        ]
    }
}
