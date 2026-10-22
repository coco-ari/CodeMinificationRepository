import {
  formatFilePathForClipboard,
  type MediaActionId,
} from "@t3tools/client-runtime/media-actions";
import {
  mediaReferenceFileName,
  type MediaReference,
} from "@t3tools/client-runtime/media-reference";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  type AssetResource,
  type ContextMenuItem,
  type EnvironmentId,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, type ReactElement } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, readPreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { downloadMedia, readMediaPng } from "./mediaContent";

export interface MediaActionSource {
  readonly kind: "image" | "video";
  readonly name: string;
  readonly src: string | null;
  readonly reference?: MediaReference;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
  readonly onOpenFile?: () => void;
}

function mediaFileName(source: MediaActionSource): string {
  return (
    (source.reference && mediaReferenceFileName(source.reference)) || source.name || source.kind
  );
}

function allowsHostMedia(session: SessionGrantInput | null) {
  return session === null || sessionGrantsScope(session, AuthFilesystemReadScope);
}

function canReadHostMedia(environmentId: EnvironmentId | null): boolean {
  if (environmentId === null) return true;
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return result._tag !== "Failure" && allowsHostMedia(Option.getOrNull(AsyncResult.value(result)));
}

export function useMediaActions(source: MediaActionSource) {
  const hostEnvironmentId =
    source.asset &&
    (source.asset.resource._tag === "workspace-file" || source.asset.resource._tag === "media-file")
      ? source.asset.environmentId
      : null;
  const fileSession = useEnvironmentQuery(
    hostEnvironmentId === null ? null : environmentSession.sessionStateAtom(hostEnvironmentId),
  );
  const canReadMedia =
    hostEnvironmentId === null ||
    (fileSession.error === null && fileSession.data !== null && allowsHostMedia(fileSession.data));
  const assertCanReadMedia = () => {
    if (!canReadHostMedia(hostEnvironmentId)) {
      throw new Error("此连接无权读取主机文件。");
    }
  };
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const actionUrl = async () => {
    assertCanReadMedia();
    if (!source.asset) {
      if (!source.src) throw new Error("媒体不可用，请重新打开预览。");
      return source.src;
    }
    const { environmentId, resource } = source.asset;
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("请重新连接此环境后重试。");
    const result = await createAssetUrl({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    assertCanReadMedia();
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("环境返回了无效的媒体 URL。");
    return url;
  };
  const save = async () => {
    await downloadMedia(await actionUrl(), mediaFileName(source));
  };
  const copyImage = async () => {
    assertCanReadMedia();
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error(
        "无法复制图片。请使用安全的浏览器连接，或保存图片。",
      );
    }
    // Start the clipboard write in the user gesture; fetching/decoding may finish later.
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": actionUrl().then(readMediaPng) }),
    ]);
  };
  return { save, copyImage, canReadMedia, assertCanReadMedia };
}

export function MediaActions({
  source,
  children,
}: {
  source: MediaActionSource;
  children: ReactElement;
}) {
  const { save, copyImage, canReadMedia, assertCanReadMedia } = useMediaActions(source);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);
  const reference = source.reference;
  const tooltip = reference?.kind === "file" ? reference.path : (reference?.url ?? source.name);

  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    menuOpen.current = true;
    setTooltipOpen(false);
    let failureTitle = "无法打开媒体菜单";
    let progressToast: ReturnType<typeof toastManager.add> | undefined;
    const result = await settlePromise(async () => {
      const noun = source.kind === "image" ? "图片" : "视频";
      const unavailable = !canReadMedia || (source.src === null && source.asset === undefined);
      const canCopyImage =
        typeof navigator !== "undefined" &&
        Boolean(navigator.clipboard?.write) &&
        typeof ClipboardItem !== "undefined";
      const items: ContextMenuItem<MediaActionId>[] = [];
      if (reference?.kind === "file") {
        items.push({ id: "copy-full-path", label: "复制完整路径" });
        if (reference.relativePath)
          items.push({ id: "copy-relative-path", label: "复制相对路径" });
      } else if (reference?.kind === "url") {
        items.push({ id: "copy-url", label: "复制 URL" });
      }
      if (source.onOpenFile)
        items.push({ id: "open-file", label: "在文件查看器中打开", disabled: !canReadMedia });
      items.push({ id: "save", label: `保存${noun}`, disabled: unavailable });
      if (source.kind === "image") {
        items.push({
          id: "copy-image",
          label: "复制图片",
          disabled: unavailable || !canCopyImage,
        });
      }

      const action = await api.contextMenu.show(items, position);
      if (!action) return;
      failureTitle = `无法${items.find((item) => item.id === action)?.label ?? "完成媒体操作"}`;
      const text =
        action === "copy-full-path" && reference?.kind === "file"
          ? reference.path
          : action === "copy-relative-path" && reference?.kind === "file"
            ? reference.relativePath
            : action === "copy-url" && reference?.kind === "url"
              ? reference.url
              : undefined;
      if (text !== undefined) {
        const clipboardText =
          reference?.kind === "file" ? formatFilePathForClipboard(text, reference.path) : text;
        await writeTextToClipboard(clipboardText, reference?.kind === "file" ? "文件路径" : "URL");
        toastManager.add({
          type: "success",
          title: action === "copy-url" ? "已复制 URL" : "已复制路径",
        });
      } else if (action === "open-file") {
        assertCanReadMedia();
        source.onOpenFile?.();
      } else if (action === "save" || action === "copy-image") {
        progressToast = toastManager.add({
          type: "loading",
          title: action === "save" ? `正在准备下载${noun}…` : "正在复制图片…",
        });
        await (action === "save" ? save() : copyImage());
        toastManager.update(progressToast, {
          type: "success",
          title: action === "save" ? "已开始下载" : "已复制图片",
        });
      }
    });
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      const toast = stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "媒体操作失败。",
      });
      if (progressToast) toastManager.update(progressToast, toast);
      else toastManager.add(toast);
    }
    menuOpen.current = false;
  };

  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger
        render={children}
        tabIndex={0}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu(
            event.clientX === 0 && event.clientY === 0
              ? { x: bounds.left, y: bounds.bottom }
              : { x: event.clientX, y: event.clientY },
          );
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu({ x: bounds.left, y: bounds.bottom });
        }}
      />
      <TooltipPopup variant="code">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
