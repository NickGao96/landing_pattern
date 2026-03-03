import CoreLocation
import LandingPatternCore
import SwiftUI

struct MapboxLandingMapView: LandingMapViewProtocol {
    private let inner: MapKitLandingMapView

    init(
        touchdown: CLLocationCoordinate2D,
        waypoints: [PatternWaypoint],
        blocked: Bool,
        hasWarnings: Bool,
        landingHeadingDeg: Double,
        basemapStyle: LandingBasemapStyle,
        windLayers: [WindLayer],
        onTouchdownChange: @escaping (CLLocationCoordinate2D) -> Void,
        onHeadingChange: @escaping (CLLocationCoordinate2D) -> Void
    ) {
        let style: LandingBasemapStyle = basemapStyle == .tokenlessSatellite ? .tokenlessSatellite : .appleDefault
        inner = MapKitLandingMapView(
            touchdown: touchdown,
            waypoints: waypoints,
            blocked: blocked,
            hasWarnings: hasWarnings,
            landingHeadingDeg: landingHeadingDeg,
            basemapStyle: style,
            windLayers: windLayers,
            onTouchdownChange: onTouchdownChange,
            onHeadingChange: onHeadingChange
        )
    }

    var body: some View {
        inner
    }
}
