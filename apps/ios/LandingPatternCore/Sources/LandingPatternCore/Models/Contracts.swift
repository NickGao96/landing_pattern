import Foundation

public enum PatternSide: String, Codable, CaseIterable {
    case left
    case right
}

public enum FlightMode: String, Codable, CaseIterable {
    case canopy
    case wingsuit
}

public enum WingsuitPresetId: String, Codable, CaseIterable {
    case swift
    case atc
    case freak
    case aura
    case custom
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

public struct WingsuitProfile: Codable, Equatable {
    public var presetId: WingsuitPresetId?
    public var name: String
    public var flightSpeedKt: Double
    public var fallRateFps: Double

    public init(presetId: WingsuitPresetId? = nil, name: String, flightSpeedKt: Double, fallRateFps: Double) {
        self.presetId = presetId
        self.name = name
        self.flightSpeedKt = flightSpeedKt
        self.fallRateFps = fallRateFps
    }
}

public struct PatternInput: Codable, Equatable {
    public var mode: FlightMode
    public var touchdownLat: Double
    public var touchdownLng: Double
    public var landingHeadingDeg: Double
    public var side: PatternSide
    public var baseLegDrift: Bool?
    public var gatesFt: [Double]
    public var winds: [WindLayer]
    public var canopy: CanopyProfile
    public var jumper: JumperInput
    public var wingsuit: WingsuitProfile

