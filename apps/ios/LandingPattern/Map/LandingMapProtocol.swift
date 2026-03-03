import CoreLocation
import SwiftUI
import LandingPatternCore

protocol LandingMapViewProtocol: View {
    init(
        touchdown: CLLocationCoordinate2D,
        waypoints: [PatternWaypoint],
        blocked: Bool,
        hasWarnings: Bool,
        landingHeadingDeg: Double,
        windLayers: [WindLayer],
        onTouchdownChange: @escaping (CLLocationCoordinate2D) -> Void,
        onHeadingChange: @escaping (CLLocationCoordinate2D) -> Void
    )
}

enum MapStackChoice: String, Codable, CaseIterable, Identifiable {
    case mapKit
    case mapbox

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mapKit: return "MapKit"
        case .mapbox: return "Mapbox"
        }
    }
}
