import CoreLocation
import LandingPatternCore
import MapKit
import SwiftUI
import UIKit

struct MapKitLandingMapView: UIViewRepresentable, LandingMapViewProtocol {
    let touchdown: CLLocationCoordinate2D
    let waypoints: [PatternWaypoint]
    let blocked: Bool
    let hasWarnings: Bool
    let landingHeadingDeg: Double
    let basemapStyle: LandingBasemapStyle
    let windLayers: [WindLayer]
    let onTouchdownChange: (CLLocationCoordinate2D) -> Void
    let onHeadingChange: (CLLocationCoordinate2D) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView(frame: .zero)
        map.delegate = context.coordinator
        map.showsCompass = true
        map.showsScale = true
        map.pointOfInterestFilter = .excludingAll
        map.isRotateEnabled = false
        map.isPitchEnabled = false
        map.overrideUserInterfaceStyle = .light

        context.coordinator.configureBaseMap(map, style: basemapStyle)
        context.coordinator.sync(with: self, in: map)
        return map
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.sync(with: self, in: mapView)
    }
}

extension MapKitLandingMapView {
    final class Coordinator: NSObject, MKMapViewDelegate {
        private enum OverlayRole {
            case segmentOutline
            case downwind
            case base
            case final
            case headingGuide
        }

        var parent: MapKitLandingMapView

        private var touchdownAnnotation: TouchdownAnnotation?
        private var headingHandleAnnotation: HeadingHandleAnnotation?
        private var turnAnnotations: [TurnPointAnnotation] = []
        private var arrowAnnotations: [SegmentArrowAnnotation] = []

        private var activeOverlays: [MKPolyline] = []
        private var overlayRoles: [ObjectIdentifier: OverlayRole] = [:]
        private var didSetInitialRegion = false
        private var didApplyMapFallbackStyle = false
        private var isInternalUpdate = false
        private var lastFittedTouchdown: CLLocationCoordinate2D?
        private var lastFittedPatternRect: MKMapRect?
        private var appliedBasemapStyle: LandingBasemapStyle?
        private var imageryOverlay: MKTileOverlay?
        private var labelOverlay: MKTileOverlay?

        private let headingHandleRadiusMeters: CLLocationDistance = 90

        init(_ parent: MapKitLandingMapView) {
            self.parent = parent
        }