    public init(
        mode: FlightMode,
        touchdownLat: Double,
        touchdownLng: Double,
        landingHeadingDeg: Double,
        side: PatternSide,
        baseLegDrift: Bool? = nil,
        gatesFt: [Double],
        winds: [WindLayer],
        canopy: CanopyProfile,
        jumper: JumperInput,
        wingsuit: WingsuitProfile
    ) {
        self.mode = mode
        self.touchdownLat = touchdownLat
        self.touchdownLng = touchdownLng
        self.landingHeadingDeg = landingHeadingDeg
        self.side = side
        self.baseLegDrift = baseLegDrift
        self.gatesFt = gatesFt
        self.winds = winds
        self.canopy = canopy
        self.jumper = jumper
        self.wingsuit = wingsuit
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
    public var wingLoading: Double?
    public var estAirspeedKt: Double
    public var estSinkFps: Double

    public init(wingLoading: Double?, estAirspeedKt: Double, estSinkFps: Double) {
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

public struct GeoPoint: Codable, Equatable {
    public var lat: Double
    public var lng: Double

    public init(lat: Double, lng: Double) {
        self.lat = lat
        self.lng = lng
    }
}

public struct JumpRunLine: Codable, Equatable {
    public var start: GeoPoint
    public var end: GeoPoint

    public init(start: GeoPoint, end: GeoPoint) {
        self.start = start
        self.end = end
    }
}

public struct WingsuitAutoTurnRatios: Codable, Equatable {
    public var turn1: Double
    public var turn2: Double

    public init(turn1: Double, turn2: Double) {
        self.turn1 = turn1
        self.turn2 = turn2
    }
}

public enum WingsuitAutoJumpRunDirectionMode: String, Codable {
    case auto
    case manual
}

public enum WingsuitAutoJumpRunConstraintMode: String, Codable {
    case none
    case reciprocal
}

public enum WingsuitAutoJumpRunHeadingSource: String, Codable {
    case autoHeadwind = "auto-headwind"
    case manual
}

public enum WingsuitAutoJumpRunPlacementMode: String, Codable {
    case normal
    case distance
}

public struct WingsuitAutoJumpRunAssumptions: Codable, Equatable {
    public var planeAirspeedKt: Double?
    public var groupCount: Int?
    public var groupSeparationFt: Double?
    public var slickDeployHeightFt: Double?
    public var slickFallRateFps: Double?
    public var slickReturnRadiusFt: Double?

    public init(
        planeAirspeedKt: Double? = nil,
        groupCount: Int? = nil,
        groupSeparationFt: Double? = nil,
        slickDeployHeightFt: Double? = nil,
        slickFallRateFps: Double? = nil,
        slickReturnRadiusFt: Double? = nil
    ) {
        self.planeAirspeedKt = planeAirspeedKt
        self.groupCount = groupCount
        self.groupSeparationFt = groupSeparationFt
        self.slickDeployHeightFt = slickDeployHeightFt
        self.slickFallRateFps = slickFallRateFps
        self.slickReturnRadiusFt = slickReturnRadiusFt
    }
}

public struct WingsuitAutoJumpRunConfig: Codable, Equatable {
    public var placementMode: WingsuitAutoJumpRunPlacementMode?
    public var directionMode: WingsuitAutoJumpRunDirectionMode?
    public var manualHeadingDeg: Double?
    public var constraintMode: WingsuitAutoJumpRunConstraintMode?
    public var constraintHeadingDeg: Double?
    public var distanceOffsetFt: Double?
    public var distancePostTurnFt: Double?
    public var assumptions: WingsuitAutoJumpRunAssumptions?

    public init(
        placementMode: WingsuitAutoJumpRunPlacementMode? = nil,
        directionMode: WingsuitAutoJumpRunDirectionMode? = nil,
        manualHeadingDeg: Double? = nil,
        constraintMode: WingsuitAutoJumpRunConstraintMode? = nil,
        constraintHeadingDeg: Double? = nil,
        distanceOffsetFt: Double? = nil,
        distancePostTurnFt: Double? = nil,
        assumptions: WingsuitAutoJumpRunAssumptions? = nil
    ) {
        self.placementMode = placementMode
        self.directionMode = directionMode
        self.manualHeadingDeg = manualHeadingDeg
        self.constraintMode = constraintMode
        self.constraintHeadingDeg = constraintHeadingDeg
        self.distanceOffsetFt = distanceOffsetFt
        self.distancePostTurnFt = distancePostTurnFt
        self.assumptions = assumptions
    }
}

public struct ResolvedJumpRunSlot: Codable, Equatable {
    public var lat: Double
    public var lng: Double
    public var label: String
    public var index: Int
    public var kind: String
    public var altFt: Double

    public init(lat: Double, lng: Double, label: String, index: Int, kind: String, altFt: Double) {
        self.lat = lat
        self.lng = lng
        self.label = label
        self.index = index
        self.kind = kind
        self.altFt = altFt
    }
}

public struct ResolvedJumpRun: Codable, Equatable {
    public var line: JumpRunLine
    public var headingDeg: Double
    public var lengthFt: Double
    public var crosswindOffsetFt: Double
    public var planeGroundSpeedKt: Double
    public var groupSpacingFt: Double
    public var groupSpacingSec: Double
    public var slots: [ResolvedJumpRunSlot]

    public init(
        line: JumpRunLine,
        headingDeg: Double,
        lengthFt: Double,
        crosswindOffsetFt: Double,
        planeGroundSpeedKt: Double,
        groupSpacingFt: Double,
        groupSpacingSec: Double,
        slots: [ResolvedJumpRunSlot]
    ) {
        self.line = line
        self.headingDeg = headingDeg
        self.lengthFt = lengthFt
        self.crosswindOffsetFt = crosswindOffsetFt
        self.planeGroundSpeedKt = planeGroundSpeedKt
        self.groupSpacingFt = groupSpacingFt
        self.groupSpacingSec = groupSpacingSec
        self.slots = slots
    }
}

public struct WingsuitAutoTuning: Codable, Equatable {
    public var corridorHalfWidthFt: Double?
    public var deployBearingStepDeg: Double?
    public var deployRadiusStepFt: Double?
    public var deployBearingWindowHalfDeg: Double?
    public var maxDeployRadiusFt: Double?
    public var maxFirstLegTrackDeltaDeg: Double?
    public var minDeployRadiusFt: Double?
    public var refinementIterations: Double?
    public var exitOnJumpRunToleranceFt: Double?

    public init(
        corridorHalfWidthFt: Double? = nil,
        deployBearingStepDeg: Double? = nil,
        deployRadiusStepFt: Double? = nil,
        deployBearingWindowHalfDeg: Double? = nil,
        maxDeployRadiusFt: Double? = nil,
        maxFirstLegTrackDeltaDeg: Double? = nil,
        minDeployRadiusFt: Double? = nil,
        refinementIterations: Double? = nil,
        exitOnJumpRunToleranceFt: Double? = nil
    ) {
        self.corridorHalfWidthFt = corridorHalfWidthFt
        self.deployBearingStepDeg = deployBearingStepDeg
        self.deployRadiusStepFt = deployRadiusStepFt
        self.deployBearingWindowHalfDeg = deployBearingWindowHalfDeg
        self.maxDeployRadiusFt = maxDeployRadiusFt
        self.maxFirstLegTrackDeltaDeg = maxFirstLegTrackDeltaDeg
        self.minDeployRadiusFt = minDeployRadiusFt
        self.refinementIterations = refinementIterations
        self.exitOnJumpRunToleranceFt = exitOnJumpRunToleranceFt
    }
}

public struct WingsuitAutoInput: Codable, Equatable {
    public var landingPoint: GeoPoint
    public var jumpRun: WingsuitAutoJumpRunConfig
    public var side: PatternSide
    public var exitHeightFt: Double
    public var deployHeightFt: Double
    public var winds: [WindLayer]
    public var wingsuit: WingsuitProfile
    public var turnRatios: WingsuitAutoTurnRatios?
    public var tuning: WingsuitAutoTuning?

    public init(
        landingPoint: GeoPoint,
        jumpRun: WingsuitAutoJumpRunConfig,
        side: PatternSide,
        exitHeightFt: Double,
        deployHeightFt: Double,
        winds: [WindLayer],
        wingsuit: WingsuitProfile,
        turnRatios: WingsuitAutoTurnRatios? = nil,
        tuning: WingsuitAutoTuning? = nil
    ) {
        self.landingPoint = landingPoint
        self.jumpRun = jumpRun
        self.side = side
        self.exitHeightFt = exitHeightFt
        self.deployHeightFt = deployHeightFt
        self.winds = winds
        self.wingsuit = wingsuit
        self.turnRatios = turnRatios
        self.tuning = tuning
    }
}

public enum WingsuitAutoWaypointName: String, Codable, CaseIterable {
    case landing
    case deploy
    case turn2
    case turn1
    case exit
}

public struct WingsuitAutoWaypoint: Codable, Equatable {
    public var name: WingsuitAutoWaypointName
    public var lat: Double
    public var lng: Double
    public var altFt: Double

    public init(name: WingsuitAutoWaypointName, lat: Double, lng: Double, altFt: Double) {
        self.name = name
        self.lat = lat
        self.lng = lng
        self.altFt = altFt
    }
}

public struct RadiusBand: Codable, Equatable {
    public var bearingDeg: Double
    public var minRadiusFt: Double
    public var maxRadiusFt: Double

    public init(bearingDeg: Double, minRadiusFt: Double, maxRadiusFt: Double) {
        self.bearingDeg = bearingDeg
        self.minRadiusFt = minRadiusFt
        self.maxRadiusFt = maxRadiusFt
    }
}

public struct WingsuitAutoDiagnostics: Codable, Equatable {
    public var headingSource: WingsuitAutoJumpRunHeadingSource?
    public var placementMode: WingsuitAutoJumpRunPlacementMode?
    public var constrainedHeadingApplied: Bool?
    public var resolvedHeadingDeg: Double?
    public var normalJumpRunHeadingDeg: Double?
    public var distanceOffsiteFt: Double?
    public var headwindComponentKt: Double?
    public var crosswindComponentKt: Double?
    public var crosswindOffsetFt: Double?
    public var firstSlickReturnMarginFt: Double?
    public var lastSlickReturnMarginFt: Double?
    public var preferredDeployBearingDeg: Double?
    public var selectedDeployBearingDeg: Double?
    public var selectedDeployRadiusFt: Double?
    public var exitToJumpRunErrorFt: Double?
    public var deployRadiusMarginFt: Double?
    public var firstLegTrackDeltaDeg: Double?
    public var corridorMarginFt: Double?
    public var turnHeightsFt: [Double]?
    public var failureReason: String?

    public init(
        headingSource: WingsuitAutoJumpRunHeadingSource? = nil,
        placementMode: WingsuitAutoJumpRunPlacementMode? = nil,
        constrainedHeadingApplied: Bool? = nil,
        resolvedHeadingDeg: Double? = nil,
        normalJumpRunHeadingDeg: Double? = nil,
        distanceOffsiteFt: Double? = nil,
        headwindComponentKt: Double? = nil,
        crosswindComponentKt: Double? = nil,
        crosswindOffsetFt: Double? = nil,
        firstSlickReturnMarginFt: Double? = nil,
        lastSlickReturnMarginFt: Double? = nil,
        preferredDeployBearingDeg: Double? = nil,
        selectedDeployBearingDeg: Double? = nil,
        selectedDeployRadiusFt: Double? = nil,
        exitToJumpRunErrorFt: Double? = nil,
        deployRadiusMarginFt: Double? = nil,
        firstLegTrackDeltaDeg: Double? = nil,
        corridorMarginFt: Double? = nil,
        turnHeightsFt: [Double]? = nil,
        failureReason: String? = nil
    ) {
        self.headingSource = headingSource
        self.placementMode = placementMode
        self.constrainedHeadingApplied = constrainedHeadingApplied
        self.resolvedHeadingDeg = resolvedHeadingDeg
        self.normalJumpRunHeadingDeg = normalJumpRunHeadingDeg
        self.distanceOffsiteFt = distanceOffsiteFt
        self.headwindComponentKt = headwindComponentKt
        self.crosswindComponentKt = crosswindComponentKt
        self.crosswindOffsetFt = crosswindOffsetFt
        self.firstSlickReturnMarginFt = firstSlickReturnMarginFt
        self.lastSlickReturnMarginFt = lastSlickReturnMarginFt
        self.preferredDeployBearingDeg = preferredDeployBearingDeg
        self.selectedDeployBearingDeg = selectedDeployBearingDeg
        self.selectedDeployRadiusFt = selectedDeployRadiusFt
        self.exitToJumpRunErrorFt = exitToJumpRunErrorFt
        self.deployRadiusMarginFt = deployRadiusMarginFt
        self.firstLegTrackDeltaDeg = firstLegTrackDeltaDeg
        self.corridorMarginFt = corridorMarginFt
        self.turnHeightsFt = turnHeightsFt
        self.failureReason = failureReason
    }
}

public struct WingsuitAutoOutput: Codable, Equatable {
    public var blocked: Bool
    public var warnings: [String]
    public var landingPoint: WingsuitAutoWaypoint
    public var resolvedJumpRun: ResolvedJumpRun?
    public var deployPoint: WingsuitAutoWaypoint?
    public var exitPoint: WingsuitAutoWaypoint?
    public var turnPoints: [WingsuitAutoWaypoint]
    public var routeWaypoints: [WingsuitAutoWaypoint]
    public var routeSegments: [SegmentOutput]
    public var landingNoDeployZonePolygon: [GeoPoint]
    public var downwindDeployForbiddenZonePolygon: [GeoPoint]
    public var forbiddenZonePolygon: [GeoPoint]
    public var feasibleDeployRegionPolygon: [GeoPoint]
    public var deployBandsByBearing: [RadiusBand]
    public var diagnostics: WingsuitAutoDiagnostics

    public init(
        blocked: Bool,
        warnings: [String],
        landingPoint: WingsuitAutoWaypoint,
        resolvedJumpRun: ResolvedJumpRun?,
        deployPoint: WingsuitAutoWaypoint?,
        exitPoint: WingsuitAutoWaypoint?,
        turnPoints: [WingsuitAutoWaypoint],
        routeWaypoints: [WingsuitAutoWaypoint],
        routeSegments: [SegmentOutput],
        landingNoDeployZonePolygon: [GeoPoint],
        downwindDeployForbiddenZonePolygon: [GeoPoint],
        forbiddenZonePolygon: [GeoPoint],
        feasibleDeployRegionPolygon: [GeoPoint],
        deployBandsByBearing: [RadiusBand],
        diagnostics: WingsuitAutoDiagnostics
    ) {
        self.blocked = blocked
        self.warnings = warnings
        self.landingPoint = landingPoint
        self.resolvedJumpRun = resolvedJumpRun
        self.deployPoint = deployPoint
        self.exitPoint = exitPoint
        self.turnPoints = turnPoints
        self.routeWaypoints = routeWaypoints
        self.routeSegments = routeSegments
        self.landingNoDeployZonePolygon = landingNoDeployZonePolygon
        self.downwindDeployForbiddenZonePolygon = downwindDeployForbiddenZonePolygon
        self.forbiddenZonePolygon = forbiddenZonePolygon
        self.feasibleDeployRegionPolygon = feasibleDeployRegionPolygon
        self.deployBandsByBearing = deployBandsByBearing
        self.diagnostics = diagnostics
    }
}
