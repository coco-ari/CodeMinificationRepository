import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;
  propagationStopped?: boolean = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  disabled = false;
  focused = false;
  fixedOrigin = { left: 0, top: 0 };
  type = "";
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  get isConnected() {
    let current: FakeElement | null = this;
    while (current?.parent) {
      current = current.parent;
    }
    return current?.tagName === "body";
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  closest(selector: string): FakeElement | null {
    const roles = [...selector.matchAll(/\[role="([^"]+)"\]/g)].map((match) => match[1]);
    let current: FakeElement | null = this;
    while (current) {
      if (roles.includes(current.getAttribute("role") ?? "")) return current;
      current = current.parent;
    }
    return null;
  }

  contains(target: FakeElement): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  click() {
    if (!this.disabled) this.dispatchEvent(new FakeDomEvent("click"));
  }

  focus() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.focusBoundary && !fakeDocument.focusBoundary.contains(this)) return;
    if (fakeDocument.activeElement === this) {
      return;
    }
    fakeDocument.activeElement?.blur();
    fakeDocument.activeElement = this;
    this.focused = true;
    this.dispatchEvent(new FakeDomEvent("focus"));
  }

  blur() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      fakeDocument.activeElement = null;
    }
    this.focused = false;
    this.dispatchEvent(new FakeDomEvent("blur"));
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = (Number.parseFloat(this.style.left ?? "0") || 0) + (this.parent?.fixedOrigin.left ?? 0);
    const top = (Number.parseFloat(this.style.top ?? "0") || 0) + (this.parent?.fixedOrigin.top ?? 0);
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  activeElement: FakeElement | null = null;
  focusBoundary: FakeElement | null = null;
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener, _capture?: boolean) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  dispatchEvent(event: FakeDomEvent) {
    (window as unknown as FakeWindow).dispatchEvent(event);
    if (event.propagationStopped) return !event.defaultPrevented;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return !event.defaultPrevented;
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

class FakeWindow {
  innerWidth = 1280;
  innerHeight = 800;
  private readonly listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener, _capture?: boolean) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener, _capture?: boolean) {
    const existing = this.listeners.get(type) ?? [];
    const index = existing.indexOf(listener);
    if (index >= 0) existing.splice(index, 1);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

function pressKey(key: string, init: Record<string, unknown> = {}) {
  const event = new KeyboardEvent("keydown", { key, ...init });
  (document as unknown as FakeDocument).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("window", new FakeWindow());
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  dismissContextMenu();
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("renders one separator between menu sections", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "archive", label: "Archive", separatorBefore: true },
    ]);
    const separators = (document as unknown as FakeDocument)
      .querySelectorAll("div")
      .filter((element) => element.dataset.contextMenuSeparator === "true");

    expect(separators).toHaveLength(1);
    expect(separators[0]?.attributes.get("role")).toBe("separator");
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("ignores a click from the gesture that opened the menu", async () => {
    let enablePointerSelection: ((time: number) => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      enablePointerSelection = callback;
      return 0;
    });

    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const renameButton = findButton("Rename");

    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    enablePointerSelection?.(0);
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });

  it("opens and focuses nested submenus when the parent is activated", async () => {
    const invoker = (document as unknown as FakeDocument).createElement("button");
    (document as unknown as FakeDocument).body.appendChild(invoker);
    invoker.focus();
    const selectionPromise = showContextMenuFallback([
      {
        id: "copy:submenu",
        label: "Copy",
        children: [
          { id: "copy:path", label: "Path" },
          { id: "copy:branch", label: "Branch" },
        ],
      },
    ]);

    const parentButton = findButton("Copy");
    expect(parentButton).toBeTruthy();
    expect(parentButton?.attributes.get("aria-haspopup")).toBe("menu");
    expect(parentButton?.attributes.get("aria-expanded")).toBe("false");
    parentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(parentButton?.attributes.get("aria-expanded")).toBe("true");

    const childButton = findButton("Path");
    const siblingButton = findButton("Branch");
    expect(childButton).toBeTruthy();
    expect(siblingButton).toBeTruthy();
    expect(childButton?.focused).toBe(true);
    expect(childButton?.style.background).toBe("var(--accent)");
    expect(childButton?.style.color).toBe("var(--contrast-accent-foreground)");
    siblingButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(childButton?.focused).toBe(false);
    expect(childButton?.style.background).toBe("transparent");
    expect(siblingButton?.focused).toBe(true);
    expect(siblingButton?.style.background).toBe("var(--accent)");
    siblingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("copy:branch");
    expect(invoker.focused).toBe(true);
  });

  it("provides menu semantics and focuses the first enabled item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "header", label: "Actions", header: true },
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "rename", label: "Rename" },
      { id: "checked", label: "Pinned", checked: true },
    ]);
    const menu = (document as unknown as FakeDocument).body.children[0];
    expect(menu?.attributes.get("role")).toBe("menu");
    expect(menu?.attributes.get("aria-orientation")).toBe("vertical");
    expect(findButton("Rename")?.attributes.get("role")).toBe("menuitem");
    expect(findButton("Disabled")?.attributes.get("aria-disabled")).toBe("true");
    expect(findButton("Pinned")?.attributes.get("role")).toBe("menuitemradio");
    expect(findButton("Pinned")?.attributes.get("aria-checked")).toBe("true");
    expect(findButton("Rename")?.focused).toBe(true);
    expect(findButton("Rename")?.style.background).toBe("var(--accent)");
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("moves focus with arrows and Home/End without selecting actions", async () => {
    const settled = vi.fn();
    const selectionPromise = showContextMenuFallback([
      { id: "first", label: "First" },
      { id: "header", label: "Section", header: true },
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "last", label: "Last" },
    ]);
    void selectionPromise.then(settled);
    expect(pressKey("ArrowDown").defaultPrevented).toBe(true);
    expect(findButton("Last")?.focused).toBe(true);
    pressKey("ArrowDown");
    expect(findButton("First")?.focused).toBe(true);
    pressKey("ArrowUp");
    expect(findButton("Last")?.focused).toBe(true);
    pressKey("Home");
    expect(findButton("First")?.focused).toBe(true);
    pressKey("End");
    expect(findButton("Last")?.focused).toBe(true);
    pressKey("ArrowRight");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("opens a submenu with Right and returns to its parent with Left", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "copy", label: "Copy", children: [
        { id: "disabled", label: "Disabled", disabled: true },
        { id: "path", label: "Path" },
        { id: "branch", label: "Branch" },
      ] },
      { id: "rename", label: "Rename" },
    ]);
    pressKey("ArrowRight");
    expect(findButton("Copy")?.attributes.get("aria-expanded")).toBe("true");
    expect(findButton("Path")?.focused).toBe(true);
    pressKey("ArrowDown");
    expect(findButton("Branch")?.focused).toBe(true);
    pressKey("ArrowLeft");
    expect(findButton("Path")).toBeUndefined();
    expect(findButton("Copy")?.attributes.get("aria-expanded")).toBe("false");
    expect(findButton("Copy")?.focused).toBe(true);
    pressKey("ArrowRight");
    pressKey("ArrowLeft");
    pressKey("ArrowDown");
    expect(findButton("Rename")?.focused).toBe(true);
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it.each([false, true])("closes on Tab without blocking its default focus movement (shift=%s)", async (shiftKey) => {
    const invoker = (document as unknown as FakeDocument).createElement("button");
    (document as unknown as FakeDocument).body.appendChild(invoker);
    invoker.focus();
    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    expect(pressKey("Tab", { shiftKey }).defaultPrevented).toBe(false);
    await expect(selectionPromise).resolves.toBeNull();
    expect(invoker.focused).toBe(true);
    expect(findButton("Rename")).toBeUndefined();
  });

  it("closes on Escape and restores the invoker, including after replacement", async () => {
    const invoker = (document as unknown as FakeDocument).createElement("button");
    (document as unknown as FakeDocument).body.appendChild(invoker);
    invoker.focus();
    const previousPromise = showContextMenuFallback([{ id: "old", label: "Old" }]);
    expect(findButton("Old")?.focused).toBe(true);
    const nextPromise = showContextMenuFallback([{ id: "new", label: "New" }]);
    await expect(previousPromise).resolves.toBeNull();
    expect(findButton("Old")).toBeUndefined();
    expect(findButton("New")?.focused).toBe(true);
    expect(pressKey("Escape").defaultPrevented).toBe(true);
    await expect(nextPromise).resolves.toBeNull();
    expect(invoker.focused).toBe(true);
  });

  it("leaves modified shortcuts, composition and keys outside the menu untouched", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "first", label: "First" },
      { id: "last", label: "Last" },
    ]);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }])
      expect(pressKey("ArrowDown", init).defaultPrevented).toBe(false);
    expect(pressKey("n").defaultPrevented).toBe(false);
    expect(findButton("First")?.focused).toBe(true);
    const outside = (document as unknown as FakeDocument).createElement("input");
    (document as unknown as FakeDocument).body.appendChild(outside);
    outside.focus();
    expect(pressKey("ArrowDown").defaultPrevented).toBe(false);
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
    expect(outside.focused).toBe(true);
  });

  it("keeps an all-disabled menu focusable without selecting anything", async () => {
    const selectionPromise = showContextMenuFallback([{ id: "disabled", label: "Disabled", disabled: true }]);
    const menu = (document as unknown as FakeDocument).body.children[0];
    expect(menu?.focused).toBe(true);
    pressKey("ArrowDown");
    pressKey("Home");
    expect(menu?.focused).toBe(true);
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it.each([
    { origin: { left: 0, top: 0 }, position: { x: 40, y: 60 }, viewport: { left: 40, top: 60 } },
    { origin: { left: 240.5, top: 110.25 }, position: { x: 280.75, y: 170.5 }, viewport: { left: 280.75, top: 170.5 } },
    { origin: { left: 240.5, top: 110.25 }, position: { x: 1180, y: 760 }, viewport: { left: 1096, top: 676 } },
  ])("keeps menus inside the modal focus/pointer boundary at viewport coordinates $viewport", async ({ origin, position, viewport }) => {
    const fakeDocument = document as unknown as FakeDocument;
    const dialog = fakeDocument.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.fixedOrigin = origin;
    fakeDocument.body.appendChild(dialog);
    const invoker = fakeDocument.createElement("button");
    dialog.appendChild(invoker);
    fakeDocument.focusBoundary = dialog;
    invoker.focus();
    const outsidePointer = vi.fn();
    fakeDocument.addEventListener("pointerdown", (event) => {
      const target = (event as FakeDomEvent & { target?: FakeElement }).target;
      if (target && !dialog.contains(target)) outsidePointer();
    }, true);
    const selectionPromise = showContextMenuFallback([
      { id: "copy", label: "Copy", children: [{ id: "path", label: "Path" }] },
    ], position);
    const menu = dialog.children.find((child) => child.attributes.get("role") === "menu");
    expect(menu).toBeTruthy();
    expect(fakeDocument.body.children).toEqual([dialog]);
    expect(findButton("Copy")?.focused).toBe(true);
    expect(menu?.getBoundingClientRect()).toMatchObject(viewport);
    // A second clamp pass must not accumulate the transformed host's offset.
    expect(Number.parseFloat(menu?.style.left ?? "0") + origin.left).toBe(viewport.left);
    expect(Number.parseFloat(menu?.style.top ?? "0") + origin.top).toBe(viewport.top);
    pressKey("ArrowRight");
    const child = findButton("Path");
    expect(child?.focused).toBe(true);
    expect(dialog.children.filter((node) => node.attributes.get("role") === "menu")).toHaveLength(2);
    fakeDocument.dispatchEvent(new FakeDomEvent("pointerdown", { target: child }));
    expect(outsidePointer).not.toHaveBeenCalled();
    child?.click();
    await expect(selectionPromise).resolves.toBe("path");
    expect(invoker.focused).toBe(true);
    expect(dialog.children).toEqual([invoker]);
  });

  it("handles Escape before the Sheet document-capture handler and removes its listener on close", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const sheetEscape = vi.fn();
    fakeDocument.addEventListener("keydown", (event) => {
      if ((event as FakeDomEvent & { key: string }).key === "Escape") sheetEscape();
    }, true);
    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const escape = pressKey("Escape") as unknown as FakeDomEvent;
    expect(escape.defaultPrevented).toBe(true);
    expect(escape.propagationStopped).toBe(true);
    expect(sheetEscape).not.toHaveBeenCalled();
    await expect(selectionPromise).resolves.toBeNull();
    pressKey("Escape");
    expect(sheetEscape).toHaveBeenCalledTimes(1);
  });

  it("does not capture modal shortcuts, composing Escape, or Tab's native movement", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const received = vi.fn();
    fakeDocument.addEventListener("keydown", received, true);
    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const escape = pressKey("Escape", init) as unknown as FakeDomEvent;
      expect(escape.defaultPrevented).toBe(false);
      expect(escape.propagationStopped).toBe(false);
    }
    expect(received).toHaveBeenCalledTimes(6);
    const tab = pressKey("Tab") as unknown as FakeDomEvent;
    expect(tab.defaultPrevented).toBe(false);
    expect(tab.propagationStopped).toBe(false);
    expect(received).toHaveBeenCalledTimes(7);
    await expect(selectionPromise).resolves.toBeNull();
  });
});

describe("dismissContextMenu", () => {
  it("resolves an open menu with null", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete" },
    ]);
    expect(findButton("Rename")).toBeTruthy();

    dismissContextMenu();

    await expect(selectionPromise).resolves.toBeNull();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("is a no-op when no menu is open", async () => {
    dismissContextMenu();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("dismisses the prior menu when a new one opens", async () => {
    const firstPromise = showContextMenuFallback([{ id: "first", label: "First" }]);
    expect(findButton("First")).toBeTruthy();

    const secondPromise = showContextMenuFallback([{ id: "second", label: "Second" }]);

    await expect(firstPromise).resolves.toBeNull();
    expect(findButton("First")).toBeUndefined();
    expect(findButton("Second")).toBeTruthy();

    dismissContextMenu();
    await expect(secondPromise).resolves.toBeNull();
  });
});
