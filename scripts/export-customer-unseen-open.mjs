#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, fstatSync, fchmodSync, realpathSync, writeFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportUnseenOpenCommand, inspectUnseenOpenCommand } from '../agent-demo/t3-adapters/customer-transport.mjs';

/** 只读所属模块账本；文件只含公开固定范围和在内存计算的完整命令指纹。 */
export function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    execute: { type: 'boolean' }, inspect: { type: 'boolean' }, help: { type: 'boolean' }, database: { type: 'string' }, output: { type: 'string' },
    command: { type: 'string' }, session: { type: 'string' }, device: { type: 'string' }, provider: { type: 'string' }, thread: { type: 'string' }, grant: { type: 'string' }, fingerprint: { type: 'string' },
  } });
  if (!values.execute || values.help) {
    console.log('prepared：未读取数据库或写入文件。只读核对用 --execute --inspect --database 只读原库 --command 原命令ID --session 原会话ID --device 原设备ID --provider 原提供者ID --thread 原线程ID --grant 原授权ID；输出公开标识及完整命令SHA256。导出须去掉 --inspect 并补 --output 新0600文件 --fingerprint 刚核对的SHA256。');
    return;
  }
  for (const key of ['database', 'command', 'session', 'device', 'provider', 'thread', 'grant', ...(values.inspect ? [] : ['output', 'fingerprint'])]) if (!values[key]?.trim()) throw Error('EXPORT_ARGUMENTS_REQUIRED');
  if (values.inspect && (values.output || values.fingerprint)) throw Error('EXPORT_INSPECT_ARGUMENTS_INVALID');
  const database = resolve(values.database), output = values.output ? resolve(values.output) : undefined;
  if (realpathSync(database) !== database || (output && realpathSync(dirname(output)) !== dirname(output))) throw Error('EXPORT_CANONICAL_PATH_REQUIRED');
  const descriptor = openSync(database, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(descriptor).isFile()) throw Error('EXPORT_DATABASE_REGULAR_REQUIRED'); } finally { closeSync(descriptor); }
  const db = new DatabaseSync(database, { readOnly: true });
  let value;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    const identity = { commandId: values.command, sessionId: values.session, deviceId: values.device, providerId: values.provider, threadId: values.thread, grantId: values.grant };
    value = values.inspect ? inspectUnseenOpenCommand(db, identity) : exportUnseenOpenCommand(db, { ...identity, commandFingerprint: values.fingerprint });
  } finally { db.close(); }
  if (values.inspect) { console.log(JSON.stringify({ readOnly: true, ...value })); return; }
  const file = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let complete = false;
  try { if (process.platform !== 'win32') fchmodSync(file, 0o600); writeFileSync(file, JSON.stringify(value) + '\n'); fsyncSync(file); complete = true; }
  finally { closeSync(file); if (!complete) unlinkSync(output); }
  const parent = openSync(dirname(output), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  console.log(JSON.stringify({ exported: true, output, commandId: value.commandId, sessionId: value.sessionId, commandFingerprint: value.commandFingerprint }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('原命令公开事实导出失败；未修改业务账本，请核对原标识、只读数据库和新输出路径。'); process.exitCode = 1; }
}
