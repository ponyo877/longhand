import XCTest
@testable import LonghandCore

final class MachTimeTests: XCTestCase {
    func testAppleSiliconの刻みは125分の3ナノ秒() {
        // 4 秒 = 4,000,000,000 ns = 96,000,000 刻み（125/3 ns ごと）
        XCTAssertEqual(MachTime.ticksToMs(96_000_000, numer: 125, denom: 3), 4000, accuracy: 0.001)
    }

    func testIntelでは刻みがそのままナノ秒() {
        XCTAssertEqual(MachTime.ticksToMs(4_000_000_000, numer: 1, denom: 1), 4000, accuracy: 0.001)
    }

    func test換算しないと長押しが短いタップに見える() {
        // 4 秒の長押しを、刻みのまま 100 万で割ると 96 ms になり、0.4 秒の窓より短く見えてしまう
        let down: UInt64 = 13_600_000_000
        let up = down + 96_000_000
        let wrong = Double(up - down) / 1_000_000
        let right = MachTime.ticksToMs(up, numer: 125, denom: 3) - MachTime.ticksToMs(down, numer: 125, denom: 3)
        XCTAssertLessThan(wrong, 400)
        XCTAssertEqual(right, 4000, accuracy: 0.01)
    }
}
