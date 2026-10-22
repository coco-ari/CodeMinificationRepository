import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { Command, CommandItem, CommandList } from "./command";

it("preserves the native command listbox's supplied accessible name", async () => {
  await using screen = await render(
    <Command>
      <CommandList aria-label="文件与文件夹">
        <CommandItem value="frontend/App.tsx">App.tsx</CommandItem>
      </CommandList>
    </Command>,
  );
  await expect.element(screen.getByRole("listbox", { name: "文件与文件夹" })).toBeVisible();
  await expect.element(screen.getByRole("option", { name: "App.tsx" })).toBeVisible();
});
