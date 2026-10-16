import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Docker } from '../agent/docker.mjs';
import { checkRuntimeBase } from '../agent/image-policy.mjs';

// 仅在开发机 Docker 中构造独立测试镜像，不启动业务容器，也不清理其他资源。
const docker = new Docker(), root = await mkdtemp(path.join(os.tmpdir(), 'cmr-image-policy-'));
const prefix = `cmr-image-policy-${Date.now()}`, images = [];
try {
  const base = await docker.inspect(process.env.CMR_TEST_RUNTIME_IMAGE || 'maven:3.9.9-eclipse-temurin-8', 'image');
  assert.ok(base, '请先准备测试用 Java 基础镜像');
  await checkRuntimeBase(docker, base);
  const baseRef = base.RepoDigests?.[0];
  assert.ok(baseRef, '测试基础镜像需要仓库摘要');
  for (const version of ['first', 'second']) {
    const tag = `${prefix}:${version}`; images.push(tag);
    await writeFile(path.join(root, 'app.jar'), Buffer.alloc(1024, version === 'first' ? 1 : 2));
    await writeFile(path.join(root, 'Dockerfile'), `FROM ${baseRef}\nCOPY app.jar /app/app.jar\nENTRYPOINT ["java", "-jar", "/app/app.jar"]\n`);
    await docker.run(['build', '-t', tag, root]);
    const built = await docker.inspect(tag, 'image');
    assert.deepEqual(built.RootFS.Layers.slice(0, -1), base.RootFS.Layers);
    const history = await docker.run(['history', '--no-trunc', '--format', '{{json .}}', built.Id]);
    assert.equal(history.output.trim().split('\n').map(line => JSON.parse(line)).filter(row => /COPY.*app\.jar/.test(row.CreatedBy)).length, 1);
    await assert.rejects(checkRuntimeBase(docker, built), /禁止在旧业务镜像/);
  }
  // 清除启动入口并更换名字后，仍必须根据真实历史层识别旧业务程序。
  const disguised = `${prefix}:disguised`; images.push(disguised);
  await writeFile(path.join(root, 'Dockerfile'), `FROM ${prefix}:first\nENTRYPOINT ["java"]\nCMD ["-version"]\n`);
  await docker.run(['build', '-t', disguised, root]);
  const dirty = await docker.inspect(disguised, 'image');
  await assert.rejects(checkRuntimeBase(docker, dirty), /禁止在旧业务镜像/);
  await assert.rejects(checkRuntimeBase(docker, await docker.inspect(dirty.Id, 'image')), /禁止在旧业务镜像/);
  console.log('通过：两次构建均只有一个业务 JAR 层，旧业务基础镜像及改名／摘要引用均被拒绝。');
} finally {
  for (const image of images.reverse()) await docker.run(['image', 'rm', image], { allowFailure: true });
  await rm(root, { recursive: true, force: true });
}
