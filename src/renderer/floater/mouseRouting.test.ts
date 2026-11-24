import { describe, expect, it } from 'vitest';
import { createMouseRouter } from './mouseRouting';

/** 操作できる要素を、矩形の一覧で表す */
function setup() {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const sent: boolean[] = [];
  let t = 0;
  const router = createMouseRouter({
    isInteractiveAt: (x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h),
    send: (v) => sent.push(v),
    now: () => t,
    resendMs: 400,
  });
  return { rects, sent, router, advance: (ms: number) => (t += ms) };
}

describe('createMouseRouter', () => {
  it('ポインタがバーの上に来たら受け取り、離れたら下のアプリに通す', () => {
    const t = setup();
    t.rects.push({ x: 170, y: 240, w: 60, h: 12 });
    t.router.move(10, 10);
    expect(t.sent).toEqual([]);
    t.router.move(200, 245);
    expect(t.sent).toEqual([true]);
    t.router.move(200, 100);
    expect(t.sent).toEqual([true, false]);
  });

  it('ポインタが乗ったまま要素が消えたら、ポインタが動かなくても通す状態に戻す', () => {
    const t = setup();
    // 通知のカードの上にポインタがある
    t.rects.push({ x: 30, y: 150, w: 340, h: 60 });
    t.router.move(300, 170);
    expect(t.sent).toEqual([true]);
    // 通知を閉じた（要素が消えた）。mouseleave は来ない
    t.rects.length = 0;
    t.router.recheck();
    expect(t.sent).toEqual([true, false]);
  });

  it('ポインタがウィンドウの外に出たら、通す状態に戻す', () => {
    const t = setup();
    t.rects.push({ x: 170, y: 240, w: 60, h: 12 });
    t.router.move(200, 245);
    t.router.leave();
    expect(t.sent).toEqual([true, false]);
    // 外に出た後は、同じ位置に要素があっても受け取らない
    t.router.recheck();
    expect(t.sent).toEqual([true, false]);
  });

  it('受け取る状態のあいだは、同じ値を一定の間隔で送り直す（main の保険が切れないように）', () => {
    const t = setup();
    t.rects.push({ x: 170, y: 240, w: 60, h: 12 });
    t.router.move(200, 245);
    t.advance(100);
    t.router.recheck();
    expect(t.sent).toEqual([true]);
    t.advance(400);
    t.router.recheck();
    expect(t.sent).toEqual([true, true]);
  });

  it('通す状態のあいだは、何も送らない', () => {
    const t = setup();
    t.router.move(10, 10);
    t.advance(1000);
    t.router.recheck();
    t.router.move(20, 20);
    expect(t.sent).toEqual([]);
  });
});
