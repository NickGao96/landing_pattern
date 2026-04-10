import CoreLocation
import LandingPatternCore
import MapKit
import SwiftUI
import UIKit

struct MapKitLandingMapView: UIViewRepresentable, LandingMapViewProtocol {
    let isWingsuitAutoMode: Bool
    let touchdown: CLLocationCoordinate2D
    let waypoints: [PatternWaypoint]
    let autoOutput: WingsuitAutoOutput?
    let landingPoint: CLLocationCoordinate2D
    let jumpRunStart: CLLocationCoordinate2D
    let jumpRunEnd: CLLocationCoordinate2D
    let blocked: Bool
    let hasWarnings: Bool
    let landingHeadingDeg: Double
    let basemapStyle: LandingBasemapStyle
    let windLayers: [WindLayer]
    let onTouchdownChange: (CLLocationCoordinate2D) -> Void
    let onHeadingChange: (CLLocationCoordinate2D) -> Void
    let onLandingPointChange: (CLLocationCoordinate2D) -> Void
    let onJumpRunStartChange: (CLLocationCoordinate2D) -> Void
    let onJumpRunEndChange: (CLLocationCoordinate2D) -> Void

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
            case jumpRun
            case forbiddenZone
            case feasibleDeployRegion
        }

        var parent: MapKitLandingMapView

        private var touchdownAnnotation: TouchdownAnnotation?
        private var headingHandleAnnotation: HeadingHandleAnnotation?
        private var landingPointAnnotation: LandingPointAnnotation?
        private var jumpRunStartAnnotation: JumpRunHandleAnnotation?
        private var jumpRunEndAnnotation: JumpRunHandleAnnotation?
        private var routePointAnnotations: [LabeledPointAnnotation] = []
        private var arrowAnnotations: [SegmentArrowAnnotation] = []

        private var activeOverlays: [MKOverlay] = []
        private var overlayRoles: [ObjectIdentifier: OverlayRole] = [:]
        private var didSetInitialRegion = false
        private var didApplyMapFallbackStyle = false
        private var isInternalUpdate = false
        private var lastFittedAnchor: CLLocationCoordinate2D?
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

            configureBaseMap(map, style: parent.basemapStyle)

            if parent.isWingsuitAutoMode {
                syncAuto(with: parent, in: map)
            } else {
                syncManual(with: parent, in: map)
            }
        }

        private func syncManual(with parent: MapKitLandingMapView, in map: MKMapView) {
            guard isFiniteCoordinate(parent.touchdown) else {
                return
            }

            removeAutoAnnotations(from: map)

            let headingDeg = parent.landingHeadingDeg.isFinite ? normalizeHeading(parent.landingHeadingDeg) : 0
            let finiteWaypoints = sanitizedPatternWaypoints(parent.waypoints)

            upsertTouchdownAnnotation(on: map, coordinate: parent.touchdown)
            upsertHeadingHandle(on: map, touchdown: parent.touchdown, headingDeg: headingDeg)
            updateRoutePointAnnotations(on: map, manualWaypoints: finiteWaypoints)
            updateArrowAnnotations(on: map, coordinates: coordinates(from: finiteWaypoints))
            updateOverlays(
                on: map,
                routeCoordinates: coordinates(from: finiteWaypoints),
                headingGuide: (parent.touchdown, headingDeg),
                jumpRun: nil,
                forbiddenPolygon: [],
                feasiblePolygon: []
            )

            let fitCoordinates = [parent.touchdown, headingHandleCoordinate(touchdown: parent.touchdown, headingDeg: headingDeg)] +
                coordinates(from: finiteWaypoints)
            fitMap(on: map, anchor: parent.touchdown, coordinates: fitCoordinates)
        }

        private func syncAuto(with parent: MapKitLandingMapView, in map: MKMapView) {
            guard isFiniteCoordinate(parent.landingPoint),
                  isFiniteCoordinate(parent.jumpRunStart),
                  isFiniteCoordinate(parent.jumpRunEnd) else {
                return
            }

            removeManualAnnotations(from: map)

            upsertLandingPointAnnotation(on: map, coordinate: parent.landingPoint)
            upsertJumpRunHandleAnnotations(on: map, start: parent.jumpRunStart, end: parent.jumpRunEnd)

            let routeWaypoints = sanitizedAutoWaypoints(parent.autoOutput?.routeWaypoints ?? [])
            updateRoutePointAnnotations(on: map, autoWaypoints: routeWaypoints)
            updateArrowAnnotations(on: map, coordinates: coordinates(from: routeWaypoints))

            let forbiddenPolygon = polygonCoordinates(from: parent.autoOutput?.forbiddenZonePolygon ?? [])
            let feasiblePolygon = polygonCoordinates(from: parent.autoOutput?.feasibleDeployRegionPolygon ?? [])

            updateOverlays(
                on: map,
                routeCoordinates: coordinates(from: routeWaypoints),
                headingGuide: nil,
                jumpRun: (parent.jumpRunStart, parent.jumpRunEnd),
                forbiddenPolygon: forbiddenPolygon,
                feasiblePolygon: feasiblePolygon
            )

            let fitCoordinates = [parent.landingPoint, parent.jumpRunStart, parent.jumpRunEnd] +
                coordinates(from: routeWaypoints) +
                forbiddenPolygon +
                feasiblePolygon
            fitMap(on: map, anchor: parent.landingPoint, coordinates: fitCoordinates)
        }

        private func fitMap(on map: MKMapView, anchor: CLLocationCoordinate2D, coordinates: [CLLocationCoordinate2D]) {
            let mapRect = makeFittingRect(coordinates: coordinates)
            let shouldRefit = shouldRefitMap(map: map, anchor: anchor, requiredRect: mapRect)
            if shouldRefit {
                let shouldAnimate = didSetInitialRegion
                didSetInitialRegion = true
                lastFittedAnchor = anchor
                lastFittedPatternRect = mapRect
                guard mapRect.origin.x.isFinite,
                      mapRect.origin.y.isFinite,
                      mapRect.size.width.isFinite,
                      mapRect.size.height.isFinite else {
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

        private func sanitizedPatternWaypoints(_ waypoints: [PatternWaypoint]) -> [PatternWaypoint] {
            waypoints.filter {
                $0.altFt.isFinite &&
                    isFiniteCoordinate(CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng))
            }
        }

        private func sanitizedAutoWaypoints(_ waypoints: [WingsuitAutoWaypoint]) -> [WingsuitAutoWaypoint] {
            waypoints.filter {
                $0.altFt.isFinite &&
                    isFiniteCoordinate(CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng))
            }
        }

        private func shouldRefitMap(
            map: MKMapView,
            anchor: CLLocationCoordinate2D,
            requiredRect: MKMapRect
        ) -> Bool {
            guard didSetInitialRegion else { return true }
            guard requiredRect.size.width.isFinite, requiredRect.size.height.isFinite else { return true }
            guard map.visibleMapRect.size.width > 0, map.visibleMapRect.size.height > 0 else { return true }

            if let previous = lastFittedAnchor {
                let a = CLLocation(latitude: previous.latitude, longitude: previous.longitude)
                let b = CLLocation(latitude: anchor.latitude, longitude: anchor.longitude)
                if a.distance(from: b) > 1 {
                    return true
                }
            } else {
                return true
            }

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

        private func removeManualAnnotations(from map: MKMapView) {
            if let touchdownAnnotation {
                map.removeAnnotation(touchdownAnnotation)
                self.touchdownAnnotation = nil
            }
            if let headingHandleAnnotation {
                map.removeAnnotation(headingHandleAnnotation)
                self.headingHandleAnnotation = nil
            }
        }

        private func removeAutoAnnotations(from map: MKMapView) {
            if let landingPointAnnotation {
                map.removeAnnotation(landingPointAnnotation)
                self.landingPointAnnotation = nil
            }
            if let jumpRunStartAnnotation {
                map.removeAnnotation(jumpRunStartAnnotation)
                self.jumpRunStartAnnotation = nil
            }
            if let jumpRunEndAnnotation {
                map.removeAnnotation(jumpRunEndAnnotation)
                self.jumpRunEndAnnotation = nil
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

        private func upsertLandingPointAnnotation(on map: MKMapView, coordinate: CLLocationCoordinate2D) {
            if let annotation = landingPointAnnotation {
                annotation.coordinate = coordinate
                return
            }
            let annotation = LandingPointAnnotation(coordinate: coordinate)
            landingPointAnnotation = annotation
            map.addAnnotation(annotation)
        }

        private func upsertJumpRunHandleAnnotations(
            on map: MKMapView,
            start: CLLocationCoordinate2D,
            end: CLLocationCoordinate2D
        ) {
            if let annotation = jumpRunStartAnnotation {
                annotation.coordinate = start
            } else {
                let annotation = JumpRunHandleAnnotation(coordinate: start, role: .start)
                jumpRunStartAnnotation = annotation
                map.addAnnotation(annotation)
            }

            if let annotation = jumpRunEndAnnotation {
                annotation.coordinate = end
            } else {
                let annotation = JumpRunHandleAnnotation(coordinate: end, role: .end)
                jumpRunEndAnnotation = annotation
                map.addAnnotation(annotation)
            }
        }

        private func updateRoutePointAnnotations(on map: MKMapView, manualWaypoints: [PatternWaypoint]) {
            if !routePointAnnotations.isEmpty {
                map.removeAnnotations(routePointAnnotations)
                routePointAnnotations.removeAll()
            }

            let annotations = manualWaypoints.map { waypoint in
                LabeledPointAnnotation(
                    coordinate: CLLocationCoordinate2D(latitude: waypoint.lat, longitude: waypoint.lng),
                    label: manualWaypointLabel(for: waypoint),
                    badgeOffset: manualWaypointOffset(for: waypoint.name),
                    tintColor: UIColor.black.withAlphaComponent(0.7)
                )
            }
            routePointAnnotations = annotations
            map.addAnnotations(annotations)
        }

        private func updateRoutePointAnnotations(on map: MKMapView, autoWaypoints: [WingsuitAutoWaypoint]) {
            if !routePointAnnotations.isEmpty {
                map.removeAnnotations(routePointAnnotations)
                routePointAnnotations.removeAll()
            }

            let annotations = autoWaypoints.map { waypoint in
                LabeledPointAnnotation(
                    coordinate: CLLocationCoordinate2D(latitude: waypoint.lat, longitude: waypoint.lng),
                    label: autoWaypointLabel(for: waypoint.name),
                    badgeOffset: autoWaypointOffset(for: waypoint.name),
                    tintColor: autoWaypointColor(for: waypoint.name)
                )
            }
            routePointAnnotations = annotations
            map.addAnnotations(annotations)
        }

        private func updateArrowAnnotations(on map: MKMapView, coordinates: [CLLocationCoordinate2D]) {
            if !arrowAnnotations.isEmpty {
                map.removeAnnotations(arrowAnnotations)
                arrowAnnotations.removeAll()
            }

            guard coordinates.count >= 2 else { return }
            var annotations: [SegmentArrowAnnotation] = []
            for index in 0..<(coordinates.count - 1) {
                let start = coordinates[index]
                let end = coordinates[index + 1]
                guard isFiniteCoordinate(start), isFiniteCoordinate(end) else { continue }
                let midpoint = CLLocationCoordinate2D(
                    latitude: (start.latitude + end.latitude) / 2,
                    longitude: (start.longitude + end.longitude) / 2
                )
                guard isFiniteCoordinate(midpoint) else { continue }
                let heading = bearing(from: start, to: end)
                annotations.append(SegmentArrowAnnotation(coordinate: midpoint, headingDeg: heading))
            }

            arrowAnnotations = annotations
            map.addAnnotations(annotations)
        }

        private func updateOverlays(
            on map: MKMapView,
            routeCoordinates: [CLLocationCoordinate2D],
            headingGuide: (touchdown: CLLocationCoordinate2D, headingDeg: Double)?,
            jumpRun: (start: CLLocationCoordinate2D, end: CLLocationCoordinate2D)?,
            forbiddenPolygon: [CLLocationCoordinate2D],
            feasiblePolygon: [CLLocationCoordinate2D]
        ) {
            if !activeOverlays.isEmpty {
                map.removeOverlays(activeOverlays)
                activeOverlays.removeAll()
                overlayRoles.removeAll()
            }

            if feasiblePolygon.count >= 3 {
                var polygonCoordinates = feasiblePolygon
                let polygon = MKPolygon(coordinates: &polygonCoordinates, count: polygonCoordinates.count)
                activeOverlays.append(polygon)
                overlayRoles[ObjectIdentifier(polygon)] = .feasibleDeployRegion
            }

            if forbiddenPolygon.count >= 3 {
                var polygonCoordinates = forbiddenPolygon
                let polygon = MKPolygon(coordinates: &polygonCoordinates, count: polygonCoordinates.count)
                activeOverlays.append(polygon)
                overlayRoles[ObjectIdentifier(polygon)] = .forbiddenZone
            }

            if let jumpRun {
                var coordinates = [jumpRun.start, jumpRun.end]
                if coordinates.allSatisfy(isFiniteCoordinate) {
                    let polyline = MKPolyline(coordinates: &coordinates, count: coordinates.count)
                    activeOverlays.append(polyline)
                    overlayRoles[ObjectIdentifier(polyline)] = .jumpRun
                }
            }

            if routeCoordinates.count >= 2 {
                for index in 0..<(routeCoordinates.count - 1) {
                    var segmentCoordinates = [routeCoordinates[index], routeCoordinates[index + 1]]
                    guard segmentCoordinates.allSatisfy(isFiniteCoordinate) else { continue }
                    let outline = MKPolyline(coordinates: &segmentCoordinates, count: segmentCoordinates.count)
                    let segment = MKPolyline(coordinates: &segmentCoordinates, count: segmentCoordinates.count)
                    activeOverlays.append(outline)
                    activeOverlays.append(segment)
                    overlayRoles[ObjectIdentifier(outline)] = .segmentOutline
                    overlayRoles[ObjectIdentifier(segment)] = segmentRole(for: index)
                }
            }

            if let headingGuide {
                var headingCoordinates = [
                    headingGuide.touchdown,
                    headingHandleCoordinate(touchdown: headingGuide.touchdown, headingDeg: headingGuide.headingDeg),
                ]
                if headingCoordinates.allSatisfy(isFiniteCoordinate) {
                    let heading = MKPolyline(coordinates: &headingCoordinates, count: headingCoordinates.count)
                    activeOverlays.append(heading)
                    overlayRoles[ObjectIdentifier(heading)] = .headingGuide
                }
            }

            if !activeOverlays.isEmpty {
                map.addOverlays(activeOverlays, level: .aboveRoads)
            }
        }

        private func segmentRole(for index: Int) -> OverlayRole {
            switch index {
            case 0:
                return .downwind
            case 1:
                return .base
            default:
                return .final
            }
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

            if annotation is LandingPointAnnotation {
                let reuseId = "landing-point"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.canShowCallout = false
                view.isDraggable = true
                view.markerTintColor = .systemRed
                view.glyphImage = UIImage(systemName: "flag.fill")
                return view
            }

            if let annotation = annotation as? JumpRunHandleAnnotation {
                let reuseId = "jump-run-handle"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? MKMarkerAnnotationView)
                    ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.canShowCallout = false
                view.isDraggable = true
                view.markerTintColor = annotation.role == .start ? .systemPurple : .systemIndigo
                view.glyphText = annotation.role == .start ? "S" : "E"
                return view
            }

            if let annotation = annotation as? LabeledPointAnnotation {
                let reuseId = "route-point-badge"
                let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? LabeledPointBadgeView)
                    ?? LabeledPointBadgeView(annotation: annotation, reuseIdentifier: reuseId)
                view.annotation = annotation
                view.configure(text: annotation.label, tintColor: annotation.tintColor)
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

            if let polygon = overlay as? MKPolygon {
                let renderer = MKPolygonRenderer(polygon: polygon)
                let role = overlayRoles[ObjectIdentifier(polygon)] ?? .forbiddenZone
                switch role {
                case .forbiddenZone:
                    renderer.fillColor = UIColor.systemRed.withAlphaComponent(0.16)
                    renderer.strokeColor = UIColor.systemRed.withAlphaComponent(0.45)
                    renderer.lineWidth = 1.5
                case .feasibleDeployRegion:
                    renderer.fillColor = UIColor.systemGreen.withAlphaComponent(0.14)
                    renderer.strokeColor = UIColor.systemGreen.withAlphaComponent(0.5)
                    renderer.lineWidth = 1.5
                default:
                    renderer.fillColor = UIColor.clear
                    renderer.strokeColor = UIColor.clear
                }
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
            case .jumpRun:
                renderer.strokeColor = UIColor.systemIndigo.withAlphaComponent(0.9)
                renderer.lineWidth = 3
                renderer.lineDashPattern = [8, 5]
            case .forbiddenZone, .feasibleDeployRegion:
                renderer.strokeColor = UIColor.clear
                renderer.lineWidth = 0
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
                return
            }

            if annotation is LandingPointAnnotation {
                parent.onLandingPointChange(annotation.coordinate)
                return
            }

            if let jumpRunAnnotation = annotation as? JumpRunHandleAnnotation {
                switch jumpRunAnnotation.role {
                case .start:
                    parent.onJumpRunStartChange(annotation.coordinate)
                case .end:
                    parent.onJumpRunEndChange(annotation.coordinate)
                }
            }
        }

        private func manualWaypointLabel(for waypoint: PatternWaypoint) -> String {
            waypoint.name == .touchdown ? "TD" : "\(Int(round(waypoint.altFt)))ft"
        }

        private func manualWaypointOffset(for name: PatternWaypointName) -> CGPoint {
            switch name {
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

        private func autoWaypointLabel(for name: WingsuitAutoWaypointName) -> String {
            switch name {
            case .exit:
                return "EX"
            case .turn1:
                return "T1"
            case .turn2:
                return "T2"
            case .deploy:
                return "DEP"
            case .landing:
                return "LND"
            }
        }

        private func autoWaypointOffset(for name: WingsuitAutoWaypointName) -> CGPoint {
            switch name {
            case .exit:
                return CGPoint(x: 0, y: -24)
            case .turn1:
                return CGPoint(x: 22, y: -10)
            case .turn2:
                return CGPoint(x: 22, y: 16)
            case .deploy:
                return CGPoint(x: -8, y: 24)
            case .landing:
                return CGPoint(x: 0, y: 0)
            }
        }

        private func autoWaypointColor(for name: WingsuitAutoWaypointName) -> UIColor {
            switch name {
            case .exit:
                return UIColor.systemTeal
            case .turn1:
                return UIColor.systemBlue
            case .turn2:
                return UIColor.systemOrange
            case .deploy:
                return UIColor.systemRed
            case .landing:
                return UIColor.systemGreen
            }
        }

        private func headingHandleCoordinate(touchdown: CLLocationCoordinate2D, headingDeg: Double) -> CLLocationCoordinate2D {
            coordinate(atDistance: headingHandleRadiusMeters, from: touchdown, bearingDeg: headingDeg)
        }

        private func constrainedHeadingHandleCoordinate(candidate: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
            guard let touchdownAnnotation else { return candidate }
            let heading = bearing(from: touchdownAnnotation.coordinate, to: candidate)
            return coordinate(atDistance: headingHandleRadiusMeters, from: touchdownAnnotation.coordinate, bearingDeg: heading)
        }

        private func coordinate(
            atDistance distanceMeters: CLLocationDistance,
            from origin: CLLocationCoordinate2D,
            bearingDeg: Double
        ) -> CLLocationCoordinate2D {
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

        private func coordinates(from waypoints: [PatternWaypoint]) -> [CLLocationCoordinate2D] {
            waypoints.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
                .filter(isFiniteCoordinate)
        }

        private func coordinates(from waypoints: [WingsuitAutoWaypoint]) -> [CLLocationCoordinate2D] {
            waypoints.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
                .filter(isFiniteCoordinate)
        }

        private func polygonCoordinates(from points: [GeoPoint]) -> [CLLocationCoordinate2D] {
            points.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
                .filter(isFiniteCoordinate)
        }

        private func makeFittingRect(coordinates: [CLLocationCoordinate2D]) -> MKMapRect {
            let validCoordinates = coordinates.filter(isFiniteCoordinate)
            let fallbackCoordinate = validCoordinates.first ?? CLLocationCoordinate2D(latitude: 0, longitude: 0)
            let points = validCoordinates.map(MKMapPoint.init)
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

            return rect.insetBy(
                dx: -(rect.size.width * 0.22 + 140),
                dy: -(rect.size.height * 0.22 + 140)
            )
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

private final class LandingPointAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D

    init(coordinate: CLLocationCoordinate2D) {
        self.coordinate = coordinate
    }
}

private final class JumpRunHandleAnnotation: NSObject, MKAnnotation {
    enum Role {
        case start
        case end
    }

    dynamic var coordinate: CLLocationCoordinate2D
    let role: Role

    init(coordinate: CLLocationCoordinate2D, role: Role) {
        self.coordinate = coordinate
        self.role = role
    }
}

private final class LabeledPointAnnotation: NSObject, MKAnnotation {
    dynamic var coordinate: CLLocationCoordinate2D
    let label: String
    let badgeOffset: CGPoint
    let tintColor: UIColor

    init(coordinate: CLLocationCoordinate2D, label: String, badgeOffset: CGPoint, tintColor: UIColor) {
        self.coordinate = coordinate
        self.label = label
        self.badgeOffset = badgeOffset
        self.tintColor = tintColor
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

private final class LabeledPointBadgeView: MKAnnotationView {
    private let label = UILabel()

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        canShowCallout = false
        frame = CGRect(x: 0, y: 0, width: 50, height: 24)
        centerOffset = CGPoint(x: 0, y: -14)
        layer.cornerRadius = 12
        layer.masksToBounds = true
        layer.borderWidth = 1
        layer.borderColor = UIColor.white.withAlphaComponent(0.8).cgColor

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

    func configure(text: String, tintColor: UIColor) {
        label.text = text
        backgroundColor = tintColor.withAlphaComponent(0.88)
    }
}
