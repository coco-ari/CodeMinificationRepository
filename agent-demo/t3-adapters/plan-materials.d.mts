import type {OrchestrationV2ThreadProjection} from '../../vendor/t3code/packages/contracts/src/orchestrationV2.ts';
import type {AutoOpsAccess,AutoOpsPrincipal} from './access.mjs';
import type {createBusinessArtifactStore} from './business-tools.mjs';
export function saveAuthorizedPlan(input:{access:AutoOpsAccess;principal:AutoOpsPrincipal;input:{threadId:string;name:string;contents:string};projection:OrchestrationV2ThreadProjection;store:ReturnType<typeof createBusinessArtifactStore>}):ReturnType<ReturnType<typeof createBusinessArtifactStore>['create']>;
