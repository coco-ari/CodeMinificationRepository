import type { ComponentProps } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRightPanelStore } from "~/rightPanelStore";
import { ContextChip } from "~/components/ContextChip";
import { FileTagChipContent } from "~/components/chat/FileTagChip";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readAutoOpsHost } from "./hostConfig";
import { workspaceRelativePath } from "./pathCompletion";
import {
  autoOpsResourceAttachmentId,
  autoOpsResourceUrl,
  loadAutoOpsResourceMetadata,
} from "./resources";

export async function openAutoOpsResource(
  sourceUrl: string,
  threadRef: ScopedThreadRef,
): Promise<void> {
  const url = autoOpsResourceUrl(sourceUrl);
  if (!url) return;
  const resource = new URL(url, window.location.origin);
  const resourcePath = resource.searchParams.get("path");
  // 工作区文件使用业务路径定位；skill包的相对路径交给原生附件查看器。
  if (
    resource.pathname === `${readAutoOpsHost()?.gatewayBasePath}/autoops/resources` &&
    resourcePath
  ) {
    useRightPanelStore.getState().openFile(threadRef, resourcePath);
    return;
  }
  try {
    const file = await loadAutoOpsResourceMetadata(url);
    useRightPanelStore.getState().openAttachment(threadRef, {
      type: "file",
      id: autoOpsResourceAttachmentId(url),
      name: file.name,
      mimeType: file.mime,
      sizeBytes: file.size,
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "无法打开文件",
      description: error instanceof Error ? error.message : "请稍后重试",
    });
  }
}

/** 业务资源沿用原生文件标签；点击时继续由服务端校验读取权限。 */
export function AutoOpsResourceLink({
  sourceUrl,
  threadRef,
  label,
  copyMarkdown,
  children,
  className,
  ...props
}: ComponentProps<"a"> & {
  sourceUrl: string;
  threadRef?: ScopedThreadRef;
  label: string;
  copyMarkdown: string;
}) {
  const url = autoOpsResourceUrl(sourceUrl);
  const theme = useRenderedAppearance();
  if (!url) {
    return (
      <a {...props} className={className} href={sourceUrl}>
        {children}
      </a>
    );
  }
  // 固定路径和原始链接名称已足够呈现标签，不在时间线重挂载时请求元数据。
  const path = new URL(url, readAutoOpsHost()?.httpBaseUrl).searchParams.get("path");
  const name = path?.split("/").at(-1) || label || "文件";
  const displayPath =
    path?.split("/")[2] === "current-input-files"
      ? workspaceRelativePath(path, {
          projectId: path.split("/")[1]!,
          workspaceType: "internal",
        }) ?? name
      : path;
  const normalizedLabel = label.trim().replace(/^\.\//, "");
  const labelIsPath =
    !!path &&
    (normalizedLabel === name || normalizedLabel === path || path.endsWith(`/${normalizedLabel}`));
  const description = path && label && !labelIsPath ? children : null;
  const chip = (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            render={
              <a
                {...props}
                href={url}
                onClick={(event) => {
                  props.onClick?.(event);
                  if (
                    !threadRef ||
                    event.defaultPrevented ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.altKey ||
                    event.shiftKey
                  )
                    return;
                  event.preventDefault();
                  void openAutoOpsResource(url, threadRef);
                }}
              />
            }
            className={cn("chat-markdown-file-link", className)}
            data-markdown-copy={copyMarkdown}
          >
            <FileTagChipContent path={path ?? name} label={name} theme={theme} />
          </ContextChip>
        }
      />
      <TooltipPopup side="top" variant="code">
        {(displayPath ?? label) || "文件"}
      </TooltipPopup>
    </Tooltip>
  );
  return description ? (
    <span data-markdown-copy={copyMarkdown}>
      {description} {chip}
    </span>
  ) : (
    chip
  );
}
