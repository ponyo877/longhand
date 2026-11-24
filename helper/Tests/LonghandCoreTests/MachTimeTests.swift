import XCTest
@testable import LonghandCore

final class MachTimeTests: XCTestCase {
    func testAppleSiliconTickIs125Over3Nanoseconds() {
        // 4 s = 4,000,000,000 ns = 96,000,000 ticks (one every 125/3 ns)
        XCTAssertEqual(MachTime.ticksToMs(96_000_000, numer: 125, denom: 3), 4000, accuracy: 0.001)
    }

    func testIntelTicksAreNanoseconds() {
        XCTAssertEqual(MachTime.ticksToMs(4_000_000_000, numer: 1, denom: 1), 4000, accuracy: 0.001)
    }

    func testUnconvertedLongPressLooksLikeShortTap() {
        // Dividing the ticks of a 4 s long press by one million gives 96 ms, which looks shorter than the 0.4 s window
        let down: UInt64 = 13_600_000_000
        let up = down + 96_000_000
        let wrong = Double(up - down) / 1_000_000
        let right = MachTime.ticksToMs(up, numer: 125, denom: 3) - MachTime.ticksToMs(down, numer: 125, denom: 3)
        XCTAssertLessThan(wrong, 400)
        XCTAssertEqual(right, 4000, accuracy: 0.01)
    }
}
