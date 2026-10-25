import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  customerFileReference,
  customerFilePathForTarget,
  type CustomerFileResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ContextChip } from "~/components/ContextChip";
import { FileTagChipContent } from "~/components/chat/FileTagChip";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  ReadOnlyFileSourceContext,
  type ReadOnlyFileSource,
} from "~/components/files/readOnlyFileSource";
import { FileSurfaceFailure, FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import { PaperclipIcon, FolderOpenIcon, UploadIcon } from "lucide-react";
import type { AutoOpsThreadScope } from "./hostConfig";
import { customerFilesKey, readCustomerFiles } from "./customerFiles";

const FileBrowserPanel = lazy(() => import("~/components/files/FileBrowserPanel"));
const SourcePreview = lazy(() => import("~/components/files/ReadOnlySourcePreview"));

export function CustomerFileAttachMenu(props: { onUpload: () => void; onBrowse: () => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="icon-sm" aria-label="添加文件" />}
      >
        <PaperclipIcon />
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuItem onClick={props.onUpload}>
          <UploadIcon />
          上传文件
        </MenuItem>
        <MenuItem onClick={props.onBrowse}>
          <FolderOpenIcon />
          引用电脑文件
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function CustomerFilePicker(props: {
  scope: AutoOpsThreadScope;
  threadId: string | null;
  environmentId: EnvironmentId;
  initialPath: string | null;
  onClose: () => void;
  onRestoreFocus?: () => void;
  onSelect?: (path: string) => void;
}) {
  const [selected, setSelected] = useState(props.initialPath);
  const [preview, setPreview] = useState<{
    path: string;
    value?: CustomerFileResult;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const target = props.scope.executionBinding;
  const source = useMemo<ReadOnlyFileSource>(
    () => ({
      id: customerFilesKey(props.scope)!,
      allowReferences: false,
      allowExpandAll: false,
      directoryConcurrency: 1,
      mentionPath: (path) =>
        target?.kind === "customer" ? customerFileReference(target, path) : path,
      list: (path, signal) =>
        readCustomerFiles(props.scope, props.threadId, { operation: "list", path }, signal),
      search: (query, _limit, signal) =>
        readCustomerFiles(props.scope, props.threadId, { operation: "search", query }, signal),
      metadata: async () => {
        throw new Error("请在文件列表中打开预览");
      },
    }),
    [props.scope, props.threadId],
  );
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setPreview(null);
    void readCustomerFiles(
      props.scope,
      props.threadId,
      { operation: "preview", path: selected },
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) setPreview({ path: selected, value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setPreview({
            path: selected,
            error: error instanceof Error ? error.message : "预览失败，请重试",
          });
      },
    );
    return () => controller.abort();
  }, [selected, attempt, source.id]);
  const current = preview?.path === selected ? preview : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        className="flex h-[80dvh] max-w-5xl flex-col overflow-hidden p-0"
        finalFocus={
          props.onRestoreFocus
            ? () => {
                props.onRestoreFocus?.();
                return document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : false;
              }
            : undefined
        }
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>电脑文件</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={
              selected ? "hidden min-w-0 flex-[2] border-r sm:flex" : "flex min-w-0 flex-1"
            }
          >
            <ReadOnlyFileSourceContext value={source}>
              <Suspense fallback={<FileSurfaceLoading />}>
                <FileBrowserPanel
                  environmentId={props.environmentId}
                  cwd={source.id}
                  projectName="电脑文件"
                  selectedPath={selected}
                  selectedPathRevealId={0}
                  onOpenFile={setSelected}
                  workspaceMutationId={null}
                />
              </Suspense>
            </ReadOnlyFileSourceContext>
          </div>
          {selected ? (
            <section className="flex min-h-0 min-w-0 flex-[3] flex-col" aria-label="文件预览">
              <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
                  返回列表
                </Button>
                <span className="truncate text-xs text-muted-foreground" title={selected}>
                  {selected}
                </span>
              </div>
              {current?.error ? (
                <FileSurfaceFailure
                  message={current.error}
                  onRetry={() => setAttempt((value) => value + 1)}
                />
              ) : !current?.value ? (
                <FileSurfaceLoading />
              ) : current.value.preview?.binary ? (
                <p className="p-4 text-sm text-muted-foreground">
                  此文件不支持文字预览，可以直接引用。
                </p>
              ) : (
                <Suspense fallback={<FileSurfaceLoading />}>
                  <SourcePreview name={selected} text={current.value.preview?.contents ?? ""} />
                </Suspense>
              )}
              {current?.value?.truncated ? (
                <p className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
                  仅预览文件开头，Agent 会读取本机原文件。
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3">
          <Button variant="outline" onClick={props.onClose}>
            取消
          </Button>
          {props.onSelect ? (
            <Button
              disabled={!selected || !current?.value || !!current.error}
              onClick={() => {
                if (selected && target?.kind === "customer")
                  props.onSelect?.(customerFileReference(target, selected));
              }}
            >
              引用文件
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CustomerFileLink(props: {
  scope: AutoOpsThreadScope;
  threadRef: ScopedThreadRef;
  path: string;
  copyMarkdown: string;
}) {
  const [open, setOpen] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  const theme = useRenderedAppearance();
  const target = props.scope.executionBinding;
  const path = target?.kind === "customer" ? customerFilePathForTarget(props.path, target) : null;
  if (!path) return <span>{props.path.split("/").at(-1)}</span>;
  return (
    <>
      <ContextChip
        kind="mention"
        data-markdown-copy={props.copyMarkdown}
        render={
          <button
            ref={previewButton}
            type="button"
            aria-label={`预览 ${path.split("/").at(-1)}`}
            onClick={() => setOpen(true)}
          />
        }
      >
        <FileTagChipContent path={path} label={path.split("/").at(-1)!} theme={theme} />
      </ContextChip>
      {open ? (
        <CustomerFilePicker
          scope={props.scope}
          threadId={props.threadRef.threadId}
          environmentId={props.threadRef.environmentId}
          initialPath={path}
          onClose={() => setOpen(false)}
          onRestoreFocus={() => previewButton.current?.focus()}
        />
      ) : null}
    </>
  );
}
