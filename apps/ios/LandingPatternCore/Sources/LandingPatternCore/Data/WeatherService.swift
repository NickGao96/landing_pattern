import Foundation

public enum WeatherError: Error, LocalizedError {
    case invalidResponse(String)
    case requestFailed(String)
    case missingData(String)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse(let message): return message
        case .requestFailed(let message): return message
        case .missingData(let message): return message
        }
    }
}

public protocol HTTPClient {
    func get(url: URL, headers: [String: String]) async throws -> Data
}

public struct URLSessionHTTPClient: HTTPClient {
    public init() {}

    public func get(url: URL, headers: [String: String]) async throws -> Data {
        var request = URLRequest(url: url)
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw WeatherError.invalidResponse("Invalid HTTP response for \(url.absoluteString)")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw WeatherError.requestFailed("Request failed for \(url.absoluteString): \(http.statusCode)")
        }
        return data
    }
}

private struct PressureLevelDescriptor {
    let level: String

    var speedKey: String { "wind_speed_\(level)" }
    var directionKey: String { "wind_direction_\(level)" }
    var heightKey: String { "geopotential_height_\(level)" }
}

private let pressureLevels: [PressureLevelDescriptor] = [
    "1000hPa",
    "975hPa",
    "950hPa",
    "925hPa",
    "900hPa",
    "850hPa",
    "800hPa",
    "700hPa",
    "600hPa",
].map { PressureLevelDescriptor(level: $0) }

public struct WeatherService {
    private let httpClient: HTTPClient

    public init(httpClient: HTTPClient = URLSessionHTTPClient()) {
        self.httpClient = httpClient
    }

    public func denseAltitudeProfile(
        minAltitudeFt: Double = 0,
        maxAltitudeFt: Double,
        stepFt: Double = 250
    ) -> [Double] {
        guard maxAltitudeFt.isFinite, stepFt.isFinite, maxAltitudeFt >= minAltitudeFt, stepFt > 0 else {
            return []
        }

        var altitudes: [Double] = []
        var current = minAltitudeFt
        while current <= maxAltitudeFt {
            altitudes.append(current)
            current += stepFt
        }
        if altitudes.last.map({ abs($0 - maxAltitudeFt) > 1e-6 }) ?? true {
            altitudes.append(maxAltitudeFt)
        }
        return altitudes
    }

    public func fetchSurfaceWind(lat: Double, lng: Double) async throws -> SurfaceWind {
        try await fetchNoaaSurfaceWind(lat: lat, lng: lng)
    }

    public func fetchNoaaSurfaceWind(lat: Double, lng: Double) async throws -> SurfaceWind {
        let pointsURL = URL(string: "https://api.weather.gov/points/\(String(format: "%.4f", lat)),\(String(format: "%.4f", lng))")!
        var errors: [String] = []
        var pointsPayload: [String: Any]?

        do {
            let pointsData = try await fetchJSON(url: pointsURL)
            pointsPayload = pointsData
        } catch {
            errors.append("NOAA points failed: \(error.localizedDescription)")
        }

        if let pointsPayload {
            do {
                if
                    let props = pointsPayload["properties"] as? [String: Any],
                    let stationsURLString = props["observationStations"] as? String,
                    let stationsURL = URL(string: stationsURLString)
                {
                    let stationsPayload = try await fetchJSON(url: stationsURL)
                    let stationID = extractStationId(from: stationsPayload)
                    guard let stationID else {
                        throw WeatherError.missingData("No observation station ID found.")
                    }

                    let obsURL = URL(string: "https://api.weather.gov/stations/\(stationID)/observations/latest")!
                    let obsPayload = try await fetchJSON(url: obsURL)
                    if let wind = parseObservationWind(obsPayload) {
                        return wind
                    }
                    throw WeatherError.missingData("Observation missing numeric wind speed and direction.")
                }
                throw WeatherError.missingData("Points payload missing observationStations URL.")
            } catch {
                errors.append("NOAA observation failed: \(error.localizedDescription)")
            }

            do {
                if
                    let props = pointsPayload["properties"] as? [String: Any],
                    let forecastURLString = props["forecastHourly"] as? String,
                    let forecastURL = URL(string: forecastURLString)
                {
                    let forecastPayload = try await fetchJSON(url: forecastURL)
                    if let wind = parseForecastWind(forecastPayload) {
                        return wind
                    }
                    throw WeatherError.missingData("Forecast period missing parseable wind data.")
                }
                throw WeatherError.missingData("Points payload missing forecastHourly URL.")
            } catch {
                errors.append("NOAA forecast failed: \(error.localizedDescription)")
            }
        }

        do {
            return try await fetchOpenMeteoSurfaceWind(lat: lat, lng: lng)
        } catch {
            errors.append("Open-Meteo failed: \(error.localizedDescription)")
        }

        throw WeatherError.requestFailed("Unable to determine surface wind from NOAA/NWS or Open-Meteo. \(errors.joined(separator: " | "))")
    }

