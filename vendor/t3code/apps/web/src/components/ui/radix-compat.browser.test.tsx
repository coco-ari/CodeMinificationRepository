import { act, render } from "../../../test/render";
import { useState, createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { RadioGroup, Radio } from "./radio-group";
import { ToggleGroup, Toggle } from "./toggle-group";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./collapsible";
import { ScrollArea } from "./scroll-area";
import { NumberField, NumberFieldInput, NumberFieldGroup, NumberFieldIncrement } from "./number-field";
import { Toast } from "./radix-toast";

describe("T3 Radix compatibility", () => {
  it("composes a render callback's ref and click once", async () => {
    const ref = createRef<HTMLButtonElement>(); const clicked = vi.fn();
    await using screen = await render(<Button ref={ref} onClick={clicked} render={(props) => <button {...props} />}>Run</Button>);
    expect(ref.current).toBe(screen.container.querySelector("button"));
    await act(() => ref.current!.click()); expect(clicked).toHaveBeenCalledTimes(1);
  });
  it("preserves checkbox mixed state, read-only, cancel and form value", async () => {
    function Example() { const [checked, setChecked] = useState(false); const [mixed, setMixed] = useState(true);
      return <form><Checkbox aria-label="mixed" name="selected" checked={checked} indeterminate={mixed} onCheckedChange={(next) => { setMixed(false); setChecked(next); }} /><Checkbox aria-label="locked" readOnly /><Checkbox aria-label="cancel" onCheckedChange={(_, details) => details.cancel()} /></form>; }
    await using screen = await render(<Example />);
    const buttons = screen.container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    expect(buttons[0]!.getAttribute("aria-checked")).toBe("mixed");
    await act(() => { for (const button of buttons) button.click(); });
    expect(buttons[0]!.getAttribute("aria-checked")).toBe("true");
    expect(new FormData(screen.container.querySelector("form")!).get("selected")).toBe("on");
    expect(buttons[1]!.getAttribute("aria-checked")).toBe("false");
    expect(buttons[2]!.getAttribute("aria-checked")).toBe("false");
  });
  it("preserves input callback details and controlled editing", async () => {
    const onValueChange = vi.fn();
    await using screen = await render(<Input aria-label="name" defaultValue="old" onValueChange={onValueChange} />);
    await screen.getByRole("textbox").fill("new");
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe("new");
    expect(onValueChange.mock.calls.at(-1)?.[1].reason).toBe("none");
  });
  it("retains keyboard radio selection and toggle array values", async () => {
    const selected = vi.fn(); const toggled = vi.fn();
    await using screen = await render(<><RadioGroup defaultValue="one" onValueChange={selected}><Radio value="one" aria-label="one" /><Radio value="two" aria-label="two" /></RadioGroup><ToggleGroup defaultValue={["a"]} onValueChange={toggled}><Toggle value="a">A</Toggle><Toggle value="b">B</Toggle></ToggleGroup></>);
    await screen.getByRole("radio", { name: "one" }).click(); await userEvent.keyboard("{ArrowDown>}");
    await vi.waitFor(() => expect(selected.mock.calls.at(-1)?.[0]).toBe("two"));
    await userEvent.keyboard("{/ArrowDown}");
    await screen.getByRole("radio", { name: "B" }).click();
    expect(toggled.mock.calls.at(-1)?.[0]).toEqual(["b"]);
  });
  it("reveals retained collapsed contents for browser find", async () => {
    await using screen = await render(<Collapsible><CollapsibleTrigger>Details</CollapsibleTrigger><CollapsiblePanel hiddenUntilFound>Searchable text</CollapsiblePanel></Collapsible>);
    const panel = screen.container.querySelector<HTMLElement>('[data-slot="collapsible-panel"]')!;
    expect(panel.getAttribute("hidden")).toBe("until-found");
    await act(() => panel.dispatchEvent(new Event("beforematch")));
    expect(panel.hidden).toBe(false);
    expect(screen.container.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  });
  it("keeps hidden-scrollbar areas scrollable and updates fade distances on growth", async () => {
    await using screen = await render(<div style={{ width: 240, height: 100 }}><ScrollArea hideScrollbars scrollFade><div style={{ height: 600 }}>Long content</div></ScrollArea></div>);
    const viewport = screen.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "100px"; viewport.style.width = "240px";
    await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    await act(() => { viewport.scrollTop = 200; viewport.dispatchEvent(new Event("scroll")); });
    expect(viewport.scrollTop).toBe(200);
    expect(viewport.style.getPropertyValue("--scroll-area-overflow-y-start")).toBe("200px");
  });
  it("commits bounded numeric steps and blur edits", async () => {
    const changed = vi.fn(); const committed = vi.fn();
    await using screen = await render(<NumberField defaultValue={2} min={0} max={3} onValueChange={changed} onValueCommitted={committed}><NumberFieldGroup><NumberFieldInput aria-label="count" /><NumberFieldIncrement aria-label="increase" /></NumberFieldGroup></NumberField>);
    await screen.getByRole("button", { name: "increase" }).click();
    expect(changed.mock.calls.at(-1)?.[0]).toBe(3); expect(committed.mock.calls.at(-1)?.[0]).toBe(3);
    await screen.getByRole("spinbutton").fill("12"); await act(() => screen.container.querySelector<HTMLInputElement>('[role="spinbutton"]')!.blur());
    expect(committed.mock.calls.at(-1)?.[0]).toBe(3);
  });
  it("updates and dismisses Radix notifications without losing action or text", async () => {
    const manager = Toast.createToastManager(); const action = vi.fn();
    function Notifications() { const { toasts } = Toast.useToastManager(); return <Toast.Viewport>{toasts.map((toast) => <Toast.Root key={toast.id} toast={toast}><Toast.Content><Toast.Title /><Toast.Description /><Toast.Action /></Toast.Content></Toast.Root>)}</Toast.Viewport>; }
    await using screen = await render(<Toast.Provider toastManager={manager} timeout={0}><Notifications /></Toast.Provider>);
    let id = ""; await act(() => { id = manager.add({ title: "Working", description: "Details", actionProps: { children: "Retry", onClick: action } }); });
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Working"));
    await act(() => manager.update(id, { title: "Done", actionProps: undefined }));
    expect(screen.container.textContent).toContain("Done");
    await screen.getByRole("button", { name: "Retry" }).click(); expect(action).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Done"));
  });
  it("positions anchored notifications beside the real anchor without stealing focus", async () => {
    const manager = Toast.createToastManager();
    function Notifications() { const { toasts } = Toast.useToastManager(); return <Toast.Viewport>{toasts.map((toast) => <Toast.Positioner key={toast.id} toast={toast}><Toast.Root toast={toast}><Toast.Content><Toast.Title /></Toast.Content></Toast.Root></Toast.Positioner>)}</Toast.Viewport>; }
    await using screen = await render(<Toast.Provider toastManager={manager} timeout={0}><button style={{ position: "fixed", top: 300, left: 200 }}>Anchor</button><Notifications /></Toast.Provider>);
    const anchor = screen.container.querySelector("button")!;
    await act(() => { anchor.focus(); manager.add({ title: "Anchored hint", positionerProps: { anchor, side: "bottom", sideOffset: 8 } }); });
    await vi.waitFor(() => {
      const popup = screen.container.querySelector<HTMLElement>('[data-slot="toast-positioner"]')!;
      expect(popup.getBoundingClientRect().top).toBeGreaterThanOrEqual(anchor.getBoundingClientRect().bottom + 7);
    });
    expect(document.activeElement).toBe(anchor);
    await act(() => manager.close());
  });
  it("retains pause-on-hover and auto-dismiss duration", async () => {
    const manager = Toast.createToastManager();
    function Notifications() { const { toasts } = Toast.useToastManager(); return <Toast.Viewport>{toasts.map((toast) => <Toast.Root key={toast.id} toast={toast}><Toast.Title /></Toast.Root>)}</Toast.Viewport>; }
    await using screen = await render(<Toast.Provider toastManager={manager} timeout={200}><Notifications /></Toast.Provider>);
    await act(() => { manager.add({ title: "Timed notification" }); });
    await userEvent.hover(screen.getByText("Timed notification"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.container.querySelector('[data-state="open"]')).not.toBeNull();
    await userEvent.unhover(screen.getByText("Timed notification"));
    await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Timed notification"), { timeout: 1600 });
  });

});
