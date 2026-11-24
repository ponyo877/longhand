/**
 * フローティングバーのウィンドウが、マウスの操作を受け取るか、下のアプリに通すかを決める。
 *
 * ウィンドウは画面の下部に、通知を積むための透明な領域（400×260）を持つ。
 * ふだんは操作を下のアプリに通し、ポインタがバーや通知の上にあるときだけ受け取る。
 *
 * 以前は、要素ごとの mouseenter と mouseleave で切り替えていた。
 * この方法では、ポインタが乗ったまま要素が消えたとき（通知を閉じた、バーが切り替わった）に mouseleave が来ず、
 * 受け取る状態のまま戻らなくなる。そうなると、画面の下部でクリックもスクロールもできなくなる。
 *
 * ここでは、要素の出入りを数えずに、ポインタの位置に操作できる要素があるかを毎回調べて決める。
 * - ポインタが動いたとき
 * - 画面の中身が変わったとき（recheck）
 * - 一定の間隔（ポインタが止まったまま要素が消えても、戻るように）
 * 受け取る状態のあいだは、同じ値を送り続ける。main は、この知らせが途切れたら通す状態に戻す（保険）。
 */

export interface MouseRouterDeps {
  /** その位置に、操作できる要素（バーや通知）があるか */
  isInteractiveAt: (x: number, y: number) => boolean;
  /** main に知らせる。true なら受け取る、false なら下のアプリに通す */
  send: (interactive: boolean) => void;
  now?: () => number;
  /** 受け取る状態を送り直す間隔 */
  resendMs?: number;
}

export interface MouseRouter {
  /** ポインタがウィンドウの中で動いた */
  move(x: number, y: number): void;
  /** ポインタがウィンドウの外に出た */
  leave(): void;
  /** いまの位置で調べ直す（画面の中身が変わったとき、定期的な確認） */
  recheck(): void;
}

export function createMouseRouter(deps: MouseRouterDeps): MouseRouter {
  const now = deps.now ?? (() => performance.now());
  const resendMs = deps.resendMs ?? 400;
  let x = 0;
  let y = 0;
  let inside = false;
  let interactive = false;
  let lastSent = Number.NEGATIVE_INFINITY;

  const evaluate = () => {
    const want = inside && deps.isInteractiveAt(x, y);
    const t = now();
    if (want === interactive && !(want && t - lastSent >= resendMs)) return;
    interactive = want;
    lastSent = t;
    deps.send(want);
  };

  return {
    move(nx, ny) {
      x = nx;
      y = ny;
      inside = true;
      evaluate();
    },
    leave() {
      inside = false;
      evaluate();
    },
    recheck: evaluate,
  };
}
