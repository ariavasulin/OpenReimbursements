import { describe, expect, it } from "vitest";
import { slideshowOrder } from "./settings";

describe("the slideshow's playing order", () => {
  it("is the grid's order when not shuffling", () => {
    expect(slideshowOrder(4, false)).toEqual([0, 1, 2, 3]);
    expect(slideshowOrder(0, false)).toEqual([]);
  });

  it("is a permutation of every still when shuffling", () => {
    const order = slideshowOrder(6, true);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps the order already playing and shuffles only the stills added since", () => {
    const playing = [3, 0, 2, 1];
    const order = slideshowOrder(7, true, playing);
    expect(order.slice(0, 4)).toEqual(playing);
    expect([...order.slice(4)].sort((a, b) => a - b)).toEqual([4, 5, 6]);
  });

  it("drops a remembered position that no longer exists", () => {
    expect(slideshowOrder(2, true, [3, 1, 0])).toEqual([1, 0]);
  });

  it("draws with the given random source", () => {
    expect(slideshowOrder(3, true, [], () => 0)).toEqual([1, 2, 0]);
  });
});
