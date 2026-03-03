import CoreLocation
import LandingPatternCore
import MapKit
import SwiftUI

struct MapKitLandingMapView: UIViewRepresentable, LandingMapViewProtocol {
    let touchdown: CLLocationCoordinate2D
    let waypoints: [PatternWaypoint]
    let blocked: Bool
    let hasWarnings: Bool
    let landingHeadingDeg: Double
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

        if #available(iOS 17.0, *) {
            map.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .flat)
        } else {
            map.mapType = .satellite
        }

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
        var parent: MapKitLandingMapView

        private var touchdownAnnotation: TouchdownAnnotation?
        private var headingHandleAnnotation: HeadingHandleAnnotation?
        private var turnAnnotations: [TurnPointAnnotation] = []
        private var arrowAnnotations: [SegmentArrowAnnotation] = []

        private var patternOverlay: MKPolyline?
        private var headingOverlay: MKPolyline?
        private var didSetInitialRegion = false
        private var isInternalUpdate = false

        private let headingHandleRadiusMeters: CLLocationDistance = 90

        init(_ parent: MapKitLandingMapView) {
            self.parent = parent
        }

        func sync(with parent: MapKitLandingMapView, in map: MKMapView) {
            isInternalUpdate = true
            defer { isInternalUpdate = false }

            upsertTouchdownAnnotation(on: map, coordinate: parent.touchdown)
            upsertHeadingHandle(on: map, touchdown: parent.touchdown, headingDeg: parent.landingHeadingDeg)
            updateTurnPointAnnotations(on: map, waypoints: parent.waypoints)
            updateArrowAnnotations(on: map, waypoints: parent.waypoints)
            updateOverlays(on: map, waypoints: parent.waypoints, touchdown: parent.touchdown, headingDeg: parent.landingHeadingDeg)

            if !didSetInitialRegion {
                didSetInitialRegion = true
                let mapRect = makeFittingRect(
                    touchdown: parent.touchdown,
                    headingHandle: headingHandleCoordinate(touchdown: parent.touchdown, headingDeg: parent.landingHeadingDeg),
                    waypoints: parent.waypoints
                )
                map.setVisibleMapRect(mapRect, edgePadding: UIEdgeInsets(top: 80, left: 60, bottom: 80, right: 60), animated: false)
            }
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
                    label: waypointLabel(for: waypoint)
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
                let midpoint = CLLocationCoordinate2D(
                    latitude: (start.latitude + end.latitude) / 2,
                    longitude: (start.longitude + end.longitude) / 2
                )
                let heading = bearing(from: start, to: end)
                annotations.append(SegmentArrowAnnotation(coordinate: midpoint, headingDeg: heading))
            }

            arrowAnnotations = annotations
            map.addAnnotations(annotations)
        }

        private func updateOverlays(on map: MKMapView, waypoints: [PatternWaypoint], touchdown: CLLocationCoordinate2D, headingDeg: Double) {
            if let patternOverlay {
                map.removeOverlay(patternOverlay)
            }
            if let headingOverlay {
                map.removeOverlay(headingOverlay)
            }
            patternOverlay = nil
            headingOverlay = nil

            if waypoints.count >= 2 {
                var coordinates = waypoints.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
                let line = MKPolyline(coordinates: &coordinates, count: coordinates.count)
                patternOverlay = line
                map.addOverlay(line, level: .aboveRoads)
            }

            var headingCoordinates = [
                touchdown,
                headingHandleCoordinate(touchdown: touchdown, headingDeg: headingDeg)
            ]
            let headingLine = MKPolyline(coordinates: &headingCoordinates, count: headingCoordinates.count)
            headingOverlay = headingLine
            map.addOverlay(headingLine, level: .aboveRoads)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKUserLocation {
                return nil
            }

            if annotation is TouchdownAnnotation {
                let reuseId = "touchdown"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.markerTintColor = .systemRed
                view.glyphImage = UIImage(systemName: "target")
                view.canShowCallout = false
                view.isDraggable = true
                return view
            }

            if annotation is HeadingHandleAnnotation {
                let reuseId = "heading-handle"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.markerTintColor = .systemOrange
                view.glyphImage = UIImage(systemName: "arrow.up.circle.fill")
                view.canShowCallout = false
                view.isDraggable = true
                return view
            }

            if let annotation = annotation as? TurnPointAnnotation {
                let reuseId = "turn-point"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.markerTintColor = .white
                view.glyphText = annotation.label
                view.titleVisibility = .hidden
                view.subtitleVisibility = .hidden
                view.canShowCallout = false
                view.isDraggable = false
                return view
            }

            if let annotation = annotation as? SegmentArrowAnnotation {
                let reuseId = "segment-arrow"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: reuseId)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.canShowCallout = false
                view.image = UIImage(systemName: "arrowtriangle.up.fill")?.withTintColor(.systemBlue, renderingMode: .alwaysOriginal)
                view.transform = CGAffineTransform(rotationAngle: annotation.headingDeg * .pi / 180)
                view.centerOffset = CGPoint(x: 0, y: -4)
                return view
            }

            return nil
        }

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let polyline = overlay as? MKPolyline else {
                return MKOverlayRenderer(overlay: overlay)
            }
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.lineJoin = .round
            renderer.lineCap = .round

            if overlay === headingOverlay {
                renderer.strokeColor = .systemOrange
                renderer.lineWidth = 3
                renderer.lineDashPattern = [6, 5]
            } else {
                renderer.strokeColor = parent.blocked ? .systemGray : .systemOrange
                renderer.lineWidth = 4
            }

            return renderer
        }

        func mapView(
            _ mapView: MKMapView,
            annotationView view: MKAnnotationView,
            didChange newState: MKAnnotationView.DragState,
            fromOldState oldState: MKAnnotationView.DragState
        ) {
            guard !isInternalUpdate else { return }
            guard newState == .ending || newState == .canceling || newState == .dragging else { return }
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
            return "\(Int(round(waypoint.altFt)))"
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

            return CLLocationCoordinate2D(
                latitude: lat2 * 180 / .pi,
                longitude: lon2 * 180 / .pi
            )
        }

        private func bearing(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) -> Double {
            let lat1 = from.latitude * .pi / 180
            let lat2 = to.latitude * .pi / 180
            let deltaLon = (to.longitude - from.longitude) * .pi / 180
            let y = sin(deltaLon) * cos(lat2)
            let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(deltaLon)
            var heading = atan2(y, x) * 180 / .pi
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
            var points: [MKMapPoint] = [
                MKMapPoint(touchdown),
                MKMapPoint(headingHandle),
            ]
            points.append(contentsOf: waypoints.map { MKMapPoint(CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng)) })
            guard let first = points.first else { return MKMapRect.world }

            var rect = MKMapRect(x: first.x, y: first.y, width: 0, height: 0)
            for point in points.dropFirst() {
                rect = rect.union(MKMapRect(x: point.x, y: point.y, width: 0, height: 0))
            }
            if rect.size.width < 800 || rect.size.height < 800 {
                let center = MKMapPoint(
                    x: rect.origin.x + rect.size.width / 2,
                    y: rect.origin.y + rect.size.height / 2
                )
                let minimumSize = MKMapSize(width: max(rect.size.width, 1200), height: max(rect.size.height, 1200))
                rect = MKMapRect(
                    x: center.x - minimumSize.width / 2,
                    y: center.y - minimumSize.height / 2,
                    width: minimumSize.width,
                    height: minimumSize.height
                )
            }
            return rect
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

    init(coordinate: CLLocationCoordinate2D, label: String) {
        self.coordinate = coordinate
        self.label = label
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
