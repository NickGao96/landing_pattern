import Foundation
import CoreLocation
import MapKit
import SwiftUI
import LandingPatternCore

@MainActor
final class LandingStore: ObservableObject {
    @Published var touchdown = CLLocationCoordinate2D(latitude: 37.4419, longitude: -122.143) {
        didSet { persistSettings() }
    }
    @Published var location = CLLocationCoordinate2D(latitude: 37.4419, longitude: -122.143) {
        didSet { persistSettings() }
    }
    @Published var landingHeadingDeg: Double = 180 {
        didSet { persistSettings() }
    }
    @Published var side: PatternSide = .left {
        didSet { persistSettings() }
    }
    @Published var baseLegDrift: Bool = true {
        didSet { persistSettings() }
    }
    @Published var gatesFt: [Double] = [900, 600, 300, 0] {
        didSet { persistSettings() }
    }
    @Published var shearAlpha: Double = 0.14 {
        didSet { persistSettings() }
    }
    @Published var canopy: CanopyProfile = canopyPresets.first ?? CanopyProfile(
        manufacturer: "Performance Designs",
        model: "Fallback 170",
        sizeSqft: 170,
        wlRef: 1,
        airspeedRefKt: 20,
        airspeedWlExponent: 0.5,
        airspeedMinKt: 12,
        airspeedMaxKt: 34,
        glideRatio: 2.7
    ) {
        didSet { persistSettings() }
    }
    @Published var exitWeightLb: Double = 170 {
        didSet { persistSettings() }
    }
    @Published var windLayers: [WindLayer] = [
        WindLayer(altitudeFt: 900, speedKt: 10, dirFromDeg: 180, source: .manual),
        WindLayer(altitudeFt: 600, speedKt: 9, dirFromDeg: 180, source: .manual),
        WindLayer(altitudeFt: 300, speedKt: 8, dirFromDeg: 180, source: .manual),
    ] {
        didSet { persistSettings() }
    }
    @Published var language: AppLanguage = .en {
        didSet {
            if statusMessage == oldValue.strings.ready {
                statusMessage = language.strings.ready
            }
            persistSettings()
        }
    }
    @Published var statusMessage = AppLanguage.en.strings.ready
    @Published var locationQuery = ""
    @Published var searchResults: [MKMapItem] = []
    @Published var mapStackChoice: MapStackChoice = .mapKit {
        didSet {
            if mapStackChoice != .mapKit {
                mapStackChoice = .mapKit
                return
            }
            persistSettings()
        }
    }

    @AppStorage("landing-pattern-settings") private var settingsData: Data = Data()
    private var isRestoringSettings = false

    private let weatherService: WeatherService
    private var t: AppStrings { language.strings }

    init(weatherService: WeatherService = WeatherService()) {
        self.weatherService = weatherService
        restoreSettings()
    }

    var patternInput: PatternInput {
        PatternInput(
            touchdownLat: touchdown.latitude,
            touchdownLng: touchdown.longitude,
            landingHeadingDeg: landingHeadingDeg,
            side: side,
            baseLegDrift: baseLegDrift,
            gatesFt: gatesFt,
            winds: windLayers,
            canopy: canopy,
            jumper: JumperInput(exitWeightLb: exitWeightLb, canopyAreaSqft: canopy.sizeSqft)
        )
    }

    var patternOutput: PatternOutput {
        computePattern(patternInput)
    }

    func setTouchdown(_ coordinate: CLLocationCoordinate2D) {
        touchdown = coordinate
        location = coordinate
    }

    func setHeadingFromHandle(_ coordinate: CLLocationCoordinate2D) {
        let heading = bearing(from: touchdown, to: coordinate)
        landingHeadingDeg = heading
    }

    func updateWindLayer(index: Int, patch: (inout WindLayer) -> Void) {
        guard windLayers.indices.contains(index) else { return }
        patch(&windLayers[index])
    }

    func applyPreset(model: String) {
        guard let preset = findPreset(byModel: model) else { return }
        canopy = preset
    }

    func fetchAutoWind() async {
        do {
            let surface = try await weatherService.fetchSurfaceWind(lat: touchdown.latitude, lng: touchdown.longitude)
            windLayers = weatherService.extrapolateWindProfile(
                surface: surface,
                altitudesFt: Array(gatesFt.prefix(3)),
                alpha: shearAlpha
            )
            statusMessage = t.loadedWind(surface.source.rawValue, surface.speedKt, Int(round(surface.dirFromDeg)))
        } catch {
            statusMessage = t.autoWindFailed(error.localizedDescription)
        }
    }

    func searchLocation() async {
        let query = locationQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            statusMessage = t.enterLocationQuery
            return
        }

        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.resultTypes = [.address, .pointOfInterest]

