import { describe, expect, it } from "vitest";
import { layoutWorldGraph, type LayoutNode } from "./world-graph-layout";

const dist = (p: LayoutNode, q: LayoutNode) => Math.hypot(p.x - q.x, p.y - q.y);

describe("layoutWorldGraph", () => {
  it("returns nothing for an empty graph", () => {
    expect(layoutWorldGraph([], [])).toEqual({ nodes: [], width: 640, height: 420 });
  });

  it("centers a single node", () => {
    const { nodes } = layoutWorldGraph(["a"], []);
    expect(nodes).toEqual([{ id: "a", x: 320, y: 210 }]);
  });

  it("is deterministic — same input yields identical positions (stable renders + tests)", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "d", to: "e" },
    ];
    expect(layoutWorldGraph(ids, edges)).toEqual(layoutWorldGraph(ids, edges));
  });

  it("places every node inside the padded viewBox", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ];
    const { nodes, width, height } = layoutWorldGraph(ids, edges, { padding: 30 });
    expect(nodes).toHaveLength(6);
    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(30 - 0.001);
      expect(node.x).toBeLessThanOrEqual(width - 30 + 0.001);
      expect(node.y).toBeGreaterThanOrEqual(30 - 0.001);
      expect(node.y).toBeLessThanOrEqual(height - 30 + 0.001);
    }
  });

  it("settles a path so adjacent nodes sit closer than its far ends", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "d", to: "e" },
    ];
    const pos = new Map(layoutWorldGraph(ids, edges).nodes.map((n) => [n.id, n]));
    const a = pos.get("a");
    const b = pos.get("b");
    const e = pos.get("e");
    expect(a && b && e).toBeTruthy();
    if (a && b && e) expect(dist(a, b)).toBeLessThan(dist(a, e));
  });

  it("tolerates dangling and self edges without crashing", () => {
    const { nodes } = layoutWorldGraph(
      ["a", "b"],
      [
        { from: "a", to: "ghost" },
        { from: "a", to: "a" },
        { from: "a", to: "b" },
      ],
    );
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
});