        func configureBaseMap(_ map: MKMapView, style: LandingBasemapStyle) {
            guard appliedBasemapStyle != style else { return }
            appliedBasemapStyle = style
            didApplyMapFallbackStyle = false

            removeExternalTileOverlays(from: map)

            switch style {
            case .appleDefault:
#if targetEnvironment(simulator)
                if #available(iOS 17.0, *) {
                    map.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat)
                } else {
                    map.mapType = .standard
                }
#else
                if #available(iOS 17.0, *) {
                    map.preferredConfiguration = MKHybridMapConfiguration(elevationStyle: .flat)
                } else {
                    map.mapType = .hybrid
                }
#endif
            case .tokenlessSatellite:
                if #available(iOS 17.0, *) {
                    map.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat)
                } else {
                    map.mapType = .standard
                }
                addExternalSatelliteTiles(to: map)
            }
        }

        private func removeExternalTileOverlays(from map: MKMapView) {
            if let imageryOverlay {
                map.removeOverlay(imageryOverlay)
            }
            if let labelOverlay {
                map.removeOverlay(labelOverlay)
            }
            imageryOverlay = nil
            labelOverlay = nil
        }

        private func addExternalSatelliteTiles(to map: MKMapView) {
            let imagery = MKTileOverlay(
                urlTemplate: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            )
            imagery.canReplaceMapContent = true
            imagery.minimumZ = 0
            imagery.maximumZ = 19
            imageryOverlay = imagery
            map.addOverlay(imagery, level: .aboveRoads)

            let labels = MKTileOverlay(
                urlTemplate: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            )
            labels.canReplaceMapContent = false
            labels.minimumZ = 0
            labels.maximumZ = 19
            labelOverlay = labels
            map.addOverlay(labels, level: .aboveLabels)
        }

        func sync(with parent: MapKitLandingMapView, in map: MKMapView) {
            isInternalUpdate = true
            defer { isInternalUpdate = false }

            guard isFiniteCoordinate(parent.touchdown) else {
                print("[Map] Invalid touchdown coordinate. Skipping sync.")
                return
            }

            configureBaseMap(map, style: parent.basemapStyle)

            let headingDeg = parent.landingHeadingDeg.isFinite ? normalizeHeading(parent.landingHeadingDeg) : 0
            let finiteWaypoints = sanitizedWaypoints(parent.waypoints)
            if finiteWaypoints.count != parent.waypoints.count {
                print("[Map] Dropped \(parent.waypoints.count - finiteWaypoints.count) invalid waypoint(s).")
            }

            upsertTouchdownAnnotation(on: map, coordinate: parent.touchdown)
            upsertHeadingHandle(on: map, touchdown: parent.touchdown, headingDeg: headingDeg)
            updateTurnPointAnnotations(on: map, waypoints: finiteWaypoints)
            updateArrowAnnotations(on: map, waypoints: finiteWaypoints)
            updateOverlays(on: map, waypoints: finiteWaypoints, touchdown: parent.touchdown, headingDeg: headingDeg)

            let mapRect = makeFittingRect(
                touchdown: parent.touchdown,
                headingHandle: headingHandleCoordinate(touchdown: parent.touchdown, headingDeg: headingDeg),
                waypoints: finiteWaypoints
            )
            let shouldRefit = shouldRefitMap(
                map: map,
                touchdown: parent.touchdown,
                requiredRect: mapRect
            )
            if shouldRefit {
                let shouldAnimate = didSetInitialRegion
                didSetInitialRegion = true
                lastFittedTouchdown = parent.touchdown
                lastFittedPatternRect = mapRect
                if !mapRect.origin.x.isFinite || !mapRect.origin.y.isFinite || !mapRect.size.width.isFinite || !mapRect.size.height.isFinite {
                    print("[Map] Computed map rect is invalid. Skipping camera update.")
                    return
                }
                map.setVisibleMapRect(
                    mapRect,
                    edgePadding: UIEdgeInsets(top: 48, left: 36, bottom: 56, right: 36),
                    animated: shouldAnimate
                )
            }
        }

        private func isFiniteCoordinate(_ coordinate: CLLocationCoordinate2D) -> Bool {
            CLLocationCoordinate2DIsValid(coordinate) &&
                coordinate.latitude.isFinite &&
                coordinate.longitude.isFinite
        }

        private func sanitizedWaypoints(_ waypoints: [PatternWaypoint]) -> [PatternWaypoint] {
            waypoints.filter {
                $0.altFt.isFinite &&
                    isFiniteCoordinate(CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng))
            }
        }

        private func shouldRefitMap(
            map: MKMapView,
            touchdown: CLLocationCoordinate2D,
            requiredRect: MKMapRect
        ) -> Bool {
            guard didSetInitialRegion else { return true }
            guard requiredRect.size.width.isFinite, requiredRect.size.height.isFinite else { return true }
            guard map.visibleMapRect.size.width > 0, map.visibleMapRect.size.height > 0 else { return true }

            if let previous = lastFittedTouchdown {
                let a = CLLocation(latitude: previous.latitude, longitude: previous.longitude)
                let b = CLLocation(latitude: touchdown.latitude, longitude: touchdown.longitude)
                if a.distance(from: b) > 1 {
                    return true
                }
            } else {
                return true
            }

            // Refit when pattern bounds change materially in size (winds/gates/airspeed edits).
            if let previousRect = lastFittedPatternRect {
                let previousWidth = max(previousRect.size.width, 1)
                let previousHeight = max(previousRect.size.height, 1)
                let widthRatio = requiredRect.size.width / previousWidth
                let heightRatio = requiredRect.size.height / previousHeight
                if widthRatio > 1.25 || widthRatio < 0.8 || heightRatio > 1.25 || heightRatio < 0.8 {
                    return true
                }
            } else {
                return true
            }

            // Keep the full pattern comfortably visible.
            let visible = map.visibleMapRect
            let safeVisible = visible.insetBy(
                dx: visible.size.width * 0.12,
                dy: visible.size.height * 0.12
            )
            if !safeVisible.contains(requiredRect) {
                return true
            }

            let occupancyX = requiredRect.size.width / max(visible.size.width, 1)
            let occupancyY = requiredRect.size.height / max(visible.size.height, 1)
            if occupancyX < 0.16 || occupancyY < 0.16 || occupancyX > 0.78 || occupancyY > 0.78 {
                return true
            }

            return false
        }

        private func upsertTouchdownAnnotation(on map: MKMapView, coordinate: CLLocationCoordinate2D) {
            if let annotation = touchdownAnnotation {
                annotation.coordinate = coordinate
                return
            }
            let annotation = TouchdownAnnotation(coordinate: coordinate)
            touchdownAnnotation = annotation
            map.addAnnotation(annotation)
        }

        private func upsertHeadingHandle(on map: MKMapView, touchdown: CLLocationCoordinate2D, headingDeg: Double) {
            let handleCoordinate = headingHandleCoordinate(touchdown: touchdown, headingDeg: headingDeg)
            if let annotation = headingHandleAnnotation {
                annotation.coordinate = handleCoordinate
                return
            }
            let annotation = HeadingHandleAnnotation(coordinate: handleCoordinate)
            headingHandleAnnotation = annotation
            map.addAnnotation(annotation)
        }

        private func updateTurnPointAnnotations(on map: MKMapView, waypoints: [PatternWaypoint]) {
            if !turnAnnotations.isEmpty {
                map.removeAnnotations(turnAnnotations)
                turnAnnotations.removeAll()
            }

            let annotations = waypoints.map { waypoint in
                TurnPointAnnotation(
                    coordinate: CLLocationCoordinate2D(latitude: waypoint.lat, longitude: waypoint.lng),
                    label: waypointLabel(for: waypoint),
                    waypointName: waypoint.name
                )
            }
            turnAnnotations = annotations
            map.addAnnotations(annotations)
        }

        private func updateArrowAnnotations(on map: MKMapView, waypoints: [PatternWaypoint]) {
            if !arrowAnnotations.isEmpty {
                map.removeAnnotations(arrowAnnotations)
                arrowAnnotations.removeAll()
            }

            guard waypoints.count >= 2 else { return }
            var annotations: [SegmentArrowAnnotation] = []
            for index in 0..<(waypoints.count - 1) {
                let start = CLLocationCoordinate2D(latitude: waypoints[index].lat, longitude: waypoints[index].lng)
                let end = CLLocationCoordinate2D(latitude: waypoints[index + 1].lat, longitude: waypoints[index + 1].lng)
                guard isFiniteCoordinate(start), isFiniteCoordinate(end) else { continue }
                let midpoint = CLLocationCoordinate2D(
                    latitude: (start.latitude + end.latitude) / 2,
                    longitude: (start.longitude + end.longitude) / 2
                )
                guard isFiniteCoordinate(midpoint) else { continue }
                let heading = bearing(from: start, to: end)
                guard heading.isFinite else { continue }
                annotations.append(SegmentArrowAnnotation(coordinate: midpoint, headingDeg: heading))
            }

            arrowAnnotations = annotations
            map.addAnnotations(annotations)
        }

        private func updateOverlays(on map: MKMapView, waypoints: [PatternWaypoint], touchdown: CLLocationCoordinate2D, headingDeg: Double) {
            if !activeOverlays.isEmpty {
                map.removeOverlays(activeOverlays)
                activeOverlays.removeAll()
                overlayRoles.removeAll()
            }

            guard waypoints.count >= 2 else {
                addHeadingOverlay(on: map, touchdown: touchdown, headingDeg: headingDeg)
                return
            }

            for index in 0..<(waypoints.count - 1) {
                let role: OverlayRole
                switch index {
                case 0:
                    role = .downwind
                case 1:
                    role = .base
                default:
                    role = .final
                }

                var segmentCoordinates = [
                    CLLocationCoordinate2D(latitude: waypoints[index].lat, longitude: waypoints[index].lng),
                    CLLocationCoordinate2D(latitude: waypoints[index + 1].lat, longitude: waypoints[index + 1].lng),
                ]
                guard segmentCoordinates.allSatisfy(isFiniteCoordinate) else { continue }
                let outline = MKPolyline(coordinates: &segmentCoordinates, count: segmentCoordinates.count)
                let segment = MKPolyline(coordinates: &segmentCoordinates, count: segmentCoordinates.count)

                activeOverlays.append(outline)
                activeOverlays.append(segment)
                overlayRoles[ObjectIdentifier(outline)] = .segmentOutline
                overlayRoles[ObjectIdentifier(segment)] = role
            }

            map.addOverlays(activeOverlays, level: .aboveRoads)
            addHeadingOverlay(on: map, touchdown: touchdown, headingDeg: headingDeg)
        }

        private func addHeadingOverlay(on map: MKMapView, touchdown: CLLocationCoordinate2D, headingDeg: Double) {
            var headingCoordinates = [
                touchdown,
                headingHandleCoordinate(touchdown: touchdown, headingDeg: headingDeg),
            ]
            guard headingCoordinates.allSatisfy(isFiniteCoordinate) else { return }
            let heading = MKPolyline(coordinates: &headingCoordinates, count: headingCoordinates.count)
            activeOverlays.append(heading)
            overlayRoles[ObjectIdentifier(heading)] = .headingGuide
            map.addOverlay(heading, level: .aboveRoads)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKUserLocation {
                return nil
            }

            if annotation is TouchdownAnnotation {
                let reuseId = "touchdown"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: reuseId)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.canShowCallout = false
                view.isDraggable = true
                let config = UIImage.SymbolConfiguration(pointSize: 22, weight: .bold)
                view.image = UIImage(systemName: "mappin.circle.fill", withConfiguration: config)?
                    .withTintColor(UIColor.systemRed, renderingMode: .alwaysOriginal)
                view.centerOffset = CGPoint(x: 0, y: -11)
                return view
            }

            if annotation is HeadingHandleAnnotation {
                let reuseId = "heading-handle"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: reuseId)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.canShowCallout = false
                view.isDraggable = true
                let config = UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
                view.image = UIImage(systemName: "location.north.circle.fill", withConfiguration: config)?
                    .withTintColor(UIColor.systemOrange, renderingMode: .alwaysOriginal)
                view.centerOffset = CGPoint(x: 0, y: -10)
                return view
            }

            if let annotation = annotation as? TurnPointAnnotation {
                let reuseId = "turn-point-badge"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? TurnPointBadgeView)
                    ?? TurnPointBadgeView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.configure(text: annotation.label)
                view.centerOffset = annotation.badgeOffset
                return view
            }

            if let annotation = annotation as? SegmentArrowAnnotation {
                let reuseId = "segment-arrow"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: reuseId)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.canShowCallout = false
                let config = UIImage.SymbolConfiguration(pointSize: 14, weight: .bold)
                view.image = UIImage(systemName: "location.north.circle.fill", withConfiguration: config)?
                    .withTintColor(UIColor.systemIndigo, renderingMode: .alwaysOriginal)
                let safeHeading = annotation.headingDeg.isFinite ? annotation.headingDeg : 0
                view.transform = CGAffineTransform(rotationAngle: safeHeading * .pi / 180)
                view.centerOffset = CGPoint(x: 0, y: -4)
                return view
            }

            return nil
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let tileOverlay = overlay as? MKTileOverlay {
                let renderer = MKTileOverlayRenderer(tileOverlay: tileOverlay)
                renderer.alpha = 1
                return renderer
            }

            guard let polyline = overlay as? MKPolyline else {
                return MKOverlayRenderer(overlay: overlay)
            }

            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.lineJoin = .round
            renderer.lineCap = .round

            let role = overlayRoles[ObjectIdentifier(polyline)] ?? .segmentOutline
            switch role {
            case .segmentOutline:
                renderer.strokeColor = UIColor.white.withAlphaComponent(0.78)
                renderer.lineWidth = 7
            case .downwind:
                renderer.strokeColor = parent.blocked ? UIColor.systemGray : UIColor.systemTeal
                renderer.lineWidth = 4
            case .base:
                renderer.strokeColor = parent.blocked ? UIColor.systemGray : UIColor.systemBlue
                renderer.lineWidth = 4
            case .final:
                renderer.strokeColor = parent.blocked ? UIColor.systemRed : UIColor.systemOrange
                renderer.lineWidth = 4
            case .headingGuide:
                renderer.strokeColor = UIColor.systemOrange.withAlphaComponent(0.85)
                renderer.lineWidth = 3
                renderer.lineDashPattern = [5, 4]
            }

            return renderer
        }

        func mapView(_ mapView: MKMapView, didFailLoadingMapWithError error: Error) {
            guard !didApplyMapFallbackStyle else { return }
            didApplyMapFallbackStyle = true
            removeExternalTileOverlays(from: mapView)
            appliedBasemapStyle = .appleDefault
            if #available(iOS 17.0, *) {
                mapView.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat)
            } else {
                mapView.mapType = .standard
            }
        }

        func mapView(
            _ mapView: MKMapView,
            annotationView view: MKAnnotationView,
            didChange newState: MKAnnotationView.DragState,
            fromOldState oldState: MKAnnotationView.DragState
        ) {
            guard !isInternalUpdate else { return }
            guard newState == .ending || newState == .canceling else { return }
            guard let annotation = view.annotation else { return }

            if annotation is TouchdownAnnotation {
                parent.onTouchdownChange(annotation.coordinate)
                if let headingHandleAnnotation {
                    let headingCoordinate = headingHandleCoordinate(
                        touchdown: annotation.coordinate,
                        headingDeg: parent.landingHeadingDeg
                    )
                    isInternalUpdate = true
                    headingHandleAnnotation.coordinate = headingCoordinate
                    isInternalUpdate = false
                }
                return
            }

            if let headingAnnotation = annotation as? HeadingHandleAnnotation {
                let constrained = constrainedHeadingHandleCoordinate(candidate: headingAnnotation.coordinate)
                isInternalUpdate = true
                headingAnnotation.coordinate = constrained
                isInternalUpdate = false
                parent.onHeadingChange(constrained)
            }
        }

        private func waypointLabel(for waypoint: PatternWaypoint) -> String {
            if waypoint.name == .touchdown {
                return "TD"
            }
            return "\(Int(round(waypoint.altFt)))ft"
        }

        private func headingHandleCoordinate(touchdown: CLLocationCoordinate2D, headingDeg: Double) -> CLLocationCoordinate2D {
            coordinate(atDistance: headingHandleRadiusMeters, from: touchdown, bearingDeg: headingDeg)
        }

        private func constrainedHeadingHandleCoordinate(candidate: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
            guard let touchdownAnnotation else { return candidate }
            let heading = bearing(from: touchdownAnnotation.coordinate, to: candidate)
            return coordinate(atDistance: headingHandleRadiusMeters, from: touchdownAnnotation.coordinate, bearingDeg: heading)
        }

        private func coordinate(atDistance distanceMeters: CLLocationDistance, from origin: CLLocationCoordinate2D, bearingDeg: Double) -> CLLocationCoordinate2D {
            guard isFiniteCoordinate(origin), distanceMeters.isFinite, bearingDeg.isFinite else {
                return origin
            }
            let earthRadius = 6_378_137.0
            let angularDistance = distanceMeters / earthRadius
            let bearing = bearingDeg * .pi / 180
            let lat1 = origin.latitude * .pi / 180
            let lon1 = origin.longitude * .pi / 180

            let lat2 = asin(sin(lat1) * cos(angularDistance) + cos(lat1) * sin(angularDistance) * cos(bearing))
            let lon2 = lon1 + atan2(
                sin(bearing) * sin(angularDistance) * cos(lat1),
                cos(angularDistance) - sin(lat1) * sin(lat2)
            )

            let candidate = CLLocationCoordinate2D(
                latitude: lat2 * 180 / .pi,
                longitude: lon2 * 180 / .pi
            )
            return isFiniteCoordinate(candidate) ? candidate : origin
        }

        private func bearing(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) -> Double {
            guard isFiniteCoordinate(from), isFiniteCoordinate(to) else { return 0 }
            let lat1 = from.latitude * .pi / 180
            let lat2 = to.latitude * .pi / 180
            let deltaLon = (to.longitude - from.longitude) * .pi / 180
            let y = sin(deltaLon) * cos(lat2)
            let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(deltaLon)
            var heading = atan2(y, x) * 180 / .pi
            if !heading.isFinite {
                return 0
            }
            if heading < 0 {
                heading += 360
            }
            return heading
        }

        private func makeFittingRect(
            touchdown: CLLocationCoordinate2D,
            headingHandle: CLLocationCoordinate2D,
            waypoints: [PatternWaypoint]
        ) -> MKMapRect {
            let fallbackCoordinate = isFiniteCoordinate(touchdown) ? touchdown : CLLocationCoordinate2D(latitude: 0, longitude: 0)
            var coordinates: [CLLocationCoordinate2D] = []
            if isFiniteCoordinate(touchdown) {
                coordinates.append(touchdown)
            }
            if isFiniteCoordinate(headingHandle) {
                coordinates.append(headingHandle)
            }
            coordinates.append(contentsOf: waypoints.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }.filter(isFiniteCoordinate))

            let points = coordinates.map(MKMapPoint.init)
            guard let first = points.first else { return MKMapRect.world }

            var rect = MKMapRect(x: first.x, y: first.y, width: 0, height: 0)
            for point in points.dropFirst() {
                rect = rect.union(MKMapRect(x: point.x, y: point.y, width: 0, height: 0))
            }
            if !rect.origin.x.isFinite || !rect.origin.y.isFinite || !rect.size.width.isFinite || !rect.size.height.isFinite {
                let center = MKMapPoint(fallbackCoordinate)
                return MKMapRect(x: center.x - 600, y: center.y - 600, width: 1200, height: 1200)
            }

            if rect.size.width < 1 || rect.size.height < 1 {
                let center = MKMapPoint(
                    x: rect.origin.x + rect.size.width / 2,
                    y: rect.origin.y + rect.size.height / 2
                )
                let minimumSize = MKMapSize(
                    width: max(rect.size.width, 220),
                    height: max(rect.size.height, 220)
                )
                rect = MKMapRect(
                    x: center.x - minimumSize.width / 2,
                    y: center.y - minimumSize.height / 2,
                    width: minimumSize.width,
                    height: minimumSize.height
                )
            }
            let padded = rect.insetBy(
                dx: -(rect.size.width * 0.22 + 140),
                dy: -(rect.size.height * 0.22 + 140)
            )
            return padded
        }
    }
}

