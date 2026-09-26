import { expect, test } from "bun:test";

import { type Act, authorityOverTime, consumption, perChain, resample } from "./series";

const A = "0xaaaa";
const B = "0xbbbb";

const acts: Act[] = [
  { chainId: 1, kind: "granted", timestamp: 100, amount: "5000000", token: A },
  { chainId: 1, kind: "granted", timestamp: 100, amount: "3000000", token: B },
  { chainId: 2, kind: "granted", timestamp: 200, amount: "1000000", token: A },
  { chainId: 1, kind: "locked", timestamp: 300, amount: "0", token: A },
];

test("a permit sets the pair's allowance rather than adding to it", () => {
  const s = authorityOverTime([
    { chainId: 1, kind: "granted", timestamp: 10, amount: "5000000", token: A },
    { chainId: 1, kind: "granted", timestamp: 20, amount: "7000000", token: A },
  ]);
  expect(s.map((p) => p.v)).toEqual([5, 7]);
});

test("two grants in one signature share a point instead of drawing a step", () => {
  const s = authorityOverTime(acts);
  expect(s[0]).toEqual({ t: 100, v: 8 });
  expect(s).toHaveLength(3);
});

test("a lock takes the pair to zero and the total falls", () => {
  const s = authorityOverTime(acts);
  expect(s[s.length - 1]!.v).toBe(4); // B on chain 1 (3) + A on chain 2 (1)
});

test("a burned salt changes nothing outstanding", () => {
  const s = authorityOverTime([...acts, { chainId: 1, kind: "cancelled", timestamp: 400 }]);
  expect(s).toHaveLength(3);
});

test("filtering by token isolates that asset", () => {
  expect(authorityOverTime(acts, B).map((p) => p.v)).toEqual([3]);
});

test("per-chain totals count the last state of each pair", () => {
  expect(perChain(acts, [1, 2])).toEqual([3, 1]);
});

test("resampling holds each step rather than ramping between them", () => {
  const r = resample([{ t: 0, v: 0 }, { t: 10, v: 10 }], 5);
  expect(r).toEqual([0, 0, 0, 0, 10]);
  expect(resample([], 5)).toEqual([]);
  expect(resample([{ t: 3, v: 2 }], 3)).toEqual([2, 2, 2]);
});

test("consumption is a clamped fraction and unknown remaining reads as nothing spent", () => {
  expect(consumption([{ granted: 10, remaining: 4 }])).toEqual([0.6]);
  expect(consumption([{ granted: 10, remaining: undefined }])).toEqual([0]);
  expect(consumption([{ granted: 0, remaining: 0 }])).toEqual([0]);
});
