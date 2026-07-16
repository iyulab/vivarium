import { test } from "node:test";
import assert from "node:assert/strict";
import { assignStableIds, installStableIdentity } from "./stable-id.ts";
import type { IdentifiableElement } from "./stable-id.ts";

interface FakeElement extends IdentifiableElement {
  children: FakeElement[];
  writes: number;
}

function el(tag: string, children: FakeElement[] = [], attrs: Record<string, string> = {}): FakeElement {
  const attributes = new Map(Object.entries(attrs));
  const node: FakeElement = {
    tagName: tag.toUpperCase(),
    children,
    writes: 0,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
      node.writes++;
    },
  };
  return node;
}

function tree(): FakeElement {
  return el("div", [
    el("header", [el("h1"), el("button")]),
    el("main", [el("button"), el("button"), el("p")]),
  ]);
}

test("ids are deterministic structural paths with per-tag sibling indexing", () => {
  const root = tree();
  const ids = assignStableIds(root);
  assert.deepEqual(ids, [
    "viv:header[0]",
    "viv:header[0]/h1[0]",
    "viv:header[0]/button[0]",
    "viv:main[0]",
    "viv:main[0]/button[0]",
    "viv:main[0]/button[1]",
    "viv:main[0]/p[0]",
  ]);
});

test("re-rendering the same structure yields identical ids", () => {
  assert.deepEqual(assignStableIds(tree()), assignStableIds(tree()));
});

test("assignment is idempotent — second pass writes nothing", () => {
  const root = tree();
  assignStableIds(root);
  const writesAfterFirst = root.children.map((c) => c.writes);
  const second = assignStableIds(root);
  assert.deepEqual(root.children.map((c) => c.writes), writesAfterFirst);
  assert.equal(second.length, 7);
});

test("authored ids are preserved and anchor their descendants", () => {
  const root = el("div", [
    el("section", [el("button"), el("input")], { "data-viv-id": "sidebar" }),
    el("section", [el("button")]),
  ]);
  const ids = assignStableIds(root);
  assert.deepEqual(ids, [
    "sidebar",
    "viv:@sidebar/button[0]",
    "viv:@sidebar/input[0]",
    "viv:section[1]",
    "viv:section[1]/button[0]",
  ]);
});

test("anchored descendants survive the anchor moving position", () => {
  const before = el("div", [
    el("aside"),
    el("section", [el("button")], { "data-viv-id": "sidebar" }),
  ]);
  const after = el("div", [
    el("section", [el("button")], { "data-viv-id": "sidebar" }),
    el("aside"),
  ]);
  const beforeIds = assignStableIds(before);
  const afterIds = assignStableIds(after);
  assert.ok(beforeIds.includes("viv:@sidebar/button[0]"));
  assert.ok(afterIds.includes("viv:@sidebar/button[0]"));
});

test("a stale synthesized id is recomputed after a structural move", () => {
  const root = tree();
  assignStableIds(root);
  // Simulate a re-render that moved <p> to be the first main child.
  const main = root.children[1];
  const p = main.children[2];
  main.children.splice(2, 1);
  main.children.unshift(p);
  const ids = assignStableIds(root);
  assert.ok(ids.includes("viv:main[0]/p[0]"));
  assert.equal(p.getAttribute("data-viv-id"), "viv:main[0]/p[0]");
});

test("installStableIdentity assigns immediately and reassigns on mutation", async () => {
  const root = tree();
  let mutationCallback: (() => void) | null = null;
  let observed: unknown = null;
  let disconnected = false;
  class FakeObserver {
    constructor(callback: () => void) {
      mutationCallback = callback;
    }
    observe(target: unknown, options: { childList: boolean; subtree: boolean }) {
      observed = { target, options };
    }
    disconnect() {
      disconnected = true;
    }
  }

  const maintainer = installStableIdentity(root, FakeObserver);
  assert.equal(root.children[0].getAttribute("data-viv-id"), "viv:header[0]");
  assert.deepEqual((observed as { options: unknown }).options, { childList: true, subtree: true });

  // Dynamic insert, then a mutation batch fires.
  root.children[1].children.push(el("span"));
  mutationCallback?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const span = root.children[1].children[3];
  assert.equal(span.getAttribute("data-viv-id"), "viv:main[0]/span[0]");

  assert.ok(maintainer.refresh().includes("viv:main[0]/span[0]"));
  maintainer.disconnect();
  assert.equal(disconnected, true);
});
