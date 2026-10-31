import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render as renderUi } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

const favoritesAtom = Atom.make<ReadonlyArray<{ provider: ProviderInstanceId; model: string }>>(
  [],
).pipe(Atom.keepAlive);

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({
    favorites: useAtomValue(favoritesAtom),
    providerModelPreferences: {},
  }),
  useToggleEnvironmentModelFavorite: () => {
    const setFavorites = useAtomSet(favoritesAtom);
    return async (provider: ProviderInstanceId, model: string) => {
      setFavorites((favorites) =>
        favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model),
      );
    };
  },
}));

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

// Returns the trigger's visible text, which is what the user reads before opening the picker.
async function triggerText(node: ReactNode) {
  await using screen = await renderUi(node);
  return screen.container.querySelector("button")?.textContent ?? "";
}

function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  triggerLabel?: string;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver);
  return triggerText(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      onInstanceModelChange={() => {}}
      {...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {})}
    />,
  );
}

async function click(target: Parameters<typeof userEvent.click>[0]) {
  await userEvent.click(target);
}

async function openLegacyPicker(activeModel: string) {
  const entry = providerEntry("codex", "codex");
  await using stack = new AsyncDisposableStack();
  const pickerRegistry = AtomRegistry.make();
  stack.defer(() => pickerRegistry.dispose());
  pickerRegistry.set(favoritesAtom, [
    { provider: entry.instanceId, model: "current-favorite" },
    { provider: entry.instanceId, model: "legacy-favorite" },
  ]);
  stack.use(
    await renderUi(
      <RegistryContext.Provider value={pickerRegistry!}>
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={entry.instanceId}
          model={activeModel}
          lockedProvider={null}
          instanceEntries={[entry]}
          modelOptionsByInstance={
            new Map([
              [
                entry.instanceId,
                [
                  { slug: "current", name: "Current model" },
                  { slug: "legacy-favorite", name: "Legacy favorite", isLegacy: true },
                  { slug: "current-favorite", name: "Current favorite" },
                  { slug: "other-legacy", name: "Other legacy", isLegacy: true },
                ],
              ],
            ])
          }
          onInstanceModelChange={() => {}}
        />
      </RegistryContext.Provider>,
    ),
  );
  await click(document.querySelector("button")!);
  await click(page.getByRole("button", { name: entry.displayName, exact: true }));
  return stack.move();
}