        do {
            let response = try await MKLocalSearch(request: request).start()
            searchResults = response.mapItems
            if let first = response.mapItems.first {
                setTouchdown(first.placemark.coordinate)
                statusMessage = t.locationSet(first.name ?? t.selectedResult)
            } else {
                statusMessage = t.noLocationResults
            }
        } catch {
            statusMessage = t.locationSearchFailed(error.localizedDescription)
        }
    }

    func applySearchResult(_ item: MKMapItem) {
        setTouchdown(item.placemark.coordinate)
        statusMessage = t.locationSet(item.name ?? t.selectedResult)
    }

    func suggestHeadwindFinal() {
        guard let lowLayer = windLayers.sorted(by: { $0.altitudeFt < $1.altitudeFt }).first else {
            statusMessage = t.noWindLayerForSuggestion
            return
        }
        landingHeadingDeg = lowLayer.dirFromDeg
        statusMessage = t.headingSuggested
    }

    func exportSnapshot() throws -> Data {
        let snapshot = Snapshot(
            locationLat: location.latitude,
            locationLng: location.longitude,
            touchdownLat: touchdown.latitude,
            touchdownLng: touchdown.longitude,
            landingHeadingDeg: landingHeadingDeg,
            side: side,
            baseLegDrift: baseLegDrift,
            gatesFt: gatesFt,
            shearAlpha: shearAlpha,
            canopy: canopy,
            exitWeightLb: exitWeightLb,
            windLayers: windLayers,
            mapStackChoice: mapStackChoice,
            language: language
        )
        return try JSONEncoder().encode(snapshot)
    }

    func importSnapshot(from data: Data) throws {
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
        location = CLLocationCoordinate2D(latitude: snapshot.locationLat, longitude: snapshot.locationLng)
        touchdown = CLLocationCoordinate2D(latitude: snapshot.touchdownLat, longitude: snapshot.touchdownLng)
        landingHeadingDeg = snapshot.landingHeadingDeg
        side = snapshot.side
        baseLegDrift = snapshot.baseLegDrift
        gatesFt = snapshot.gatesFt
        shearAlpha = snapshot.shearAlpha
        canopy = snapshot.canopy
        exitWeightLb = snapshot.exitWeightLb
        windLayers = snapshot.windLayers
        mapStackChoice = snapshot.mapStackChoice ?? .mapKit
        language = snapshot.language ?? .en
        statusMessage = t.snapshotImported
    }

    private func persistSettings() {
        guard !isRestoringSettings else { return }
        let snapshot = Snapshot(
            locationLat: location.latitude,
            locationLng: location.longitude,
            touchdownLat: touchdown.latitude,
            touchdownLng: touchdown.longitude,
            landingHeadingDeg: landingHeadingDeg,
            side: side,
            baseLegDrift: baseLegDrift,
            gatesFt: gatesFt,
            shearAlpha: shearAlpha,
            canopy: canopy,
            exitWeightLb: exitWeightLb,
            windLayers: windLayers,
            mapStackChoice: mapStackChoice,
            language: language
        )
        settingsData = (try? JSONEncoder().encode(snapshot)) ?? Data()
    }

    private func restoreSettings() {
        guard !settingsData.isEmpty else { return }
        guard let snapshot = try? JSONDecoder().decode(Snapshot.self, from: settingsData) else { return }
        isRestoringSettings = true

        location = CLLocationCoordinate2D(latitude: snapshot.locationLat, longitude: snapshot.locationLng)
        touchdown = CLLocationCoordinate2D(latitude: snapshot.touchdownLat, longitude: snapshot.touchdownLng)
        landingHeadingDeg = snapshot.landingHeadingDeg
        side = snapshot.side
        baseLegDrift = snapshot.baseLegDrift
        gatesFt = snapshot.gatesFt
        shearAlpha = snapshot.shearAlpha
        canopy = snapshot.canopy
        exitWeightLb = snapshot.exitWeightLb
        windLayers = snapshot.windLayers
        mapStackChoice = snapshot.mapStackChoice ?? .mapKit
        language = snapshot.language ?? .en
        isRestoringSettings = false
    }

    private func bearing(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) -> Double {
        let lat1 = from.latitude * .pi / 180
        let lat2 = to.latitude * .pi / 180
        let deltaLon = (to.longitude - from.longitude) * .pi / 180

        let y = sin(deltaLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(deltaLon)
        let heading = atan2(y, x) * 180 / .pi
        let normalized = heading.truncatingRemainder(dividingBy: 360)
        return normalized >= 0 ? normalized : normalized + 360
    }
}

private struct Snapshot: Codable {
    var locationLat: Double
    var locationLng: Double
    var touchdownLat: Double
    var touchdownLng: Double
    var landingHeadingDeg: Double
    var side: PatternSide
    var baseLegDrift: Bool
    var gatesFt: [Double]
    var shearAlpha: Double
    var canopy: CanopyProfile
    var exitWeightLb: Double
    var windLayers: [WindLayer]
    var mapStackChoice: MapStackChoice?
    var language: AppLanguage?
}
