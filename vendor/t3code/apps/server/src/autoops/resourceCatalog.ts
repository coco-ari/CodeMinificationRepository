import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { configuredBusinessResourceCatalog } from "../../../../../../agent-demo/t3-adapters/resources.mjs";
import { AutoOpsAccessError } from "../../../../../../agent-demo/t3-adapters/access.mjs";

// 原生附件路径只在宿主适配边界解析，业务资料目录只接收读取端口。
export function configuredHostResourceCatalog(host?: { attachmentsDir: string; readFile: (path: string) => Promise<Uint8Array> }) {
  return configuredBusinessResourceCatalog({
    readAttachment: async (attachmentId: string) => {
      if (!host) throw new AutoOpsAccessError(503, "ATTACHMENT_READER_UNAVAILABLE", "附件读取暂时不可用");
      const path = resolveAttachmentPathById({ attachmentsDir: host.attachmentsDir, attachmentId });
      if (!path) throw new AutoOpsAccessError(404, "RESOURCE_NOT_FOUND", "资料不存在或无权访问");
      try { return await host.readFile(path); }
      catch { throw new AutoOpsAccessError(503, "ATTACHMENT_READ_FAILED", "附件暂时无法读取，请稍后重试"); }
    },
  });
}
