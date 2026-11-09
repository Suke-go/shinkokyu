import assert from "node:assert/strict";
import { syncClock, makeOffsetFn } from "./clock.js";

// makeOffsetFn
const f0 = makeOffsetFn([]);
assert.equal(f0(1000), 1000);
assert.equal(f0.unsynced, true);

const f1 = makeOffsetFn([{ phase: "start", offset: 10, at: 0 }]);
assert.equal(f1(500), 510);
assert.equal(f1.unsynced, undefined);

const f2 = makeOffsetFn([
  { phase: "start", offset: 0, at: 1000 },
  { phase: "end", offset: 20, at: 3000 },
]);
assert.equal(f2(1000), 1000);
assert.equal(f2(2000), 2010); // midpoint offset = 10
assert.equal(f2(3000), 3020);
assert.equal(f2(4000), 4030); // linear extrapolation
assert.equal(f2(0), -10);

// latest of each phase wins
const f3 = makeOffsetFn([
  { phase: "start", offset: 99, at: 0 },
  { phase: "start", offset: 5, at: 100 },
]);
assert.equal(f3(100), 105);

// syncClock on a fake fetch: server clock = client + 100, 5ms each way
function fake(up, down, serverOffset = 100) {
  let c = 1000;
  return {
    now: () => c,
    fetchImpl: async () => {
      c += up;
      const t1 = c + serverOffset;
      const t2 = t1; // zero server processing
      c += down;
      return { json: async () => ({ t1, t2 }) };
    },
  };
}
const progress = [];
const k = fake(5, 5);
const r = await syncClock({ phase: "start", gap: 0, fetchImpl: k.fetchImpl, now: k.now, onProgress: (i, n) => progress.push([i, n]) });
assert.equal(r.offset, 100);
assert.equal(r.delay, 10);
assert.equal(r.n, 17);
assert.equal(r.quality, "good");
assert.equal(r.attempts, 1);
assert.equal(r.phase, "start");
assert.deepEqual(progress[19], [20, 20]);

// asymmetric path: offset error = (up-down)/2
const k2 = fake(10, 2);
const r2 = await syncClock({ phase: "end", gap: 0, fetchImpl: k2.fetchImpl, now: k2.now });
assert.equal(r2.delay, 12);
assert.equal(r2.offset, 104);

// slow link -> bad after 1 + 3 attempts
const k3 = fake(60, 60);
const r3 = await syncClock({ phase: "start", gap: 0, n: 5, drop: 1, fetchImpl: k3.fetchImpl, now: k3.now });
assert.equal(r3.quality, "bad");
assert.equal(r3.attempts, 4);

console.log("clock.test.js: all passed");
