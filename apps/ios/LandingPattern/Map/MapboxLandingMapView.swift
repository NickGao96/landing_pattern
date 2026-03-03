import SwiftUI
import CoreLocation
import LandingPatternCore

#if canImport(MapboxMaps)
import MapboxMaps

struct MapboxLandingMapView: LandingMapViewProtocol {
    init(
        touchdown: CLLocationCoordinate2D,
        waypoints: [PatternWaypoint],
        blocked: Bool,
        hasWarnings: Bool,
        landingHeadingDeg: Double,
        windLayers: [WindLayer],
        onTouchdownChange: @escaping (CLLocationCoordinate2D) -> Void,
        onHeadingChange: @escaping (CLLocationCoordinate2D) -> Void
    ) {
        // TODO: Implement full Mapbox variant if MapKit spike fails criteria.
    }

    var body: some View {
        Text("Mapbox implementation pending")
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#else
struct MapboxLandingMapView: LandingMapViewProtocol {
    init(
        touchdown: CLLocationCoordinate2D,
        waypoints: [PatternWaypoint],
        blocked: Bool,
        hasWarnings: Bool,
        landingHeadingDeg: Double,
        windLayers: [WindLayer],
        onTouchdownChange: @escaping (CLLocationCoordinate2D) -> Void,
        onHeadingChange: @escaping (CLLocationCoordinate2D) -> Void
    ) {}

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "map")
                .font(.system(size: 26, weight: .medium))
            Text("Mapbox SDK not linked")
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text("MapKit is selected by default for tokenless baseline.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.thinMaterial)
    }
}
#endif
