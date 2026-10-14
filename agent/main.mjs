import { AgentRunner } from './runner.mjs';

const runner = new AgentRunner({ root: process.env.CMR_AGENT_DIR || '/opt/cmr-agent', centerUrl: process.env.CMR_CENTER_URL,
  registrationToken: process.env.CMR_REGISTRATION_TOKEN, registrationTokenFile: process.env.CMR_REGISTRATION_TOKEN_FILE,
  allowHttpTest: process.env.CMR_ALLOW_HTTP_TEST === '1', procRoot: process.env.CMR_HOST_PROC || '/host/proc' });
process.on('SIGTERM', () => runner.stop());
process.on('SIGINT', () => runner.stop());
runner.run().catch(error => { console.error(`Agent 启动失败：${error.message}`); process.exitCode = 1; });