private final class TouchdownAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D
    init(coordinate: CLLocationCoordinate2D) {
        self.coordinate = coordinate
    }
}

private final class HeadingHandleAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D
    init(coordinate: CLLocationCoordinate2D) {
        self.coordinate = coordinate
    }
}

private final class TurnPointAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D
    let label: String
    let waypointName: PatternWaypointName

    var badgeOffset: CGPoint {
        switch waypointName {
        case .downwindStart:
            return CGPoint(x: 0, y: -24)
        case .baseStart:
            return CGPoint(x: 26, y: -6)
        case .finalStart:
            return CGPoint(x: 18, y: 18)
        case .touchdown:
            return CGPoint(x: 0, y: 22)
        }
    }

    init(coordinate: CLLocationCoordinate2D, label: String, waypointName: PatternWaypointName) {
        self.coordinate = coordinate
        self.label = label
        self.waypointName = waypointName
    }
}

private final class SegmentArrowAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D
    let headingDeg: Double

    init(coordinate: CLLocationCoordinate2D, headingDeg: Double) {
        self.coordinate = coordinate
        self.headingDeg = headingDeg
    }
}

private final class TurnPointBadgeView: MKAnnotationView {
    private let label = UILabel()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        canShowCallout = false
        frame = CGRect(x: 0, y: 0, width: 44, height: 24)
        centerOffset = CGPoint(x: 0, y: -14)
        layer.cornerRadius = 12
        layer.masksToBounds = true
        layer.borderWidth = 1
        layer.borderColor = UIColor.white.withAlphaComponent(0.8).cgColor
        backgroundColor = UIColor.black.withAlphaComponent(0.6)

        label.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.textAlignment = .center
        label.frame = bounds
        addSubview(label)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds
    }

    func configure(text: String) {
        label.text = text
    }
}
