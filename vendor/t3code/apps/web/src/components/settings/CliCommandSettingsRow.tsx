import type { DesktopCliCommandState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CliCommandSettingsRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.cliCommand;
  const [state, setState] = useState<DesktopCliCommandState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const change = (action: "install" | "uninstall") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(setState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "install" ? "无法安装 t3" : "无法移除 t3",
            description: error instanceof Error ? error.message : "发生错误。",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? `以下位置的另一个 t3： ${state.shadowedBy} 会在新终端中优先执行。请将其移除，以使用 T3 Code 提供的版本。`
    : !installed
      ? "在任何终端中使用 `t3` 运行 T3 Code CLI。"
      : state.onPath
        ? `安装位置： ${state.installedPath}。打开新终端即可使用。`
        : `安装位置： ${state.installedPath}，该位置尚未加入 PATH。请将所在目录加入 PATH 后运行 \`t3\`。`;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => change(installed ? "uninstall" : "install")}
        >
          {installed ? "移除" : "安装"}
        </Button>
      }
    />
  );
}
