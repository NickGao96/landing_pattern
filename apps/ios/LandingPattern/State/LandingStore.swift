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

        if let coordinate = parseCoordinateQuery(query) {
            searchResults = []
            setTouchdown(coordinate)
            statusMessage = t.locationSet(String(format: "%.5f, %.5f", coordinate.latitude, coordinate.longitude))
            print("[LocationSearch] Parsed coordinate query '\(query)' -> \(coordinate.latitude), \(coordinate.longitude)")
            return
        }

        let candidates = searchCandidates(for: query)
        var failureReasons: [String] = []

        for candidate in candidates {
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = candidate
            request.resultTypes = [.address, .pointOfInterest]
            request.region = MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 20, longitude: 0),
                span: MKCoordinateSpan(latitudeDelta: 170, longitudeDelta: 350)
            )
            do {
                let response = try await MKLocalSearch(request: request).start()
                if let first = selectPreferredMapItem(from: response.mapItems, query: query) {
                    searchResults = response.mapItems
                    setTouchdown(first.placemark.coordinate)
                    let locationName = first.name ?? t.selectedResult
                    statusMessage = t.locationSet("\(locationName) (\(String(format: "%.5f, %.5f", first.placemark.coordinate.latitude, first.placemark.coordinate.longitude)))")
                    print("[LocationSearch] MKLocalSearch '\(candidate)' -> \(locationName) @ \(first.placemark.coordinate.latitude), \(first.placemark.coordinate.longitude)")
                    return
                }
            } catch {
                failureReasons.append("MK[\(candidate)]: \(error.localizedDescription)")
            }
        }

        for candidate in candidates {
            do {
                let placemarks = try await CLGeocoder().geocodeAddressString(candidate)
                if let coordinate = placemarks.first?.location?.coordinate {
                    searchResults = []
                    setTouchdown(coordinate)
                    let locationName = placemarks.first?.name ?? t.selectedResult
                    statusMessage = t.locationSet("\(locationName) (\(String(format: "%.5f, %.5f", coordinate.latitude, coordinate.longitude)))")
                    print("[LocationSearch] CLGeocoder '\(candidate)' -> \(locationName) @ \(coordinate.latitude), \(coordinate.longitude)")
                    return
                }
            } catch {
                failureReasons.append("CL[\(candidate)]: \(error.localizedDescription)")
            }
        }

        for candidate in candidates {
            do {
                if let fallback = try await fetchOpenMeteoLocation(query: candidate) {
                    searchResults = []
                    let coordinate = CLLocationCoordinate2D(latitude: fallback.latitude, longitude: fallback.longitude)
                    setTouchdown(coordinate)
                    let place = [fallback.name, fallback.admin1, fallback.country].compactMap { $0 }.joined(separator: ", ")
                    statusMessage = t.locationSet("\(place) (\(String(format: "%.5f, %.5f", coordinate.latitude, coordinate.longitude)))")
                    print("[LocationSearch] Open-Meteo fallback '\(candidate)' -> \(place) @ \(coordinate.latitude), \(coordinate.longitude)")
                    return
                }
            } catch {
                failureReasons.append("OM[\(candidate)]: \(error.localizedDescription)")
            }
        }

        searchResults = []
        if !failureReasons.isEmpty {
            let condensed = Array(failureReasons.prefix(3)).joined(separator: " | ")
            statusMessage = t.locationSearchFailed(condensed)
            print("[LocationSearch] Failed '\(query)'. Candidates: \(candidates). Reasons: \(failureReasons)")
        } else {
            statusMessage = t.noLocationResults
            print("[LocationSearch] No results for '\(query)'")
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

    private func parseCoordinateQuery(_ query: String) -> CLLocationCoordinate2D? {
        let normalized = query.replacingOccurrences(of: "，", with: ",")
        let parts = normalized
            .split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map(String.init)

        guard parts.count == 2 else { return nil }
        guard let lat = Double(parts[0]), let lng = Double(parts[1]) else { return nil }
        guard (-90 ... 90).contains(lat), (-180 ... 180).contains(lng) else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    private func selectPreferredMapItem(from mapItems: [MKMapItem], query: String) -> MKMapItem? {
        guard !mapItems.isEmpty else { return nil }
        let normalized = query.lowercased()
        if normalized.contains("thailand") {
            if let thailand = mapItems.first(where: {
                $0.placemark.isoCountryCode?.uppercased() == "TH" ||
                    ($0.placemark.country?.lowercased().contains("thailand") ?? false)
            }) {
                return thailand
            }
        }
        return mapItems.first
    }

    private func searchCandidates(for query: String) -> [String] {
        var candidates: [String] = []
        func appendUnique(_ value: String) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            if !candidates.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
                candidates.append(trimmed)
            }
        }

        appendUnique(query)
        let stripped = stripDropzoneTerms(from: query)
        appendUnique(stripped)
        if !stripped.isEmpty {
            appendUnique("\(stripped) skydiving")
        }

        return candidates
    }

    private func stripDropzoneTerms(from query: String) -> String {
        let regex = #"\b(drop\s*zone|dropzone|skydiving|dz)\b"#
        let stripped = query.replacingOccurrences(
            of: regex,
            with: " ",
            options: [.regularExpression, .caseInsensitive]
        )
        return stripped.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func fetchOpenMeteoLocation(query: String) async throws -> OpenMeteoGeocodingResult? {
        var components = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        components.queryItems = [
            URLQueryItem(name: "name", value: query),
            URLQueryItem(name: "count", value: "10"),
            URLQueryItem(name: "language", value: language == .zh ? "zh" : "en"),
            URLQueryItem(name: "format", value: "json"),
        ]
        guard let url = components.url else {
            return nil
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        let decoded = try JSONDecoder().decode(OpenMeteoGeocodingResponse.self, from: data)
        guard let results = decoded.results, !results.isEmpty else {
            return nil
        }
        let normalized = query.lowercased()
        if normalized.contains("thailand") {
            if let thailand = results.first(where: {
                ($0.country?.lowercased().contains("thailand") ?? false) ||
                    $0.countryCode?.uppercased() == "TH"
            }) {
                return thailand
            }
        }
        return results.first
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

private struct OpenMeteoGeocodingResponse: Decodable {
    let results: [OpenMeteoGeocodingResult]?
}

private struct OpenMeteoGeocodingResult: Decodable {
    let name: String
    let latitude: Double
    let longitude: Double
    let country: String?
    let countryCode: String?
    let admin1: String?

    enum CodingKeys: String, CodingKey {
        case name
        case latitude
        case longitude
        case country
        case countryCode = "country_code"
        case admin1
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
