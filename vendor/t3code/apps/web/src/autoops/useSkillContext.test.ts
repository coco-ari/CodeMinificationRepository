import { describe, expect, it } from "vite-plus/test";
import { autoOpsSkillContextRequestKey } from "./useSkillContext";
import type { AutoOpsThreadScope } from "./hostConfig";
const scope: AutoOpsThreadScope = {
  projectId: "p-one",
  agentId: "a-project",
  environmentId: "env-test",
  visibility: "private",
  workspaceType: "external",
  workspaceVersionId: "v-one",
};
describe("platform skill catalogue binding", () => {
  it("uses the complete draft scope and the fixed thread identity once locked", () => {
    const draft = new URL(
      autoOpsSkillContextRequestKey("/gateway", "draft-one", scope)!,
      "https://test.invalid",
    );
    expect(Object.fromEntries(draft.searchParams)).toEqual({
      projectId: "p-one",
      agentId: "a-project",
      environmentId: "env-test",
      workspaceType: "external",
      workspaceVersionId: "v-one",
    });
    for (const locked of [{ scopeLocked: true }, { scopeState: "locked" as const }]) {
      const url = new URL(
        autoOpsSkillContextRequestKey("/gateway", "thread-one", { ...scope, ...locked })!,
        "https://test.invalid",
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({ threadId: "thread-one" });
    }
  });
  it("草稿按实际助手读取，旧预设空清单不会缩小继承范围", () => {
    const question = { assistantId: 'actual-assistant', presetRevision: 1, configuration: { skillIds: [] } } as unknown as NonNullable<AutoOpsThreadScope['question']>;
    const draft = new URL(autoOpsSkillContextRequestKey('/gateway', 'draft-one', { ...scope, question })!, 'https://test.invalid');
    expect(draft.searchParams.get('assistantId')).toBe('actual-assistant');
    expect(draft.searchParams.has('skillIds')).toBe(false);
  });
  it("does not request platform skills for any customer target or incomplete scope", () => {
    const remote = {
      ...scope,
      executionBinding: {
        kind: "customer" as const,
        deviceId: "device",
        registeredWorkspaceId: "workspace",
        workspaceBindingRevision: 1,
        runtimeId: "codex" as const,
      },
    };
    expect(autoOpsSkillContextRequestKey("/gateway", "draft-one", remote)).toBeNull();
    expect(
      autoOpsSkillContextRequestKey("/gateway", "thread-one", { ...remote, scopeLocked: true }),
    ).toBeNull();
    expect(autoOpsSkillContextRequestKey("/gateway", null, scope)).toBeNull();
    expect(autoOpsSkillContextRequestKey(undefined, "draft-one", scope)).toBeNull();
  });
});
