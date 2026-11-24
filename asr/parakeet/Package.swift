// swift-tools-version: 6.2
// longhand-asr-parakeet: ASR worker that runs Parakeet-TDT Japanese with FluidAudio (Core ML).
// See src/shared/asr-protocol.ts for the protocol.
import PackageDescription

let package = Package(
    name: "longhand-asr-parakeet",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "longhand-asr-parakeet", targets: ["longhand-asr-parakeet"])
    ],
    dependencies: [
        // Empty traits leave out TTS, speaker diarization and NeMo text normalization (a Rust static library).
        // ASR alone does not need them, and no resource bundle is needed either.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.4", traits: [])
    ],
    targets: [
        .executableTarget(
            name: "longhand-asr-parakeet",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/longhand-asr-parakeet",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
