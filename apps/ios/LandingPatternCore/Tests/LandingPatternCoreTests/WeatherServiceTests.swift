import Foundation
import XCTest
@testable import LandingPatternCore

private final class MockHTTPClient: HTTPClient {
    typealias Handler = (URL) throws -> Data
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func get(url: URL, headers: [String : String]) async throws -> Data {
        try handler(url)
    }
}

final class WeatherServiceTests: XCTestCase {
    func testUsesObservationWhenAvailable() async throws {
        var call = 0
        let client = MockHTTPClient { url in
            call += 1
            let urlString = url.absoluteString
            if urlString.contains("/points/") {
                return Data(#"{"properties":{"forecastHourly":"https://example.org/hourly","observationStations":"https://example.org/stations"}}"#.utf8)
            }
            if urlString == "https://example.org/stations" {
                return Data(#"{"features":[{"properties":{"stationIdentifier":"KPAO"}}]}"#.utf8)
            }
            if urlString.contains("observations/latest") {
                return Data(#"{"properties":{"timestamp":"2026-02-13T00:00:00Z","windSpeed":{"value":5},"windDirection":{"value":210}}}"#.utf8)
            }
            throw WeatherError.requestFailed("Unexpected URL \(urlString)")
        }

        let service = WeatherService(httpClient: client)
        let wind = try await service.fetchNoaaSurfaceWind(lat: 37, lng: -122)
        XCTAssertEqual(wind.source, .observation)
        XCTAssertEqual(wind.speedKt, 9.71922245, accuracy: 0.01)
        XCTAssertEqual(wind.dirFromDeg, 210, accuracy: 1e-6)
        XCTAssertGreaterThanOrEqual(call, 3)
    }

    func testFallsBackToOpenMeteoWhenNoaaUnavailable() async throws {
        let client = MockHTTPClient { url in
            let urlString = url.absoluteString
            if urlString.contains("api.weather.gov/points") {
                throw WeatherError.requestFailed("404")
            }
            if urlString.contains("api.open-meteo.com") {
                return Data(#"{"current":{"time":"2026-02-14T00:00","wind_speed_10m":14.2,"wind_direction_10m":305}}"#.utf8)
            }
            throw WeatherError.requestFailed("Unexpected URL \(urlString)")
        }

        let service = WeatherService(httpClient: client)
        let wind = try await service.fetchNoaaSurfaceWind(lat: 19.6542, lng: 109.1796)
        XCTAssertEqual(wind.source, .openMeteo)
        XCTAssertEqual(wind.speedKt, 14.2, accuracy: 1e-6)
        XCTAssertEqual(wind.dirFromDeg, 305, accuracy: 1e-6)
    }

    func testExtrapolateWindProfile() {
        let service = WeatherService(httpClient: MockHTTPClient(handler: { _ in Data() }))
        let profile = service.extrapolateWindProfile(
            surface: SurfaceWind(speedKt: 10, dirFromDeg: 270, source: .manual),
            altitudesFt: [900, 600, 300],
            alpha: 0.14
        )

        XCTAssertEqual(profile.count, 3)
        XCTAssertEqual(profile[0].altitudeFt, 900, accuracy: 1e-6)
        XCTAssertGreaterThan(profile[0].speedKt, profile[2].speedKt)
        XCTAssertEqual(profile[0].dirFromDeg, 270, accuracy: 1e-6)
    }

    func testFetchWingsuitWindProfileMapsNearestLevels() async throws {
        let client = MockHTTPClient { url in
            XCTAssertTrue(url.absoluteString.contains("api.open-meteo.com"))
            return Data(
                #"{"elevation":100,"current":{"wind_speed_10m":12,"wind_direction_10m":200},"hourly":{"wind_speed_1000hPa":[20],"wind_direction_1000hPa":[220],"geopotential_height_1000hPa":[250],"wind_speed_925hPa":[35],"wind_direction_925hPa":[260],"geopotential_height_925hPa":[1100]}}"#.utf8
            )
        }

        let service = WeatherService(httpClient: client)
        let profile = try await service.fetchWingsuitWindProfile(lat: 37, lng: -122, altitudesFt: [200, 3200])

        XCTAssertEqual(profile.count, 2)
        XCTAssertEqual(profile[0].altitudeFt, 200, accuracy: 1e-6)
        XCTAssertEqual(profile[0].speedKt, 12, accuracy: 1e-6)
        XCTAssertEqual(profile[0].dirFromDeg, 200, accuracy: 1e-6)
        XCTAssertEqual(profile[1].altitudeFt, 3200, accuracy: 1e-6)
        XCTAssertEqual(profile[1].speedKt, 35, accuracy: 1e-6)
        XCTAssertEqual(profile[1].dirFromDeg, 260, accuracy: 1e-6)
    }
}
