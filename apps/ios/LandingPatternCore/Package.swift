// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LandingPatternCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "LandingPatternCore",
            targets: ["LandingPatternCore"]
        )
    ],
    targets: [
        .target(
            name: "LandingPatternCore",
            path: "Sources/LandingPatternCore"
        ),
        .testTarget(
            name: "LandingPatternCoreTests",
            dependencies: ["LandingPatternCore"],
            path: "Tests/LandingPatternCoreTests",
            resources: [
                .copy("Fixtures")
            ]
        )
    ]
)
