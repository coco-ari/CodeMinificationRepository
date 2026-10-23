import { HttpServerResponse } from 'effect/http'

const safeMimes = new Set(["text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/pdf", "image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif"]);
export const resourceHeaders = (url: URL, name: string, mime: string) => ({
  "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": mime === 'text/html' ? "default-src 'none'; sandbox; style-src 'unsafe-inline'; img-src data:; font-src data:" : "default-src 'none'; sandbox",
  "content-type": safeMimes.has(mime) ? mime : "application/octet-stream",
  "content-disposition": `${url.searchParams.get("inline") === "1" && safeMimes.has(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
});
export const resourceMetadata = (url: URL, file: {id:string;name:string;mime:string;size:number}) => {
  const source = new URL(url); source.searchParams.delete('metadata'); source.searchParams.delete('inline');
  return HttpServerResponse.jsonUnsafe({ ...file, sourceUrl: `/api/agent-demo/t3${source.pathname}${source.search}` }, { headers: { "cache-control": "no-store" } });
};

export const responseError = (error: unknown) => {
  const wrapped = error as { cause?: unknown; _tag?: string };
  const inner = wrapped?._tag === "UnknownError" || wrapped?._tag === "UnknownException" ? wrapped.cause : error;
  const known = (typeof inner === "object" && inner !== null ? inner : {}) as { status?: number; code?: string; message?: string; _tag?: string };
  const status = known.status ?? (known._tag === "ServerAuthInvalidCredentialError" || known._tag === "ServerAuthMissingCredentialError" ? 401 : 500);
  return HttpServerResponse.jsonUnsafe({
    error: known.status ? known.message : status === 401 ? "请先登录" : "AutoOps 请求未完成",
    code: known.code ?? "AUTOOPS_REQUEST_FAILED",
  }, { status, headers: { "cache-control": "no-store" } });
};

