import {describe,expect,it} from 'vite-plus/test';
import * as Effect from 'effect/Effect';
import {responseError} from './http.ts';

describe('AutoOps HTTP failures',()=>{
  it('preserves a real Effect 4 wrapped authorization denial as 404',async()=>{
    const response=await Effect.runPromise(Effect.try(()=>{throw Object.assign(new Error('会话不存在或无权访问'),{status:404,code:'THREAD_NOT_FOUND'})}).pipe(Effect.catch(error=>Effect.succeed(responseError(error)))));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({_tag:'Uint8Array'});
  });
  it('returns a generic 500 for unexpected failures and primitive wrapped values',()=>{
    expect(responseError(new Error('private diagnostic')).status).toBe(500);
    expect(responseError({_tag:'UnknownError',cause:null}).status).toBe(500);
    expect(responseError(undefined).status).toBe(500);
  });
});