describe("ProviderModelPicker", () => {
  it("hoists legacy favorites in provider order and returns an unfavorited model to legacy", async () => {
    await using _screen = await openLegacyPicker("current");
    const legacyFavorite = page.getByRole("option", { name: /Legacy favorite/ });
    const currentFavorite = page.getByRole("option", { name: /Current favorite/ });
    const current = page.getByRole("option", { name: /Current model/ });
    const legacySection = page.getByRole("option", { name: /旧版模型/ });

    await expect.element(legacyFavorite).toBeVisible();
    await expect.element(currentFavorite).toBeVisible();
    await expect.element(current).toBeVisible();
    expect(legacyFavorite.element().getBoundingClientRect().top).toBeLessThan(
      currentFavorite.element().getBoundingClientRect().top,
    );
    expect(currentFavorite.element().getBoundingClientRect().top).toBeLessThan(
      current.element().getBoundingClientRect().top,
    );

    await click(legacyFavorite.getByRole("button", { name: "取消收藏" }));
    await expect.element(legacyFavorite).not.toBeInTheDocument();
    await click(legacySection);
    await expect.element(legacyFavorite).toBeVisible();
    await expect.element(page.getByRole("option", { name: /Other legacy/ })).toBeVisible();
    expect(legacyFavorite.element().getBoundingClientRect().top).toBeGreaterThan(
      legacySection.element().getBoundingClientRect().top,
    );
    await expect
      .element(legacyFavorite.getByRole("button", { name: "加入收藏" }))
      .toBeVisible();
  });

  it("keeps unrelated legacy models collapsed when the active model is a favorite", async () => {
    await using _screen = await openLegacyPicker("legacy-favorite");

    await expect.element(page.getByRole("option", { name: /Legacy favorite/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /Other legacy/ }))
      .not.toBeInTheDocument();
    await click(page.getByRole("option", { name: /旧版模型/ }));
    await expect.element(page.getByRole("option", { name: /Other legacy/ })).toBeVisible();
  });

  it("shows a neutral aggregate value without a representative model or availability badge", async () => {
    const label = await renderPicker({
      instanceId: "codex_personal",
      driver: "codex",
      model: "gpt-5",
      options: [{ slug: "gpt-5", name: "GPT 5", isUnavailable: true }],
      triggerLabel: "Mixed values",
    });
    expect(label).toContain("Mixed values");
    expect(label).not.toContain("GPT 5");
    expect(label).not.toContain("Unavailable");
  });

  it.each(["", ANTIGRAVITY_DEFAULT_MODEL])(
    "shows a choice prompt before Antigravity has an account catalog for %s",
    async (model) => {
      const label = await renderPicker({
        instanceId: "antigravity",
        driver: "antigravity",
        model,
        options: [],
      });

      expect(label).toContain("选择模型");
      expect(label).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each([{ aliases: [ANTIGRAVITY_DEFAULT_MODEL] }, { isDefault: true }])(
    "shows the actual default model for an Antigravity marker with %j",
    async (defaultMetadata) => {
      const label = await renderPicker({
        instanceId: "google_work",
        driver: "antigravity",
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [
          { slug: "gemini-fast", name: "Gemini Fast" },
          { slug: "gemini-pro", name: "Gemini Pro", ...defaultMetadata },
        ],
      });

      expect(label).toContain("Gemini Pro");
      expect(label).not.toContain("Gemini Fast");
      expect(label).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each(["opencode", "antigravity"])(
    "keeps the selected model label when the %s account catalog does not contain it",
    async (driver) => {
      const label = await renderPicker({
        instanceId: "team_runtime",
        driver,
        model: "missing-model",
        options: [{ slug: "fallback", name: "Fallback model" }],
      });

      expect(label).toContain("missing-model");
      expect(label).not.toContain("Fallback model");
    },
  );

  it.each(["codex", "claudeAgent", "cursor", "grok"])(
    "uses the first option label for a missing %s model",
    async (driver) => {
      const label = await renderPicker({
        instanceId: `${driver}_work`,
        driver,
        model: "missing-model",
        options: [{ slug: "fallback-model", name: "Fallback model" }],
      });

      expect(label).toContain("Fallback model");
      expect(label).not.toContain("missing-model");
    },
  );

  it("prefers a matching model for OpenCode", async () => {
    const label = await renderPicker({
      instanceId: "custom_runtime",
      driver: "opencode",
      model: "openrouter/selected",
      options: [
        { slug: "openrouter/fallback", name: "Fallback model" },
        { slug: "openrouter/selected", name: "Selected model" },
      ],
    });

    expect(label).toContain("Selected model");
    expect(label).not.toContain("Fallback model");
  });

  it("uses the first option when the active instance entry is missing", async () => {
    const label = await renderPicker({
      instanceId: "missing_instance",
      driver: "opencode",
      model: "missing-model",
      options: [{ slug: "fallback-model", name: "Fallback model" }],
      includeEntry: false,
    });

    expect(label).toContain("Fallback model");
    expect(label).not.toContain("missing-model");
  });

  it("keeps instance initials visible in the resting trigger", async () => {
    const activeEntry = providerEntry("codex_personal", "codex");
    const label = await triggerText(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={activeEntry.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={[providerEntry("codex", "codex"), activeEntry]}
        modelOptionsByInstance={new Map()}
        size="xs"
        onInstanceModelChange={() => {}}
      />,
    );

    expect(label).toContain("CP");
  });
});

it("切换长短模型名称时预留同一槽位，不推挤相邻控件", async () => {
  await page.viewport(1440, 600);
  const entry = providerEntry("codex", "codex");
  const options = [{ slug: "short", name: "短模型" }, { slug: "long", name: "这是一个很长的模型名称用于验证选择后布局稳定" }];
  const view = (model: string) => <div className="flex items-center gap-2">
    <ProviderModelPicker environmentId={null} activeInstanceId={entry.instanceId} model={model}
      lockedProvider={null} instanceEntries={[entry]} modelOptionsByInstance={new Map([[entry.instanceId, options]])}
      onInstanceModelChange={() => {}} />
    <button>模型后面的操作</button>
  </div>;
  await using screen = await renderUi(view("short"));
  const before = screen.getByRole("button", { name: "模型后面的操作" }).element().getBoundingClientRect().x;
  await screen.rerender(view("long"));
  expect(screen.getByRole("button", { name: "模型后面的操作" }).element().getBoundingClientRect().x).toBe(before);
});

it.each([600, 900])("长模型列表在高度 %s 的窗口贴近触发按钮，搜索后仍保持位置", async (height) => {
  await page.viewport(1440, height);
  const entry = providerEntry("codex", "codex");
  const options = Array.from({ length: 40 }, (_, index) => ({ slug: `model-${index}`, name: `模型 ${index}` }));
  await using screen = await renderUi(
    <div style={{ position: "fixed", bottom: 80, left: 800 }}>
      <ProviderModelPicker environmentId={null} activeInstanceId={entry.instanceId} model="model-0"
        lockedProvider={null} instanceEntries={[entry]} modelOptionsByInstance={new Map([[entry.instanceId, options]])}
        onInstanceModelChange={() => {}} />
    </div>,
  );
  const trigger = screen.container.querySelector<HTMLElement>("[data-chat-provider-model-picker]")!;
  await userEvent.click(trigger);
  const search = page.getByPlaceholder("搜索模型…");
  await expect.element(search).toHaveFocus();
  const measure = () => {
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
    const bounds = popup.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
    return { side: popup.closest<HTMLElement>('[data-slot="popover-positioner"]')!.dataset.side,
      gap: Math.round(anchor.top - bounds.bottom), top: bounds.top };
  };
  await expect.poll(() => measure().side).toBe("top");
  await expect.poll(() => measure().gap).toBe(4);
  expect(measure().top).toBeGreaterThanOrEqual(0);
  await search.fill("模型 3");
  await expect.element(page.getByRole("option", { name: /模型 3/ }).first()).toBeVisible();
  await expect.poll(() => measure().gap).toBe(4);
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("未开放收藏时不显示星号或收藏分类，原有收藏偏好不阻止选择模型", async () => {
  const entry = providerEntry("codex", "codex"), onChange = vi.fn();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  registry.set(favoritesAtom, [{ provider: entry.instanceId, model: "two" }]);
  await using screen = await renderUi(
    <RegistryContext.Provider value={registry}>
      <ProviderModelPicker environmentId={null} activeInstanceId={entry.instanceId} model="one"
        favoritesEnabled={false} lockedProvider={null} instanceEntries={[entry]}
        modelOptionsByInstance={new Map([[entry.instanceId, [{ slug: "one", name: "模型一" }, { slug: "two", name: "模型二" }]]])}
        onInstanceModelChange={onChange} />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.container.querySelector<HTMLElement>("[data-chat-provider-model-picker]")!);
  await expect.element(page.getByPlaceholder("搜索模型…")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "收藏", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "加入收藏", exact: true }).first()).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "取消收藏", exact: true }).first()).not.toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: /模型一/ })).toBeVisible();
  await page.getByRole("option", { name: /模型二/ }).click();
  expect(onChange).toHaveBeenCalledExactlyOnceWith(entry.instanceId, "two");
});