    public func fetchWingsuitWindProfile(lat: Double, lng: Double, altitudesFt: [Double]) async throws -> [WindLayer] {
        guard !altitudesFt.isEmpty else {
            return []
        }

        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")
        let hourlyFields = pressureLevels.flatMap { [$0.speedKey, $0.directionKey, $0.heightKey] }.joined(separator: ",")
        components?.queryItems = [
            URLQueryItem(name: "latitude", value: String(format: "%.4f", lat)),
            URLQueryItem(name: "longitude", value: String(format: "%.4f", lng)),
            URLQueryItem(name: "current", value: "wind_speed_10m,wind_direction_10m"),
            URLQueryItem(name: "hourly", value: hourlyFields),
            URLQueryItem(name: "forecast_hours", value: "1"),
            URLQueryItem(name: "wind_speed_unit", value: "kn"),
            URLQueryItem(name: "timezone", value: "UTC"),
        ]

        guard let url = components?.url else {
            throw WeatherError.invalidResponse("Unable to build Open-Meteo upper-air URL")
        }

        let payload = try await fetchJSON(url: url)
        let elevationFt = feetFromMeters((payload["elevation"] as? Double) ?? 0)

        var candidates: [(altitudeMslFt: Double, speedKt: Double, dirFromDeg: Double)] = []

        if
            let current = payload["current"] as? [String: Any],
            let speed = current["wind_speed_10m"] as? Double,
            let direction = current["wind_direction_10m"] as? Double
        {
            candidates.append((altitudeMslFt: elevationFt + feetFromMeters(10), speedKt: speed, dirFromDeg: direction))
        }

        let hourly = payload["hourly"] as? [String: Any]
        for descriptor in pressureLevels {
            guard
                let speed = firstNumber(in: hourly?[descriptor.speedKey]),
                let direction = firstNumber(in: hourly?[descriptor.directionKey]),
                let heightMeters = firstNumber(in: hourly?[descriptor.heightKey])
            else {
                continue
            }

            candidates.append((altitudeMslFt: feetFromMeters(heightMeters), speedKt: speed, dirFromDeg: direction))
        }

        guard !candidates.isEmpty else {
            throw WeatherError.missingData("Open-Meteo upper-air response missing parseable winds.")
        }

        return altitudesFt.map { altitudeFt in
            let requestedMslFt = altitudeFt + elevationFt
            let nearest = candidates.min { lhs, rhs in
                abs(lhs.altitudeMslFt - requestedMslFt) < abs(rhs.altitudeMslFt - requestedMslFt)
            }!
            return WindLayer(altitudeFt: altitudeFt, speedKt: nearest.speedKt, dirFromDeg: nearest.dirFromDeg, source: .auto)
        }
    }

    public func fetchDenseWingsuitWindProfile(
        lat: Double,
        lng: Double,
        minAltitudeFt: Double = 0,
        maxAltitudeFt: Double,
        stepFt: Double = 250
    ) async throws -> [WindLayer] {
        let altitudes = denseAltitudeProfile(
            minAltitudeFt: minAltitudeFt,
            maxAltitudeFt: maxAltitudeFt,
            stepFt: stepFt
        )
        return try await fetchWingsuitWindProfile(lat: lat, lng: lng, altitudesFt: altitudes)
    }

    public func extrapolateWindProfile(surface: SurfaceWind, altitudesFt: [Double], alpha: Double = 0.14) -> [WindLayer] {
        altitudesFt.map { altitudeFt in
            let altitudeM = max(altitudeFt * 0.3048, 1)
            let speedKt = surface.speedKt * pow(altitudeM / 10, alpha)
            return WindLayer(altitudeFt: altitudeFt, speedKt: speedKt, dirFromDeg: surface.dirFromDeg, source: .auto)
        }
    }

    private func fetchJSON(url: URL) async throws -> [String: Any] {
        let data = try await httpClient.get(url: url, headers: ["Accept": "application/geo+json, application/json"])
        let json = try JSONSerialization.jsonObject(with: data)
        guard let payload = json as? [String: Any] else {
            throw WeatherError.invalidResponse("Expected JSON object for \(url.absoluteString)")
        }
        return payload
    }

    private func extractStationId(from payload: [String: Any]) -> String? {
        guard let features = payload["features"] as? [[String: Any]], let first = features.first else {
            return nil
        }
        if let properties = first["properties"] as? [String: Any], let stationID = properties["stationIdentifier"] as? String {
            return stationID
        }
        if let id = first["id"] as? String {
            return id.split(separator: "/").last.map(String.init)
        }
        return nil
    }

