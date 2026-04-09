import Foundation
import LandingPatternCore

let defaultWingsuitGatesFt: [Double] = [12000, 10000, 6500, 4000]

let defaultWingsuitWindLayers: [WindLayer] = [
    WindLayer(altitudeFt: 12000, speedKt: 28, dirFromDeg: 240, source: .manual),
    WindLayer(altitudeFt: 10000, speedKt: 24, dirFromDeg: 230, source: .manual),
    WindLayer(altitudeFt: 6500, speedKt: 18, dirFromDeg: 220, source: .manual),
]

func wingsuitProfile(for presetId: WingsuitPresetId) -> WingsuitProfile {
    switch presetId {
    case .swift:
        return WingsuitProfile(presetId: .swift, name: "Squirrel SWIFT", flightSpeedKt: 60, fallRateFps: 84)
    case .atc:
        return WingsuitProfile(presetId: .atc, name: "Squirrel ATC", flightSpeedKt: 68, fallRateFps: 72)
    case .freak:
        return WingsuitProfile(presetId: .freak, name: "Squirrel FREAK", flightSpeedKt: 84, fallRateFps: 68)
    case .aura:
        return WingsuitProfile(presetId: .aura, name: "Squirrel AURA", flightSpeedKt: 80, fallRateFps: 60)
    case .custom:
        return WingsuitProfile(presetId: .custom, name: "Custom Wingsuit", flightSpeedKt: 84, fallRateFps: 68)
    }
}

func normalizedWingsuitProfile(_ profile: WingsuitProfile) -> WingsuitProfile {
    let presetId = inferWingsuitPresetId(from: profile)
    switch presetId {
    case .swift, .atc, .freak, .aura:
        let preset = wingsuitProfile(for: presetId)
        return WingsuitProfile(
            presetId: presetId,
            name: profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? preset.name : profile.name,
            flightSpeedKt: profile.flightSpeedKt,
            fallRateFps: profile.fallRateFps
        )
    case .custom:
        return WingsuitProfile(
            presetId: .custom,
            name: profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Custom Wingsuit" : profile.name,
            flightSpeedKt: profile.flightSpeedKt,
            fallRateFps: profile.fallRateFps
        )
    }
}

func inferWingsuitPresetId(from profile: WingsuitProfile) -> WingsuitPresetId {
    if let presetId = profile.presetId {
        return presetId
    }

    let normalizedName = profile.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalizedName.contains("swift") {
        return .swift
    }
    if normalizedName.contains("atc") {
        return .atc
    }
    if normalizedName.contains("freak") {
        return .freak
    }
    if normalizedName.contains("aura") {
        return .aura
    }

    if abs(profile.flightSpeedKt - 60) <= 0.5 && abs(profile.fallRateFps - 84) <= 1 {
        return .swift
    }
    if abs(profile.flightSpeedKt - 68) <= 0.5 && abs(profile.fallRateFps - 72) <= 1 {
        return .atc
    }
    if abs(profile.flightSpeedKt - 84) <= 0.5 && abs(profile.fallRateFps - 68) <= 1 {
        return .freak
    }
    if abs(profile.flightSpeedKt - 80) <= 0.5 && abs(profile.fallRateFps - 60) <= 1 {
        return .aura
    }
    return .custom
}

func approximateWingsuitGlideRatio(_ profile: WingsuitProfile) -> Double {
    let horizontalSpeedFps = profile.flightSpeedKt * 1.6878098571
    return horizontalSpeedFps / max(profile.fallRateFps, 0.1)
}
