import XCTest
@testable import Core

final class GhostUtilsTests: XCTestCase {
    func testCalcGhostPercentRaw_normalCase() {
        let result = GhostUtils.calcGhostPercentRaw(totalEffortHours: 30, actualWorkDays: 10)
        XCTAssertEqual(result!, 100.0, accuracy: 0.01)
    }

    func testCalcGhostPercentRaw_zeroDays() {
        XCTAssertNil(GhostUtils.calcGhostPercentRaw(totalEffortHours: 10, actualWorkDays: 0))
    }

    func testCalcGhostPercent_withShare() {
        let result = GhostUtils.calcGhostPercent(totalEffortHours: 15, actualWorkDays: 10, share: 0.5)
        XCTAssertEqual(result!, 100.0, accuracy: 0.01)
    }

    func testCalcGhostPercent_zeroShare() {
        XCTAssertNil(GhostUtils.calcGhostPercent(totalEffortHours: 15, actualWorkDays: 10, share: 0))
    }

    func testGhostColor() {
        XCTAssertEqual(GhostUtils.ghostColor(percent: 130), .green)
        XCTAssertEqual(GhostUtils.ghostColor(percent: 105), .green)
        XCTAssertEqual(GhostUtils.ghostColor(percent: 85), .yellow)
        XCTAssertEqual(GhostUtils.ghostColor(percent: 60), .red)
        XCTAssertEqual(GhostUtils.ghostColor(percent: nil), .gray)
    }

    func testFormatGhostPercent() {
        XCTAssertEqual(GhostUtils.formatGhostPercent(123.456), "123%")
        XCTAssertEqual(GhostUtils.formatGhostPercent(nil), "N/A")
    }
}
