import CoreLocation
import LandingPatternCore
import SwiftUI

struct MapboxLandingMapView: LandingMapViewProtocol {
    private let inner: MapKitLandingMapView

    init(
        isWingsuitAutoMode: Bool,
        touchdown: CLLocationCoordinate2D,
        waypoints: [PatternWaypoint],
        autoOutput: WingsuitAutoOutput?,
        landingPoint: CLLocationCoordinate2D,
        blocked: Bool,
        hasWarnings: Bool,
        landingHeadingDeg: Double,
        basemapStyle: LandingBasemapStyle,
        windLayers: [WindLayer],
        onTouchdownChange: @escaping (CLLocationCoordinate2D) -> Void,
        onHeadingChange: @escaping (CLLocationCoordinate2D) -> Void,
        onLandingPointChange: @escaping (CLLocationCoordinate2D) -> Void
    ) {
        let style: LandingBasemapStyle = basemapStyle == .tokenlessSatellite ? .tokenlessSatellite : .appleDefault
        inner = MapKitLandingMapView(
            isWingsuitAutoMode: isWingsuitAutoMode,
            touchdown: touchdown,
            waypoints: waypoints,
            autoOutput: autoOutput,
            landingPoint: landingPoint,
            blocked: blocked,
            hasWarnings: hasWarnings,
            landingHeadingDeg: landingHeadingDeg,
            basemapStyle: style,
            windLayers: windLayers,
            onTouchdownChange: onTouchdownChange,
            onHeadingChange: onHeadingChange,
            onLandingPointChange: onLandingPointChange
        )
    }

    var body: some View {
        inner
    }
}
