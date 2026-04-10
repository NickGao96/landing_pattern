import Foundation

let feetPerNauticalMile: Double = 6076.12
let feetPerDegLat: Double = 364000

struct Vec2: Equatable {
    var east: Double
    var north: Double
}

public func normalizeHeading(_ deg: Double) -> Double {
    var value = deg.truncatingRemainder(dividingBy: 360)
    if value < 0 { value += 360 }
    return value
}

func headingToUnitVector(_ headingDeg: Double) -> Vec2 {
    let rad = normalizeHeading(headingDeg) * .pi / 180
    return Vec2(east: sin(rad), north: cos(rad))
}

public func windFromToGroundVector(speedKt: Double, dirFromDeg: Double) -> (east: Double, north: Double) {
    let toDeg = normalizeHeading(dirFromDeg + 180)
    let unit = headingToUnitVector(toDeg)
    return (east: unit.east * speedKt, north: unit.north * speedKt)
}

func magnitude(_ vec: Vec2) -> Double {
    hypot(vec.east, vec.north)
}

func addVec(_ a: Vec2, _ b: Vec2) -> Vec2 {
    Vec2(east: a.east + b.east, north: a.north + b.north)
}

func scaleVec(_ vec: Vec2, _ scalar: Double) -> Vec2 {
    Vec2(east: vec.east * scalar, north: vec.north * scalar)
}

func unitOrZero(_ vec: Vec2) -> Vec2 {
    let mag = magnitude(vec)
    if mag <= 1e-9 {
        return Vec2(east: 0, north: 0)
    }
    return scaleVec(vec, 1 / mag)
}

func knotsToFeetPerSecond(_ knots: Double) -> Double {
    (knots * feetPerNauticalMile) / 3600
}

func feetPerSecondToKnots(_ fps: Double) -> Double {
    (fps * 3600) / feetPerNauticalMile
}

func dot(_ a: Vec2, _ b: Vec2) -> Double {
    a.east * b.east + a.north * b.north
}

func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
    a + (b - a) * t
}

func lerpAngleDeg(_ a: Double, _ b: Double, _ t: Double) -> Double {
    let start = normalizeHeading(a)
    let end = normalizeHeading(b)
    let delta = ((end - start + 540).truncatingRemainder(dividingBy: 360)) - 180
    return normalizeHeading(start + delta * t)
}

public func getWindForAltitude(_ altitudeFt: Double, winds: [WindLayer]) -> WindLayer? {
    guard !winds.isEmpty else { return nil }

    let sorted = winds.sorted { $0.altitudeFt > $1.altitudeFt }
    guard let highest = sorted.first, let lowest = sorted.last else { return nil }

    for layer in sorted where abs(layer.altitudeFt - altitudeFt) < 1e-3 {
        return layer
    }

    if sorted.count > 1 {
        for index in 0..<(sorted.count - 1) {
            let high = sorted[index]
            let low = sorted[index + 1]
            if altitudeFt <= high.altitudeFt && altitudeFt >= low.altitudeFt {
                let span = high.altitudeFt - low.altitudeFt
                if span <= 0 {
                    return high
                }
                let t = (high.altitudeFt - altitudeFt) / span
                return WindLayer(
                    altitudeFt: altitudeFt,
                    speedKt: lerp(high.speedKt, low.speedKt, t),
                    dirFromDeg: lerpAngleDeg(high.dirFromDeg, low.dirFromDeg, t),
                    source: .auto
                )
            }
        }
    }

    return altitudeFt > highest.altitudeFt ? highest : lowest
}

func localFeetToLatLng(refLat: Double, refLng: Double, eastFt: Double, northFt: Double) -> (lat: Double, lng: Double) {
    let lat = refLat + northFt / feetPerDegLat
    let cosLat = cos(refLat * .pi / 180)
    let feetPerDegLng = feetPerDegLat * max(cosLat, 1e-5)
    let lng = refLng + eastFt / feetPerDegLng
    return (lat: lat, lng: lng)
}

func latLngToLocalFeet(refLat: Double, refLng: Double, lat: Double, lng: Double) -> (eastFt: Double, northFt: Double) {
    let northFt = (lat - refLat) * feetPerDegLat
    let cosLat = cos(refLat * .pi / 180)
    let feetPerDegLng = feetPerDegLat * max(cosLat, 1e-5)
    let eastFt = (lng - refLng) * feetPerDegLng
    return (eastFt: eastFt, northFt: northFt)
}
