import { createContext, useContext, useEffect, useState } from "react";
import type { ProjectListEntriesResult } from "@t3tools/contracts";

export interface ReadOnlyFileResource {
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
}

/** A business source supplies identities and reads, never a host filesystem path or mutation. */
export interface ReadOnlyFileSource {
  readonly id: string;
  readonly allowReferences: boolean;
  readonly list: (directoryPath: string) => Promise<ProjectListEntriesResult>;
  readonly search: (query: string, limit: number) => Promise<ProjectListEntriesResult>;
  readonly metadata: (path: string) => Promise<ReadOnlyFileResource | { readonly kind: "directory" }>;
  readonly mentionPath: (path: string) => string;
}

export const ReadOnlyFileSourceContext = createContext<ReadOnlyFileSource | undefined>(undefined);
export const useReadOnlyFileSource = () => useContext(ReadOnlyFileSourceContext);

export function useReadOnlyDirectoryQuery(source: ReadOnlyFileSource | undefined, path: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; data: ProjectListEntriesResult | null; error: string | null } | null>(null);
  const key = source ? `${source.id}:${path}:${revision}` : null;
  useEffect(() => {
    if (!source || !key) return;
    let active = true;
    void source.list(path).then(
      (data) => { if (active) setResult({ key, data, error: null }); },
      (error: unknown) => { if (active) setResult({ key, data: null, error: error instanceof Error ? error.message : "无法加载文件夹。" }); },
    );
    return () => { active = false; };
  }, [source, path, key]);
  const current = result?.key === key ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, isPending: !!source && current === null, refresh: () => setRevision((value) => value + 1) };
}
