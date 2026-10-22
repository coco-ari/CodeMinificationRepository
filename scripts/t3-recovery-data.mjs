import {createT3RecoveryBundle,verifyT3RecoveryBundle,restoreT3ReadOnlyBundle,compareT3RecoveryBundles,inspectT3RecoveryBundle} from '../agent-demo/migrations/t3-recovery.mjs'
const [command,...args]=process.argv.slice(2)
const usage='snapshot DATA DEST --quiesced [--native-dir PATH] | inspect SNAPSHOT | verify SNAPSHOT | restore-readonly SNAPSHOT NEW_DEST | compare BASELINE CURRENT'
try{
 let result
 if(command==='snapshot'&&args.length>=3){const [dataDirectory,destination,...options]=args;let quiesced=false,nativeDirectory;for(let i=0;i<options.length;i++){if(options[i]==='--quiesced')quiesced=true;else if(options[i]==='--native-dir'&&options[i+1])nativeDirectory=options[++i];else throw Error(usage)}const m=await createT3RecoveryBundle({dataDirectory,destination,quiesced,nativeDirectory});result={snapshot:destination,canonical:m.canonical,files:m.files.length,nativeHeads:m.nativeHeads.map(({sessionId,sha256,lineCount})=>({sessionId,sha256,lineCount})),policy:m.policy}}
 else if(command==='inspect'&&args.length===1)result=await inspectT3RecoveryBundle(args[0])
 else if(command==='verify'&&args.length===1){const m=await verifyT3RecoveryBundle(args[0]);result={verified:true,canonical:m.canonical,files:m.files.length,nativeHeads:m.nativeHeads.length}}
 else if(command==='restore-readonly'&&args.length===2)result=await restoreT3ReadOnlyBundle({snapshot:args[0],destination:args[1]})
 else if(command==='compare'&&args.length===2)result=await compareT3RecoveryBundles(...args)
 else throw Error(usage)
 console.log(JSON.stringify(result))
}catch(error){console.error(error.message);process.exitCode=1}
