// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LonghandHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LonghandHelper", targets: ["LonghandHelper"]),
    ],
    targets: [
        // OS に依存しない純粋なロジック（キー名の表、ホットキー判定、トークン解析など）。XCTest でテストする。
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
