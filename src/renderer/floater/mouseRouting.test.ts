import { describe, expect, it } from 'vitest';
import { createMouseRouter } from './mouseRouting';

/** Represents the interactive elements as a list of rectangles */
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
  it('takes input when the pointer is over the bar and passes it through when the pointer leaves', () => {
    const t = setup();
    t.rects.push({ x: 170, y: 240, w: 60, h: 12 });
    t.router.move(10, 10);
    expect(t.sent).toEqual([]);
    t.router.move(200, 245);
    expect(t.sent).toEqual([true]);
    t.router.move(200, 100);
    expect(t.sent).toEqual([true, false]);
  });

  it('goes back to passing input through when the element disappears under a still pointer', () => {
    const t = setup();
    // The pointer is over a notification card
    t.rects.push({ x: 30, y: 150, w: 340, h: 60 });
    t.router.move(300, 170);
    expect(t.sent).toEqual([true]);
    // The notification was closed (the element disappeared). No mouseleave arrives
    t.rects.length = 0;
    t.router.recheck();
    expect(t.sent).toEqual([true, false]);
  });

  it('goes back to passing input through when the pointer leaves the window', () => {
    const t = setup();
    t.rects.push({ x: 170, y: 240, w: 60, h: 12 });
    t.router.move(200, 245);
    t.router.leave();
    expect(t.sent).toEqual([true, false]);
    // After leaving, it does not take input even if an element is at the same position
    t.router.recheck();
    expect(t.sent).toEqual([true, false]);
  });

  it('resends the same value at a fixed interval while taking input (so that the safeguard in main does not expire)', () => {
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

  it('sends nothing while passing input through', () => {
    const t = setup();
    t.router.move(10, 10);
    t.advance(1000);
    t.router.recheck();
    t.router.move(20, 20);
    expect(t.sent).toEqual([]);
  });
});
