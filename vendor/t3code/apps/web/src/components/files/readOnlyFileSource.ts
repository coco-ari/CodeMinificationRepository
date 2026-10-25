import { createContext, useContext, useEffect, useState } from "react";
import type { ProjectListEntriesResult } from "@t3tools/contracts";

export type ReadOnlyFileResource = {
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
} & ({ readonly url: string; readonly preview?: undefined } | {
  readonly preview: { readonly contents?: string | undefined; readonly binary: boolean; readonly truncated: boolean };
});

/** A business source supplies identities and reads, never a host filesystem path or mutation. */
export interface ReadOnlyFileSource {
  readonly id: string;
  readonly allowReferences: boolean;
  readonly allowExpandAll?: boolean;
  readonly directoryConcurrency?: number;
  readonly origin?: string;
  /** Package sources resolve relative Markdown links within their immutable file manifest. */
  readonly resolveLink?: (fromPath: string, href: string) =>
    { readonly path: string; readonly kind: "file" | "directory" } | { readonly error: string } | null;
  readonly list: (directoryPath: string, signal?: AbortSignal) => Promise<ProjectListEntriesResult>;
  readonly search: (query: string, limit: number, signal?: AbortSignal) => Promise<ProjectListEntriesResult>;
  readonly metadata: (path: string, signal?: AbortSignal) => Promise<ReadOnlyFileResource | { readonly kind: "directory" }>;
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
    const controller = new AbortController();
    void source.list(path, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ key, data, error: null }); },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ key, data: null, error: error instanceof Error ? error.message : "无法加载文件夹。" }); },
    );
    return () => controller.abort();
  }, [source, path, key]);
  const current = result?.key === key ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, isPending: !!source && current === null, refresh: () => setRevision((value) => value + 1) };
}
