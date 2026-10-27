import type { Server } from 'node:net'
export function createSessionRelay(socketPath:string): {server:Server;close:()=>void}
