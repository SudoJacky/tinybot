import assert from "node:assert/strict";
import { focusTourTarget } from "./feature-tour-positioning.js";

function createTarget(rect) {
  const calls = [];
  return {
    calls,
    getBoundingClientRect() {
      return rect;
    },
    scrollIntoView(options) {
      calls.push(options);
    },
  };
}

const visibleTarget = createTarget({
  left: 24,
  top: 32,
  right: 280,
  bottom: 240,
  width: 256,
  height: 208,
});

assert.equal(
  focusTourTarget(visibleTarget, { width: 1120, height: 760 }),
  false,
  "visible tour target should not request page scrolling",
);
assert.deepEqual(visibleTarget.calls, []);

const oversizedVisibleTarget = createTarget({
  left: 0,
  top: 20,
  right: 300,
  bottom: 7600,
  width: 300,
  height: 7580,
});

assert.equal(
  focusTourTarget(oversizedVisibleTarget, { width: 1120, height: 760 }),
  false,
  "oversized tour target with visible content should not request page scrolling",
);
assert.deepEqual(oversizedVisibleTarget.calls, []);

const hiddenTarget = createTarget({
  left: 24,
  top: 820,
  right: 280,
  bottom: 980,
  width: 256,
  height: 160,
});

assert.equal(
  focusTourTarget(hiddenTarget, { width: 1120, height: 760 }),
  true,
  "offscreen tour target should request scrolling",
);
assert.deepEqual(hiddenTarget.calls, [{ block: "center", inline: "center", behavior: "smooth" }]);

console.log("feature tour positioning tests passed");
