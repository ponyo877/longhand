// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LonghandHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LonghandHelper", targets: ["LonghandHelper"]),
    ],
    targets: [
        // Pure logic with no OS dependency (the key name table, hotkey matching, token parsing and so on). Tested with XCTest.
        .target(name: "LonghandCore"),
        .executableTarget(
            name: "LonghandHelper",
            dependencies: ["LonghandCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("Carbon"),
            ]
        ),
        .testTarget(name: "LonghandCoreTests", dependencies: ["LonghandCore"]),
    ]
)
