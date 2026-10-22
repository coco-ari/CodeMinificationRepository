// AutoOps business adapter. Conversation/requests stay in the upstream runtime.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";
import * as ServerConfig from "../../../config.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_048_576));
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const shared = {
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [Invocation.McpInvocationContext, Threads.ThreadManagementService, ServerConfig.ServerConfig, FileSystem.FileSystem],
};
const list = Tool.make("list_project_materials", {
  ...shared, description: "列出当前固定项目的授权资料与当前会话历史中可用的附件。",
    parameters: Tool.EmptyParams,
}).annotate(Tool.Title, "列出项目资料").annotate(Tool.Readonly, true);
const read = Tool.make("read_project_document", {
  ...shared, description: "按授权资料 ID 读取当前项目文档，返回可点击的来源链接。",
  parameters: Schema.Struct({ id }),
}).annotate(Tool.Title, "读取项目资料").annotate(Tool.Readonly, true);
const material = Tool.make("read_project_material", {
  ...shared, description: "读取 @ 引用的授权业务资料或列出资料文件夹。path 必须是 picker 返回的完整 autoops/ 资料身份，包含版本及来源会话；不接受宿主文件路径。",
  parameters: Schema.Struct({ path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) }),
}).annotate(Tool.Title, "读取引用资料").annotate(Tool.Readonly, true);
const attachment = Tool.make("read_attachment", {
  ...shared, description: "按附件 ID 读取当前会话历史边界内的文件；不接受本机路径。图片通过原生视觉输入处理。",
  parameters: Schema.Struct({ id }),
}).annotate(Tool.Title, "读取附件").annotate(Tool.Readonly, true);
const environment = Tool.make("query_environment", {
  ...shared, description: "查询会话固定环境的只读快照，必须说明来源和采集时间。",
  parameters: Schema.Struct({ environmentId: id }),
}).annotate(Tool.Title, "查询环境").annotate(Tool.Readonly, true);
const ask = Tool.make("ask_user", {
  ...shared, description: "缺少业务条件时，通过运行器的原生 MCP 表单向用户提问并等待回答。",
  parameters: Schema.Struct({ prompt: text, options: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(6))) }),
}).annotate(Tool.Title, "等待补充信息").annotate(Tool.Readonly, true);
const report = Tool.make("create_report", {
  ...shared, description: "保存报告到当前会话，返回授权预览/下载链接；项目共享会话的报告进入项目产物。不会写入用户电脑或执行外部业务变更。",
  parameters: Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)), mime: Schema.Literals(["text/markdown", "text/plain", "text/csv", "application/json", "application/pdf"]), content: text }),
}).annotate(Tool.Title, "生成报告").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false);

export const AutoOpsToolkit = Toolkit.make(list, read, material, attachment, environment, ask, report);
