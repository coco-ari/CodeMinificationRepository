// 业务镜像不能再次作为运行基础镜像，否则被覆盖的旧 JAR 仍会保留在下层。
export function assertRuntimeBase(image, history = []) {
  const config = image.Config || {}, labels = config.Labels || {};
  const command = [config.Entrypoint, config.Cmd].flat().filter(Boolean).join(' ');
  const application = labels['io.cmr.managed'] === 'true' || labels['io.cmr.target'] || labels['io.cmr.task']
    || /(?:^|[\s"'])-jar(?:[\s"']|$)|\/app\/app\.jar\b/i.test(command)
    || history.some(row => /\b(?:COPY|ADD)\b.*(?:\bapp\.jar\b|\/app\/app\.jar\b)/i.test(row.CreatedBy));
  if (application) throw new Error('运行基础镜像包含业务程序，禁止在旧业务镜像上叠加 JAR。请使用独立的 JRE 基础镜像，例如 eclipse-temurin:8-jre；历史版本应通过回退恢复。');
}

export async function checkRuntimeBase(docker, image) {
  assertRuntimeBase(image);
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id || '')) throw new Error('无法确认运行基础镜像的固定 ID');
  const result = await docker.run(['history', '--no-trunc', '--format', '{{json .}}', image.Id], { timeoutMs: 30000 });
  let history;
  try {
    if (!result.output.trim() || result.output.length >= 2 * 1024 * 1024) throw new Error();
    history = result.output.trim().split('\n').map(line => JSON.parse(line));
    if (history.some(row => typeof row?.CreatedBy !== 'string')) throw new Error();
  } catch { throw new Error('无法完整核验运行基础镜像历史，停止构建'); }
  assertRuntimeBase(image, history);
}
