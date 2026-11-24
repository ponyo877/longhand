// swift-tools-version: 6.0
import PackageDescription

// longhand-asr-apple: Apple のオンデバイス音声認識（SpeechAnalyzer / SpeechTranscriber、macOS 26 以降）を
// src/shared/asr-protocol.ts の stdio JSON Lines プロトコルで包むワーカー。
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
                // CLI でも用途の説明を持たせるため、Info.plist をバイナリに埋め込む
                .unsafeFlags([
                    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist", "-Xlinker", "Resources/Info.plist",
                ]),
            ]
        ),
    ]
)
