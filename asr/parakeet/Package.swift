// swift-tools-version: 6.2
// longhand-asr-parakeet: FluidAudio（Core ML）で Parakeet-TDT 日本語版を動かす ASR ワーカー。
// プロトコルは src/shared/asr-protocol.ts を参照。
import PackageDescription

let package = Package(
    name: "longhand-asr-parakeet",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "longhand-asr-parakeet", targets: ["longhand-asr-parakeet"])
    ],
    dependencies: [
        // traits を空にして、TTS、話者分離、NeMo のテキスト正規化（Rust の静的ライブラリ）を外す。
        // ASR だけなら不要で、リソースバンドルも要らなくなる。
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
