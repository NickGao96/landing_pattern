import CoreLocation
import SwiftUI
import LandingPatternCore

enum LandingBasemapStyle: String, Codable {
    case appleDefault
    case tokenlessSatellite
}

protocol LandingMapViewProtocol: View {
    init(
        isWingsuitAutoMode: Bool,
        touchdown: CLLocationCoordinate2D,
        waypoints: [PatternWaypoint],
        autoOutput: WingsuitAutoOutput?,
        landingPoint: CLLocationCoordinate2D,
        jumpRunStart: CLLocationCoordinate2D,
        jumpRunEnd: CLLocationCoordinate2D,
        blocked: Bool,
        hasWarnings: Bool,
        landingHeadingDeg: Double,
        basemapStyle: LandingBasemapStyle,
        windLayers: [WindLayer],
        onTouchdownChange: @escaping (CLLocationCoordinate2D) -> Void,
        onHeadingChange: @escaping (CLLocationCoordinate2D) -> Void,
        onLandingPointChange: @escaping (CLLocationCoordinate2D) -> Void,
        onJumpRunStartChange: @escaping (CLLocationCoordinate2D) -> Void,
        onJumpRunEndChange: @escaping (CLLocationCoordinate2D) -> Void
    )
}

enum MapStackChoice: String, Codable, CaseIterable, Identifiable {
    case mapKit
    case mapbox

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mapKit: return "Apple Map"
        case .mapbox: return "Tokenless Satellite"
        }
    }
}