    private func parseObservationWind(_ payload: [String: Any]) -> SurfaceWind? {
        guard let properties = payload["properties"] as? [String: Any] else {
            return nil
        }

        let windSpeed = (properties["windSpeed"] as? [String: Any])
        let rawSpeed = windSpeed?["value"] as? Double
        let unitCode = windSpeed?["unitCode"] as? String
        let direction = ((properties["windDirection"] as? [String: Any])?["value"]) as? Double

        guard let rawSpeed, let direction else {
            return nil
        }

        let speedKt = observationSpeedToKnots(value: rawSpeed, unitCode: unitCode)
        return SurfaceWind(
            speedKt: speedKt,
            dirFromDeg: direction,
            source: .observation,
            observationTime: properties["timestamp"] as? String
        )
    }

    private func parseForecastWind(_ payload: [String: Any]) -> SurfaceWind? {
        guard
            let properties = payload["properties"] as? [String: Any],
            let periods = properties["periods"] as? [[String: Any]],
            let period = periods.first,
            let speedText = period["windSpeed"] as? String,
            let directionText = period["windDirection"] as? String,
            let speedKt = parseSpeedStringToKnots(speedText),
            let direction = parseCardinalDirection(directionText)
        else {
            return nil
        }

        return SurfaceWind(speedKt: speedKt, dirFromDeg: direction, source: .forecast)
    }

    private func fetchOpenMeteoSurfaceWind(lat: Double, lng: Double) async throws -> SurfaceWind {
        let urlString =
            "https://api.open-meteo.com/v1/forecast?latitude=\(String(format: "%.4f", lat))" +
            "&longitude=\(String(format: "%.4f", lng))" +
            "&current=wind_speed_10m,wind_direction_10m" +
            "&wind_speed_unit=kn" +
            "&timezone=UTC"
        guard let url = URL(string: urlString) else {
            throw WeatherError.invalidResponse("Unable to build Open-Meteo URL")
        }

        let payload = try await fetchJSON(url: url)

        if
            let current = payload["current"] as? [String: Any],
            let speed = current["wind_speed_10m"] as? Double,
            let dir = current["wind_direction_10m"] as? Double
        {
            return SurfaceWind(speedKt: speed, dirFromDeg: dir, source: .openMeteo, observationTime: current["time"] as? String)
        }

        if
            let currentWeather = payload["current_weather"] as? [String: Any],
            let speed = currentWeather["windspeed"] as? Double,
            let dir = currentWeather["winddirection"] as? Double
        {
            return SurfaceWind(speedKt: speed, dirFromDeg: dir, source: .openMeteo, observationTime: currentWeather["time"] as? String)
        }

        throw WeatherError.missingData("Open-Meteo response missing wind speed/direction.")
    }

    private func firstNumber(in value: Any?) -> Double? {
        guard let array = value as? [Any], let first = array.first else { return nil }
        return first as? Double
    }

    private func feetFromMeters(_ meters: Double) -> Double { meters * 3.280839895 }
    private func knotsFromMetersPerSecond(_ mps: Double) -> Double { mps * 1.94384449 }
    private func knotsFromMilesPerHour(_ mph: Double) -> Double { mph * 0.868976 }
    private func knotsFromKilometersPerHour(_ kmh: Double) -> Double { kmh * 0.539957 }

    private func observationSpeedToKnots(value: Double, unitCode: String?) -> Double {
        let normalized = (unitCode ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.contains("m_s-1") { return knotsFromMetersPerSecond(value) }
        if normalized.contains("km_h-1") || normalized.contains("km/h") { return knotsFromKilometersPerHour(value) }
        if normalized.contains("mi_h-1") || normalized.contains("mph") { return knotsFromMilesPerHour(value) }
        if normalized.contains(":kt") || normalized.contains(":kn") || normalized.contains("kn") { return value }
        return knotsFromMetersPerSecond(value)
    }

    private func parseCardinalDirection(_ direction: String) -> Double? {
        let map: [String: Double] = [
            "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5,
            "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
            "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5,
            "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5,
        ]
        return map[direction.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()]
    }

    private func parseSpeedStringToKnots(_ speedText: String) -> Double? {
        let normalized = speedText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let regex = try? NSRegularExpression(pattern: #"\d+(?:\.\d+)?"#)
        let range = NSRange(normalized.startIndex..<normalized.endIndex, in: normalized)
        let matches = regex?.matches(in: normalized, range: range) ?? []
        let values: [Double] = matches.compactMap {
            guard let strRange = Range($0.range, in: normalized) else { return nil }
            return Double(normalized[strRange])
        }
        guard !values.isEmpty else { return nil }
        let mean = values.reduce(0, +) / Double(values.count)

        if normalized.contains("mph") { return mean * 0.868976 }
        if normalized.contains("km") || normalized.contains("kph") { return mean * 0.539957 }
        return mean
    }
}
