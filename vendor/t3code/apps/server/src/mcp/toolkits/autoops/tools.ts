// 会话与请求仍由 T3 管理；每次业务调用必须携带本轮固定资料身份。
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";
import * as ServerConfig from "../../../config.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { environmentMcpOperation } from "../../../autoops/environmentMcpSchema.ts";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_048_576));
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const shared = {
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [Invocation.McpInvocationContext, Threads.ThreadManagementService, ServerConfig.ServerConfig, FileSystem.FileSystem],
};
const list = Tool.make("list_project_materials", {
  ...shared, description: "列出本轮固定输入的授权项目资料与当前会话历史中可用的附件。",
    parameters: Schema.Struct({ inputId: id }),
}).annotate(Tool.Title, "列出项目资料").annotate(Tool.Readonly, true);
const read = Tool.make("read_project_document", {
  ...shared, description: "按授权资料 ID 读取当前项目文档，返回可点击的来源链接。",
  parameters: Schema.Struct({ inputId: id, id }),
}).annotate(Tool.Title, "读取项目资料").annotate(Tool.Readonly, true);
const material = Tool.make("read_project_material", {
  ...shared, description: "读取 @ 引用的授权业务资料或列出资料文件夹。path 必须是 picker 返回的完整 autoops/ 资料身份，包含版本及来源会话；也支持授权上下文列出的 autoops/skills/ 技能包参考资料身份；不接受宿主文件路径，不执行脚本。",
  parameters: Schema.Struct({ inputId: id, path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)) }),
}).annotate(Tool.Title, "读取引用资料").annotate(Tool.Readonly, true);
const attachment = Tool.make("read_attachment", {
  ...shared, description: "按附件 ID 读取当前会话历史边界内的文件；不接受本机路径。图片通过原生视觉输入处理。",
  parameters: Schema.Struct({ inputId: id, id }),
}).annotate(Tool.Title, "读取附件").annotate(Tool.Readonly, true);
const environment = Tool.make("query_environment", {
  ...shared, description: "列出本轮固定环境中实际已启用且通过测试的只读连接及允许操作。没有连接时明确报告未配置，不返回演示数据。",
  parameters: Schema.Struct({ inputId: id }),
}).annotate(Tool.Title, "查询环境").annotate(Tool.Readonly, true);
const environmentRead = Tool.make("read_environment", {
  ...shared, description: "按 query_environment 返回的连接和操作读取本轮固定环境；仅支持明确列出的只读操作，返回真实来源和采集时间。不能指定其他项目、环境、执行身份或任意命令。",
  parameters: Schema.Struct({ inputId: id, operation: environmentMcpOperation }),
}).annotate(Tool.Title, "读取环境").annotate(Tool.Readonly, true);
const ask = Tool.make("ask_user", {
  ...shared, description: "缺少业务条件时，通过运行器的原生 MCP 表单向用户提问并等待回答。",
  parameters: Schema.Struct({ inputId: id, prompt: text, options: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(6))) }),
}).annotate(Tool.Title, "等待补充信息").annotate(Tool.Readonly, true);
const report = Tool.make("create_report", {
  ...shared, description: "保存报告到当前会话，返回授权预览/下载链接；项目共享会话的报告进入项目产物。不会写入用户电脑或执行外部业务变更。",
  parameters: Schema.Struct({ inputId: id, name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)), mime: Schema.Literals(["text/markdown", "text/plain", "text/csv", "application/json", "application/pdf"]), content: text }),
}).annotate(Tool.Title, "生成报告").annotate(Tool.Readonly, false).annotate(Tool.Destructive, false);

export const AutoOpsToolkit = Toolkit.make(list, read, material, attachment, environment, environmentRead, ask, report);
