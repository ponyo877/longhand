// 貼り付けの着地の判定（PST-3、PST-4）。OS から切り離した純粋なロジックで、XCTest で検証する。
//
// 手がかりは 2 つある。
// - 貼り付け先がクリップボードを読んだか（遅延提供のデータ要求で分かる）
// - AX で読んだ入力欄が貼り付け前から変わったか
// Electron などでは AX の値の更新が遅れ、貼れていても欄の変化が見えないことがある。
// そこで「読まれたが変化が見えない」は失敗扱いにせず read とし、unconfirmed は
// 「読まれず、⌘V を送り直しても変化がない」ときだけにする。

public enum PasteLanding: String, Sendable {
    /// AX で欄の変化を確かめた
    case confirmed
    /// 欄の変化は見えないが、クリップボードは読まれた（貼れている見込みが高い）
    case read
    /// 読まれず、送り直しても欄が変わらなかった
    case unconfirmed
    /// AX で読めない欄、または確認しなかった
    case unknown

    /// 確認した貼り付けの結果を決める
    /// - changed: 欄の変化を確かめたか（送り直した後の確認も含む）
    /// - read: 送り直しの前後を通して、クリップボードが読まれたか
    public static func classify(changed: Bool, read: Bool) -> PasteLanding {
        if changed { return .confirmed }
        return read ? .read : .unconfirmed
    }

    /// ⌘V を送り直すべきか。読まれず、欄も変わらないときだけ（読まれていれば二重に貼る恐れがある）
    public static func shouldResend(changed: Bool, read: Bool) -> Bool {
        !changed && !read
    }
}
