import Foundation

public enum PatternSide: String, Codable, CaseIterable {
    case left
    case right
}

public enum SegmentName: String, Codable, CaseIterable {
    case downwind
    case base
    case final
}

public enum WindSource: String, Codable {
    case auto
    case manual
}

public struct WindLayer: Codable, Equatable {
    public var altitudeFt: Double
    public var speedKt: Double
    public var dirFromDeg: Double
    public var source: WindSource

    public init(altitudeFt: Double, speedKt: Double, dirFromDeg: Double, source: WindSource) {
        self.altitudeFt = altitudeFt
        self.speedKt = speedKt
        self.dirFromDeg = dirFromDeg
        self.source = source
    }
}

public enum CanopyConfidence: String, Codable {
    case low
    case medium
    case high
}

public struct CanopyProfile: Codable, Equatable {
    public var manufacturer: String
    public var model: String
    public var sizeSqft: Double
    public var wlRef: Double
    public var airspeedRefKt: Double
    public var airspeedWlExponent: Double?
    public var airspeedMinKt: Double?
    public var airspeedMaxKt: Double?
    public var glideRatio: Double
    public var sourceUrl: String?
    public var confidence: CanopyConfidence?

    public init(
        manufacturer: String,
        model: String,
        sizeSqft: Double,
        wlRef: Double,
        airspeedRefKt: Double,
        airspeedWlExponent: Double? = nil,
        airspeedMinKt: Double? = nil,
        airspeedMaxKt: Double? = nil,
        glideRatio: Double,
        sourceUrl: String? = nil,
        confidence: CanopyConfidence? = nil
    ) {
        self.manufacturer = manufacturer
        self.model = model
        self.sizeSqft = sizeSqft
        self.wlRef = wlRef
        self.airspeedRefKt = airspeedRefKt
        self.airspeedWlExponent = airspeedWlExponent
        self.airspeedMinKt = airspeedMinKt
        self.airspeedMaxKt = airspeedMaxKt
        self.glideRatio = glideRatio
        self.sourceUrl = sourceUrl
        self.confidence = confidence
    }
}

public struct JumperInput: Codable, Equatable {
    public var exitWeightLb: Double
    public var canopyAreaSqft: Double

    public init(exitWeightLb: Double, canopyAreaSqft: Double) {
        self.exitWeightLb = exitWeightLb
        self.canopyAreaSqft = canopyAreaSqft
    }
}

public struct PatternInput: Codable, Equatable {
    public var touchdownLat: Double
    public var touchdownLng: Double
    public var landingHeadingDeg: Double
    public var side: PatternSide
    public var baseLegDrift: Bool?
    public var gatesFt: [Double]
    public var winds: [WindLayer]
    public var canopy: CanopyProfile
    public var jumper: JumperInput

    public init(
        touchdownLat: Double,
        touchdownLng: Double,
        landingHeadingDeg: Double,
        side: PatternSide,
        baseLegDrift: Bool? = nil,
        gatesFt: [Double],
        winds: [WindLayer],
        canopy: CanopyProfile,
        jumper: JumperInput
    ) {
        self.touchdownLat = touchdownLat
        self.touchdownLng = touchdownLng
        self.landingHeadingDeg = landingHeadingDeg
        self.side = side
        self.baseLegDrift = baseLegDrift
        self.gatesFt = gatesFt
        self.winds = winds
        self.canopy = canopy
        self.jumper = jumper
    }
}

public enum PatternWaypointName: String, Codable {
    case downwindStart = "downwind_start"
    case baseStart = "base_start"
    case finalStart = "final_start"
    case touchdown
}

public struct PatternWaypoint: Codable, Equatable {
    public var name: PatternWaypointName
    public var lat: Double
    public var lng: Double
    public var altFt: Double

    public init(name: PatternWaypointName, lat: Double, lng: Double, altFt: Double) {
        self.name = name
        self.lat = lat
        self.lng = lng
        self.altFt = altFt
    }
}

public struct SegmentOutput: Codable, Equatable {
    public var name: SegmentName
    public var headingDeg: Double
    public var trackHeadingDeg: Double
    public var alongLegSpeedKt: Double
    public var groundSpeedKt: Double
    public var timeSec: Double
    public var distanceFt: Double

    public init(
        name: SegmentName,
        headingDeg: Double,
        trackHeadingDeg: Double,
        alongLegSpeedKt: Double,
        groundSpeedKt: Double,
        timeSec: Double,
        distanceFt: Double
    ) {
        self.name = name
        self.headingDeg = headingDeg
        self.trackHeadingDeg = trackHeadingDeg
        self.alongLegSpeedKt = alongLegSpeedKt
        self.groundSpeedKt = groundSpeedKt
        self.timeSec = timeSec
        self.distanceFt = distanceFt
    }
}

public struct PatternMetrics: Codable, Equatable {
    public var wingLoading: Double
    public var estAirspeedKt: Double
    public var estSinkFps: Double

    public init(wingLoading: Double, estAirspeedKt: Double, estSinkFps: Double) {
        self.wingLoading = wingLoading
        self.estAirspeedKt = estAirspeedKt
        self.estSinkFps = estSinkFps
    }
}

public struct PatternOutput: Codable, Equatable {
    public var waypoints: [PatternWaypoint]
    public var segments: [SegmentOutput]
    public var metrics: PatternMetrics
    public var warnings: [String]
    public var blocked: Bool

    public init(waypoints: [PatternWaypoint], segments: [SegmentOutput], metrics: PatternMetrics, warnings: [String], blocked: Bool) {
        self.waypoints = waypoints
        self.segments = segments
        self.metrics = metrics
        self.warnings = warnings
        self.blocked = blocked
    }
}

public struct ValidationResult: Codable, Equatable {
    public var valid: Bool
    public var errors: [String]
    public var warnings: [String]

    public init(valid: Bool, errors: [String], warnings: [String]) {
        self.valid = valid
        self.errors = errors
        self.warnings = warnings
    }
}

public enum SurfaceWindSource: String, Codable {
    case observation
    case forecast
    case manual
    case openMeteo = "open-meteo"
}

public struct SurfaceWind: Codable, Equatable {
    public var speedKt: Double
    public var dirFromDeg: Double
    public var source: SurfaceWindSource
    public var observationTime: String?

    public init(speedKt: Double, dirFromDeg: Double, source: SurfaceWindSource, observationTime: String? = nil) {
        self.speedKt = speedKt
        self.dirFromDeg = dirFromDeg
        self.source = source
        self.observationTime = observationTime
    }
}
