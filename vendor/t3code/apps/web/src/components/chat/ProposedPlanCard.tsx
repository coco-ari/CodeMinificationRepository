import { autoOpsFeature } from "~/autoops/capabilities";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { memo, useState, useId } from "react";
import { findRevealRef } from "./markdownFindContext";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import {readAutoOpsHost} from '~/autoops/hostConfig';
import {useAutoOpsThreadScope} from '~/autoops/useThreadScope';
import {saveAutoOpsPlan} from '~/autoops/planMaterials';

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  findActive = false,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  findActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const nativeCanWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const businessHost = readAutoOpsHost();
  const businessScope = useAutoOpsThreadScope(threadRef?.threadId ?? '');
  const businessSave = !!businessHost;
  const canWriteFiles = autoOpsFeature("planMode") && (businessSave
    ? !!threadRef && !!businessScope && !businessScope.compatibilityReadOnly && !businessScope.nativeParentThreadId
    : nativeCanWriteFiles);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  // The path last submitted, so reopening the dialog offers it again.
  const [lastSavePath, setLastSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "无法复制计划",
          description: error instanceof Error ? error.message : "复制时发生错误。",
        }),
      );
    },
  });
  const title = proposedPlanTitle(planMarkdown) ?? "建议计划";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const isCollapsed = canCollapse && !expanded;
  // While finding, the full plan stays mounted but clipped, so a match past the
  // preview can be counted and then opened only once it is selected.
  const showPreview = isCollapsed && !findActive;
  const revealRef = findRevealRef(() => setExpanded(true));
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!canWriteFiles) return;
    if (!businessSave && !workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "工作区路径不可用",
          description: "此对话没有可用于保存的工作区路径。",
        }),
      );
      return;
    }
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = (savePath: string) => {
    const relativePath = savePath.trim();
    if (!canWriteFiles || (!businessSave && (!workspaceRoot || !readEnvironmentScope(environmentId, AuthFilesystemWriteScope)))) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "请输入工作区路径",
      });
      return;
    }

    setLastSavePath(savePath);
    setIsSavingToWorkspace(true);
    void (async () => {
      if (businessSave && threadRef) {
        try {
          const result=await saveAutoOpsPlan(threadRef.threadId,relativePath,saveContents);
          setIsSaveDialogOpen(false);
          toastManager.add({type:'success',title:'计划已保存为项目资料',description:result.name});
        } catch(error) {
          toastManager.add({type:'error',title:'计划保存失败',description:error instanceof Error?error.message:'请重试'});
        } finally {setIsSavingToWorkspace(false)}
        return;
      }
      if (!workspaceRoot) {setIsSavingToWorkspace(false);return}
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "计划已保存到工作区",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "无法保存计划",
            description: error instanceof Error ? error.message : "保存时发生错误。",
          }),
        );
      }
    })();
  };

  return (
    <div className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">计划</Badge>
          {}
          <h3 data-thread-find-text="true" className="truncate text-sm font-medium text-foreground">
            {title}
          </h3>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="计划操作" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "已复制！" : "复制到剪贴板"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>下载为 Markdown</MenuItem>
            {autoOpsFeature("planMode") && <MenuItem
              onClick={openSaveDialog}
              disabled={!canWriteFiles || (!businessSave && !workspaceRoot) || isSavingToWorkspace}
            >
              {businessSave ? '保存为项目资料' : "保存到工作区"}
            </MenuItem>}
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")}
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
        >
          {showPreview ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          )}
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起计划" : "展开计划"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={autoOpsFeature("planMode") && isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        {/* The form owns the path so a keystroke re-renders it, not the dialog chrome. */}
        <DialogPopup className="max-w-xl">
          <SavePlanToWorkspaceForm
            initialPath={lastSavePath || downloadFilename}
            placeholder={downloadFilename}
            workspaceRoot={workspaceRoot}
            businessSave={businessSave}
            canWriteFiles={canWriteFiles}
            saving={isSavingToWorkspace}
            onCancel={() => setIsSaveDialogOpen(false)}
            onSave={handleSaveToWorkspace}
          />
        </DialogPopup>
      </Dialog>
    </div>
  );
});

function SavePlanToWorkspaceForm({
  initialPath,
  placeholder,
  workspaceRoot,
  canWriteFiles,
  saving,
  onCancel,
  onSave,
  businessSave = false,
}: {
  initialPath: string;
  placeholder: string;
  workspaceRoot: string | undefined;
  canWriteFiles: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (path: string) => void;
  businessSave?: boolean;
}) {
  const [savePath, setSavePath] = useState(initialPath);
  const savePathInputId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>{businessSave ? '保存计划为项目资料' : "将计划保存到工作区"}</DialogTitle>
        <DialogDescription>
          {businessSave ? '输入 Markdown 文件名。资料沿用当前会话的项目和可见范围。' : <>请输入相对于此位置的路径： <code>{workspaceRoot ?? "工作区"}</code>.</>}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <label htmlFor={savePathInputId} className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">{businessSave ? '文件名' : "工作区路径"}</span>
          <Input
            id={savePathInputId}
            value={savePath}
            onChange={(event) => setSavePath(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            disabled={saving}
          />
        </label>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          
          取消
        </Button>
        <Button size="sm" onClick={() => onSave(savePath)} disabled={!canWriteFiles || saving}>
          {saving ? "正在保存…" : "保存"}
        </Button>
      </DialogFooter>
    </>
  );
}
