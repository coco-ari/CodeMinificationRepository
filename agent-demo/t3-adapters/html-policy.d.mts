export const AUTOOPS_HTML_CSP: string;
export function isolateBusinessHtml(html: string): string;
export function businessAppToolAllowed(server: string, name: string): boolean;
export function businessAppResourceAllowed(server: string, uri: string): boolean;
