import { describe, expect, it } from "vite-plus/test";
import { LRUCache } from "../../../../apps/web/src/lib/lruCache";

describe("LRUCache", () => {
  it("evicts oldest by max entries and promotes on get", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");

    // Promote b so the next insert evicts c (least recently used).
    expect(cache.get("b")).toBe("B");
    cache.set("d", "D", 10);
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBeNull();
    expect(cache.get("d")).toBe("D");
  });

  it("evicts by memory budget", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("does not cache entries larger than the memory budget", () => {
    const cache = new LRUCache<string>(2, 25);
    cache.set("a", "A", 10);
    cache.set("oversized", "X", 30);

    expect(cache.get("a")).toBe("A");
    expect(cache.get("oversized")).toBeNull();
  });

  it("preserves an existing entry when an oversized replacement is rejected", () => {
    const cache = new LRUCache<string>(2, 25);
    cache.set("a", "A", 10);
    cache.set("a", "oversized", 30);

    expect(cache.get("a")).toBe("A");
  });
});
