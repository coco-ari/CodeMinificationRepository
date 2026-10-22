import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as Schema from "effect/Schema";
import { FolderTreeIcon, MessageSquarePlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading, FILE_SURFACE_SUBHEADER_CLASS } from "./fileSurfaceChrome";
import { retainedBreadcrumbTrail } from "./filePath";
import { ReadOnlyFileSourceContext, type ReadOnlyFileSource, type ReadOnlyFileResource } from "./readOnlyFileSource";

export interface ReadOnlyWorkspaceFilesProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly relativePath: string | null;
  readonly source: ReadOnlyFileSource;
  readonly knownDirectory?: boolean | undefined;
  readonly threadRef?: ScopedThreadRef;
  readonly revealRequestId?: number;
  readonly folderTrail?: string | undefined;
  readonly onOpenFile: (path: string) => void;
  readonly onNavigateFolder: (path: string, trail: string, keepSource: boolean) => void;
}

/** The T3 file surfaces with only scoped reads; no editor, write command or host-file action mounts. */
export function ReadOnlyWorkspaceFiles(props: ReadOnlyWorkspaceFilesProps) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; resource?: ReadOnlyFileResource | { kind: "directory" }; error?: string } | null>(null);
  const key = `${props.source.id}:${props.relativePath ?? ""}:${revision}`;
  const narrow = useMediaQuery("max-md");
  const composer = useComposerHandleContext();
  const [explorerOpen, setExplorerOpen] = useLocalStorage("t3code.fileExplorerOpen", true, Schema.Boolean);
  useEffect(() => {
    if (!props.relativePath || props.knownDirectory) return;
    let active = true;
    void props.source.metadata(props.relativePath).then(
      (resource) => { if (active) setResult({ key, resource }); },
      (error: unknown) => { if (active) setResult({ key, error: error instanceof Error ? error.message : "无法读取项目资料。" }); },
    );
    return () => { active = false; };
  }, [props.source, props.relativePath, props.knownDirectory, key]);
  const current = result?.key === key ? result : null;
  const folder = !props.relativePath || props.knownDirectory || current?.resource?.kind === "directory";
  const resource = current?.resource?.kind === "file" ? current.resource : null;
  const previewPath = folder ? null : props.relativePath;
  const showExplorer = folder || (!narrow && explorerOpen);
  const navigate = (path: string) => props.onNavigateFolder(path, retainedBreadcrumbTrail(props.folderTrail, path), !folder);
  const breadcrumbs = <ScrollArea radius="none" hideScrollbars scrollFade className="min-w-0 flex-1" data-file-breadcrumbs>
    <div className="flex h-full w-max min-w-full items-center text-xs"><FileBreadcrumbs
      cwd={props.cwd} environmentId={props.environmentId} projectName={props.projectName}
      relativePath={props.relativePath ?? ""} trail={retainedBreadcrumbTrail(props.folderTrail, props.relativePath ?? "")}
      onNavigateFolder={navigate} onOpenFile={props.onOpenFile} workspaceMutationId={null}
    /></div>
  </ScrollArea>;
  const explorerAction = previewPath ? <FileSurfaceAction
    label={narrow ? "返回文件目录" : explorerOpen ? "隐藏文件浏览器" : "显示文件浏览器"}
    pressed={!narrow && explorerOpen}
    onPress={() => narrow ? navigate("") : setExplorerOpen(!explorerOpen)}
  ><FolderTreeIcon className="size-3.5" /></FileSurfaceAction> : null;
  const addToChat = previewPath && resource && props.source.allowReferences ? <FileSurfaceAction label="添加到对话" onPress={() => {
    const mention = serializeComposerFileLink(props.source.mentionPath(previewPath));
    const inserted = composer?.current?.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
    if (!inserted) toastManager.add({ type: "error", title: "无法添加到对话", description: "请打开此项目的对话后重试。" });
  }}><MessageSquarePlusIcon className="size-3.5" /></FileSurfaceAction> : null;
  const actions = <>{addToChat}{explorerAction}</>;
  return <ReadOnlyFileSourceContext.Provider value={props.source}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" data-readonly-workspace={props.source.id}>
      {folder || !resource ? <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>{breadcrumbs}{actions}</div> : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {previewPath ? <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {current?.error ? <FileSurfaceFailure message={current.error} onRetry={() => setRevision((value) => value + 1)} /> : resource ?
            <AttachmentFilePreview
              key={`${props.source.id}:${previewPath}:${revision}`} name={resource.name} mimeType={resource.mimeType} sizeBytes={resource.sizeBytes}
              resourceUrl={resource.url} header={breadcrumbs} toolbarEnd={actions} origin="项目资料"
              {...(props.threadRef ? { threadRef: props.threadRef } : {})}
            /> : <FileSurfaceLoading />}
        </div> : null}
        {showExplorer ? <aside className={cn("flex min-h-0 bg-background", previewPath ? "w-[min(22rem,46%)] min-w-52 shrink-0 border-l border-border/60" : "min-w-0 flex-1")}>
          <FileBrowserPanel key={props.source.id} environmentId={props.environmentId} cwd={props.cwd} projectName={props.projectName}
            selectedPath={props.relativePath} selectedPathRevealId={props.revealRequestId ?? 0} onOpenFile={props.onOpenFile}
            onRefreshSelectedFile={() => setRevision((value) => value + 1)} workspaceMutationId={null}
          />
        </aside> : null}
      </div>
    </div>
  </ReadOnlyFileSourceContext.Provider>;
}
