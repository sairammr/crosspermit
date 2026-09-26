import { expect, test } from "bun:test";

import { STRATEGIES, projectUnits, recommend } from "./strategies";

const ALL = [84532, 11155420, 11155111];
const base = { capUnits: 50_000_000n, ttlHours: 720, chainIds: ALL };

test("nothing undeployed is ever routable", () => {
  for (const r of recommend(base)) {
    if (r.strategy.liveOn.length === 0) expect(r.routable).toBe(false);
    if (r.routable) expect(r.on.length).toBeGreaterThan(0);
  }
});

test("routable strategies sort above designed ones whatever they score", () => {
  const rs = recommend(base);
  const lastRoutable = rs.map((r) => r.routable).lastIndexOf(true);
  const firstBlocked = rs.findIndex((r) => !r.routable);
  expect(firstBlocked).toBeGreaterThan(lastRoutable);
});

test("a short mandate blocks a position that needs longer, and says so", () => {
  const lp = recommend({ ...base, ttlHours: 2 }).find((r) => r.strategy.key === "v4-lp")!;
  expect(lp.routable).toBe(false);
  expect(lp.blocked).toContain("2h");
});

test("a chain the client did not sign for is not offered", () => {
  const swap = recommend({ ...base, chainIds: [84532] }).find((r) => r.strategy.key === "v4-swap")!;
  expect(swap.on).toEqual([84532]);
});

test("an unsigned mandate blocks everything rather than quoting on zero", () => {
  for (const r of recommend({ capUnits: 0n, ttlHours: 0, chainIds: [] })) expect(r.routable).toBe(false);
});

test("projection is simple interest over the mandate's life, and null without a rate", () => {
  // 10,000.000000 units at 4.056% for a full year.
  expect(projectUnits(10_000_000_000n, 0.04056, 8760)).toBe(405_600_000n);
  // Half a year is half the return, not a compounded more.
  expect(projectUnits(10_000_000_000n, 0.04056, 4380)).toBe(202_800_000n);
  expect(projectUnits(10_000_000_000n, null, 8760)).toBeNull();
  expect(projectUnits(0n, 0.04, 8760)).toBeNull();
});

test("every catalogue entry carries its provenance and at least one risk", () => {
  for (const s of STRATEGIES) {
    expect(s.evidence.length).toBeGreaterThan(20);
    expect(s.risks.length).toBeGreaterThan(0);
    expect(s.legs.length).toBeGreaterThan(0);
  }
});
