// swift-tools-version: 6.0
import PackageDescription

// longhand-asr-apple: a worker that wraps Apple's on-device speech recognition (SpeechAnalyzer / SpeechTranscriber, macOS 26 and later)
// in the stdio JSON Lines protocol of src/shared/asr-protocol.ts.
let package = Package(
    name: "longhand-asr-apple",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "longhand-asr-apple", targets: ["LonghandAsrApple"]),
    ],
    targets: [
        .executableTarget(
            name: "LonghandAsrApple",
            path: "Sources/LonghandAsrApple",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                // Embed Info.plist in the binary so that even a command-line tool carries its usage descriptions
                .unsafeFlags([
                    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist", "-Xlinker", "Resources/Info.plist",
                ]),
            ]
        ),
    ]
)
