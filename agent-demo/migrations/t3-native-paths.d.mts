export function rebaseNativeRolloutPaths(options:{homeDirectory:string;finalHomeDirectory?:string;quiesced?:boolean}):Promise<{format:string;databases:{database:string;changed:number;threadIds:string[]}[];rollouts:number;finalHomeDirectory:string;sourceRolloutBytesChanged:boolean}>

export function assertNativeRolloutPaths(homeDirectory:string):{checked:number}
