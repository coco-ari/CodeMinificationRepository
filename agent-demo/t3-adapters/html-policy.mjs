// Keep the upstream renderer/bootstrap/iframe protocol. AutoOps has no host
// filesystem or arbitrary network capability, so browser CSP is the boundary.
export const AUTOOPS_HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; sandbox allow-scripts allow-downloads"
export function isolateBusinessHtml(html) {
  // First element wins: a document-provided <base>, CSP or script never gets
  // an opportunity to run before this restrictive policy. CSPs only intersect.
  return `<meta http-equiv="Content-Security-Policy" content="${AUTOOPS_HTML_CSP}">` + html
}
export const businessAppToolAllowed = (server, name) => server === 't3-code' && new Set(['list_project_materials', 'read_project_document', 'read_project_material', 'read_attachment', 'query_environment', 'read_environment']).has(name)
export const businessAppResourceAllowed = (server, uri) => server === 't3-code' && /^ui:\/\/autoops\/[a-z0-9._/-]+$/i.test(uri) && !uri.split('/').includes('..')
