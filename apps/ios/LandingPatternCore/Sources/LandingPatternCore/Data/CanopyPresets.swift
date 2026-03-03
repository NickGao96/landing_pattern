import Foundation

public let canopyPresets: [CanopyProfile] = [
    CanopyProfile(
        manufacturer: "Performance Designs",
        model: "Sabre3 170",
        sizeSqft: 170,
        wlRef: 1,
        airspeedRefKt: 20,
        airspeedWlExponent: 0.5,
        airspeedMinKt: 12,
        airspeedMaxKt: 34,
        glideRatio: 2.7,
        sourceUrl: "https://www.performancedesigns.com/",
        confidence: .medium
    ),
    CanopyProfile(
        manufacturer: "Performance Designs",
        model: "Sabre3 150",
        sizeSqft: 150,
        wlRef: 1,
        airspeedRefKt: 21,
        airspeedWlExponent: 0.5,
        airspeedMinKt: 13,
        airspeedMaxKt: 35,
        glideRatio: 2.6,
        sourceUrl: "https://www.performancedesigns.com/",
        confidence: .medium
    ),
    CanopyProfile(
        manufacturer: "Performance Designs",
        model: "Storm 150",
        sizeSqft: 150,
        wlRef: 1,
        airspeedRefKt: 20,
        airspeedWlExponent: 0.5,
        airspeedMinKt: 12,
        airspeedMaxKt: 34,
        glideRatio: 2.4,
        sourceUrl: "https://www.performancedesigns.com/",
        confidence: .low
    ),
    CanopyProfile(
        manufacturer: "Performance Designs",
        model: "Pulse 170",
        sizeSqft: 170,
        wlRef: 1,
        airspeedRefKt: 19,
        airspeedWlExponent: 0.5,
        airspeedMinKt: 11,
        airspeedMaxKt: 33,
        glideRatio: 2.8,
        sourceUrl: "https://www.performancedesigns.com/",
        confidence: .low
    )
]

public func findPreset(byModel model: String) -> CanopyProfile? {
    canopyPresets.first { $0.model == model }
}
