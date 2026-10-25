import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deploymentAgentFiles, verifyDeploymentAgentBundle } from './deployment-agent-bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'agent');
const files = deploymentAgentFiles(source);
await mkdir(path.join(root, 'dist'), { recursive: true });
// macOS 的扩展属性不能进入 Linux 安装包，避免生成 AppleDouble 文件和 PAX 警告。
const metadataOptions = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
await promisify(execFile)('tar', [...metadataOptions, '-czf', path.join(root, 'dist/agent-bundle.tar.gz'), '-C', source, '--', ...files.sort()], { windowsHide: true, env: { ...process.env, COPYFILE_DISABLE: '1' } });
verifyDeploymentAgentBundle(path.join(root, 'dist/agent-bundle.tar.gz'), source);
console.log(`Agent 安装包已生成，共 ${files.length} 个程序文件。`);
