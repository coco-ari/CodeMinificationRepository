export const deployPages = {
  servers: ['服务器', '一个入口，查看每台服务器的连接与运行状态。'],
  applications: ['业务项目', '组织项目、环境和服务，复用每一次交付的配置。'],
  deployments: ['部署目标', '查看服务运行版本，在独立环境验证自动发布。'],
  tasks: ['发布记录', '从源码到运行，跟踪每次发布的进度与结果。'],
};

const taskNames = { preparing: '准备源码', queued: '排队中', running: '执行中', succeeded: '发布成功',
  success: '发布成功', failed: '执行失败', rolled_back: '发布失败 · 已回退', cancelled: '已取消', interrupted: '已中断' };
const actionNames = { deploy: '发布', restart: '重启', rollback: '回退' };
const resultName = task => ['succeeded', 'success'].includes(task.status) ? `${actionNames[task.action] || '执行'}成功` : taskNames[task.status] || task.status;
const revisionOf = task => task.revision || task.result?.release?.revision || task.release?.revision || task.previousRelease?.revision;
const stageNames = { prepare: '准备源码', preparing: '准备源码', queued: '等待执行', download: '下载源码',
  build: '编译打包', image: '构建镜像', deploy: '更新容器', health: '健康检查', rollback: '恢复版本',
  downloading: '下载源码', building: '编译打包', deploying: '更新容器', verifying: '健康检查',
  succeeded: '完成', interrupted: '已中断', rolled_back: '已回退', restart: '重启服务', done: '完成', completed: '完成', failed: '失败' };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未上报';
const short = value => value ? String(value).slice(0, 12) : '—';
const finished = task => ['succeeded', 'success', 'failed', 'rolled_back', 'cancelled', 'interrupted'].includes(task.status);
const duration = task => {
  const start = task.startedAt || task.createdAt;
  if (!start) return '—';
  const seconds = Math.max(0, Math.floor(((task.finishedAt ? new Date(task.finishedAt) : Date.now()) - new Date(start)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
const size = bytes => bytes !== null && bytes !== undefined && Number.isFinite(Number(bytes)) ? `${(Number(bytes) / 1024 ** 3).toFixed(1)} GB` : '—';

export function createDeployPanel({ api, send, toast, copy, element: el, button, emptyState, getSources, getSession }) {
  const data = { servers: [], applications: [], environments: [], services: [], targets: [], tasks: [] };
  let view = 'projects', stream, timer, refreshing = false, refreshAgain = false, refreshTimer;
  let openTaskId, taskDialog, lastLogSeq = 0, taskFetching = false, errorMessage = '';
  const root = document.querySelector('#deploy-view');
  const find = (list, id) => data[list].find(item => item.id === id);
  const badge = (label, status = '') => el('span', `badge ${status}`, label);
  const row = (label, value) => { const item = el('div'); item.append(el('span', '', label), el('strong', '', value ?? '—')); return item; };
  const modeLabel = mode => mode === 'managed' ? '平台管理' : '仅观察';
  const nameOfTarget = target => {
    if (!target) return '已归档目标';
    const service = find('services', target.serviceId);
    const environment = find('environments', target.environmentId);
    const application = find('applications', service?.applicationId || environment?.applicationId);
    return `${application?.name || '项目'} / ${environment?.name || '环境'} / ${service?.name || '服务'}`;
  };
  const canManage = target => {
    const server = find('servers', target.serverId);
    return target.mode === 'managed' && server?.mode === 'managed' && !server.revoked && server.online;
  };

  function modal(title, description, wide = false) {
    // close 事件异步派发，连续打开弹窗时先移除已关闭表单，避免同名字段冲突。
    document.querySelectorAll('.deploy-dialog:not([open])').forEach(dialog => dialog.remove());
    const dialog = el('dialog', wide ? 'deploy-dialog wide-dialog' : 'deploy-dialog');
    const form = el('form');
    const heading = el('div', 'dialog-heading');
    const text = el('div'); text.append(el('p', 'eyebrow', 'DELIVERY CONTROL'), el('h2', '', title));
    const close = button('×', 'icon-button', () => dialog.close()); close.setAttribute('aria-label', '关闭');
    heading.append(text, close); form.append(heading);
    if (description) form.append(el('p', 'muted', description));
    dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    return { dialog, form, show: () => dialog.showModal() };
  }
  function field(form, name, title, value = '', options = {}) {
    const label = el('label', '', title);
    const input = el(options.choices ? 'select' : options.multiline ? 'textarea' : 'input');
    input.name = name; input.id = `deploy-${name}`;
    if (options.choices) for (const [id, text] of options.choices) {
      const item = el('option', '', text); item.value = id; input.append(item);
    }
    else if (!options.multiline) input.type = options.type || 'text';
    if (options.multiline) input.rows = options.rows || 3;
    input.value = value ?? ''; input.required = !!options.required; input.disabled = !!options.disabled;
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
    if (options.step !== undefined) input.step = options.step;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (!options.choices && !options.multiline) input.maxLength = options.maxLength || 2048;
    label.append(input); if (options.hint) label.append(el('small', '', options.hint));
    form.append(label); return input;
  }
  function section(form, title, description) {
    const box = el('section', 'config-section'); box.append(el('h3', '', title));
    if (description) box.append(el('p', 'muted', description));
    form.append(box); return box;
  }
  const grid = parent => { const node = el('div', 'form-grid'); parent.append(node); return node; };
  function submit(modal, label, action) {
    const error = el('p', 'form-error'); error.setAttribute('role', 'alert');
    const actions = el('div', 'dialog-actions'); const save = el('button', 'primary', label); save.type = 'submit';
    actions.append(button('取消', 'secondary', () => modal.dialog.close()), save); modal.form.append(error, actions);
    modal.form.addEventListener('submit', async event => {
      event.preventDefault(); error.textContent = ''; save.disabled = true;
      try { await action(Object.fromEntries(new FormData(modal.form))); }
      catch (failure) { error.textContent = failure.message; }
      finally { save.disabled = false; }
    });
  }
  function summary(items) {
    const node = el('div', 'summary-grid deploy-summary');
    for (const [label, value, detail] of items) {
      const item = el('article'); item.append(el('span', '', label), el('strong', '', value), el('small', '', detail)); node.append(item);
    }
    return node;
  }
  function notice(message, className = '') { return el('div', `info-box deploy-notice ${className}`, message); }

  function renderServers() {
    root.append(summary([
      ['已接入', data.servers.filter(item => item.registeredAt && !item.revoked).length, '使用独立身份主动连接中心'],
      ['在线', data.servers.filter(item => item.online && !item.revoked).length, '60 秒内收到心跳'],
      ['仅观察', data.servers.filter(item => item.mode === 'observe' && !item.revoked).length, '保留现有发布方式'],
    ]));
    if (!data.servers.length) { root.append(emptyState('接入第一台服务器', 'Agent 主动连接中心，上报主机资源和受管服务状态。', '＋ 接入服务器', openServer)); return; }
    const list = el('div', 'project-grid'); root.append(list);
    for (const server of data.servers) {
      const card = el('article', 'project-card server-card'); card.dataset.serverId = server.id;
      const heading = el('div', 'card-heading');
      const status = server.revoked ? '已撤销' : server.online ? '在线' : server.registeredAt ? '失联' : '等待接入';
      heading.append(el('span', 'project-icon', '▤'), el('h2', 'card-name', server.name), badge(status, server.revoked ? 'disabled' : server.online ? 'ready' : 'queued'));
      const mode = el('div', 'target-tags'); mode.append(badge(modeLabel(server.mode), server.mode === 'observe' ? 'idle' : ''));
      if (server.mode === 'observe') mode.append(el('span', 'muted small-copy', '仅采集状态，不执行发布'));
      const metrics = server.metrics || {};
      const usage = el('div', 'resource-grid');
      const cpu = metrics.cpuPercent ?? metrics.cpu?.percent;
      const memory = metrics.memory || {};
      const disk = metrics.disk || {};
      usage.append(row(server.online ? 'CPU 使用' : '最后 CPU 使用', Number.isFinite(cpu) ? `${cpu.toFixed(1)}%` : '—'),
        row('内存使用 / 总量', `${size(memory.used ?? metrics.memoryUsed)} / ${size(memory.total ?? metrics.memoryTotal)}`),
        row('工作目录磁盘', `${size(disk.used)} / ${size(disk.total)}`));
      const meta = el('div', 'card-meta'); meta.append(row('最近采集', date(server.lastSeenAt)), row('Agent 版本', server.version || '等待接入'));
      card.append(heading, mode, usage, meta);
      if (!server.online && server.registeredAt && !server.revoked) card.append(el('p', 'card-error', '连接已中断，业务当前状态待确认。以下页面保留最后上报的状态。'));
      const actions = el('div', 'card-actions');
      if (!server.revoked) actions.append(button('撤销接入', 'secondary', async () => {
        if (!confirm(`撤销「${server.name}」的接入凭据？服务器将无法再连接中心；此操作不会停止已有业务容器。`)) return;
        await send(`/api/deploy/servers/${server.id}/revoke`); await refresh(); toast('服务器接入已撤销');
      }));
      card.append(actions); list.append(card);
    }
  }
  function openServer() {
    const m = modal('接入服务器', '在服务器执行一次安装命令，即可连接中心。');
    field(m.form, 'name', '服务器名称', '', { required: true, maxLength: 80, placeholder: '例如：SOL 测试服务器' });
    field(m.form, 'mode', '管理方式', 'observe', { choices: [['observe', '仅观察（Jenkins 继续发布）'], ['managed', '平台管理（独立验证服务器）']] });
    m.form.append(notice('Agent 需要访问 Docker。平台管理模式可构建镜像、更新容器，具备接近宿主机管理员的权限；仅观察模式只采集已登记容器的状态。'));
    submit(m, '生成接入命令', async input => {
      const result = await send('/api/deploy/servers', input); m.dialog.close(); await refresh();
      const ready = modal('接入命令已生成', `在「${result.server.name}」的终端执行，令牌有效期至 ${date(result.expiresAt)}。`);
      const command = field(ready.form, 'installCommand', '安装命令', result.installCommand || '', { multiline: true, rows: 5 }); command.readOnly = true;
      ready.form.append(notice('命令包含一次性接入令牌，仅在本次显示。服务器需已安装 Linux、Docker 和 Compose。关闭后请勿将命令发送到公开渠道。'));
      const actions = el('div', 'dialog-actions'); actions.append(button('复制命令', 'secondary', () => copy(command.value)), button('已保存', 'primary', () => ready.dialog.close()));
      ready.form.append(actions); ready.show();
    }); m.show();
  }

  function renderApplications() {
    root.append(notice('先建立业务项目，再配置环境和服务。环境关联源码仓库，部署目标把环境、服务与服务器连接起来。'));
    if (!data.applications.length) { root.append(emptyState('组织第一个业务项目', '一个项目可以包含多个环境和多个 Java 服务。', '＋ 新增业务项目', () => openApplication())); return; }
    for (const application of data.applications) {
      const card = el('article', 'application-card');
      const header = el('div', 'application-header'); const heading = el('div');
      heading.append(el('h2', '', application.name), el('p', 'muted', application.description || '管理项目环境与 Java 服务'));
      header.append(heading, button('编辑项目', 'secondary', () => openApplication(application))); card.append(header);
      const columns = el('div', 'application-columns');
      for (const [type, title, action] of [['environments', '环境', openEnvironment], ['services', 'Java 服务', openService]]) {
        const box = el('section'); const top = el('div', 'section-title'); top.append(el('h3', '', title), button(`＋ 新增${title}`, 'text-button', () => action(application))); box.append(top);
        const entries = data[type].filter(item => item.applicationId === application.id);
        if (!entries.length) box.append(el('p', 'muted', `尚未配置${title}`));
        for (const item of entries) {
          const line = el('div', 'definition-row'); const text = el('div');
          const source = getSources().find(source => source.id === item.sourceProjectId);
          text.append(el('strong', '', item.name), el('small', '', type === 'environments' ? `${source?.name || '源码仓库不可用'} · ${source?.branch || '—'}` : item.module || '根模块'));
          line.append(text, button('编辑', 'text-button', () => action(application, item))); box.append(line);
        }
        columns.append(box);
      }
      card.append(columns); root.append(card);
    }
  }
  function openApplication(application) {
    const m = modal(application ? '编辑业务项目' : '新增业务项目', '按业务组织部署，同一个项目可拥有多个环境和服务。');
    field(m.form, 'name', '项目名称', application?.name || '', { required: true, maxLength: 80 });
    const description = field(m.form, 'description', '项目说明', application?.description || '', { multiline: true, rows: 2 }); description.maxLength = 500;
    submit(m, '保存项目', async input => {
      await send(`/api/deploy/applications${application ? `/${application.id}` : ''}`, input, application ? 'PUT' : 'POST');
      m.dialog.close(); await refresh(); toast('业务项目已保存');
    }); m.show();
  }
  function openEnvironment(application, environment) {
    const sources = getSources();
    if (!sources.length) { toast('请先在项目仓库中配置源码项目'); return; }
    const m = modal(environment ? '编辑环境' : '新增环境', `业务项目：${application.name}`);
    field(m.form, 'name', '环境名称', environment?.name || '', { required: true, maxLength: 80, placeholder: '例如：独立验证环境' });
    field(m.form, 'sourceProjectId', '源码仓库 / 分支', environment?.sourceProjectId || sources[0]?.id, { required: true,
      choices: sources.map(item => [item.id, `${item.name} · ${item.branch}${item.enabled ? '' : '（已停用）'}`]) });
    submit(m, '保存环境', async input => {
      await send(`/api/deploy/environments${environment ? `/${environment.id}` : ''}`, { ...input, applicationId: application.id }, environment ? 'PUT' : 'POST');
      m.dialog.close(); await refresh(); toast('环境已保存');
    }); m.show();
  }
  function openService(application, service) {
    const m = modal(service ? '编辑 Java 服务' : '新增 Java 服务', `业务项目：${application.name}`);
    field(m.form, 'name', '服务名称', service?.name || '', { required: true, maxLength: 80, placeholder: '例如：API 服务' });
    field(m.form, 'module', 'Maven 模块', service?.module || '', { required: true, placeholder: 'brezze-api；单模块项目填写 .', hint: '发布时同时编译该模块及其公共依赖。' });
    submit(m, '保存服务', async input => {
      await send(`/api/deploy/services${service ? `/${service.id}` : ''}`, { ...input, applicationId: application.id }, service ? 'PUT' : 'POST');
      m.dialog.close(); await refresh(); toast('Java 服务已保存');
    }); m.show();
  }

  function renderTargets() {
    root.append(summary([
      ['部署目标', data.targets.length, '每个目标独立保存配置和运行版本'],
      ['仅观察', data.targets.filter(item => item.mode === 'observe').length, '由 Jenkins 等外部系统发布'],
      ['平台管理', data.targets.filter(item => item.mode === 'managed').length, '可在此发布、重启与回退'],
    ]));
    if (!data.targets.length) { root.append(emptyState('连接服务与服务器', '完成项目配置和服务器接入后，创建独立部署目标。', '＋ 新增部署目标', () => openTarget())); return; }
    const list = el('div', 'target-list'); root.append(list);
    for (const target of data.targets) {
      const server = find('servers', target.serverId); const card = el('article', 'target-card'); card.dataset.targetId = target.id;
      const heading = el('div', 'application-header'); const title = el('div');
      title.append(el('h2', '', nameOfTarget(target)), el('p', 'muted', `${server?.name || '服务器不可用'}${target.containerName ? ` · ${target.containerName}` : ''}`));
      heading.append(title, badge(target.mode === 'observe' ? 'Jenkins / 外部管理 · 仅观察' : '平台管理', target.mode === 'observe' ? 'idle' : ''));
      const observation = target.observation || {}; const healthy = observation.health || observation.healthStatus;
      const running = observation.state || observation.status;
      const current = target.currentRelease || {};
      const details = el('div', 'target-details');
      const stateText = { running: '运行中', exited: '已停止', restarting: '重启中', created: '已创建', missing: '未找到容器', unknown: '待确认' };
      const healthText = { healthy: '健康', unhealthy: '异常', starting: '检查中', none: '未配置检查', unknown: '待确认' };
      details.append(row('运行状态', !server?.online ? '失联 · 当前待确认' : stateText[running] || running || '尚未上报'),
        row(server?.online ? '健康状态' : '最后健康状态', healthText[healthy] || healthy || '尚未上报'),
        row('当前版本', short(current.revision || observation.revision)), row('重启次数', observation.restartCount ?? '—'),
        row('最近采集', date(target.lastObservedAt || observation.at)));
      card.append(heading, details);
      if (current.image || observation.image) card.append(el('p', 'image-reference', `镜像：${current.image || observation.image}`));
      const actions = el('div', 'card-actions');
      const busy = data.tasks.some(task => task.targetId === target.id && !finished(task));
      for (const [action, label] of [['deploy', '发布最新源码'], ['restart', '重启'], ['rollback', '回退版本']]) {
        const node = button(label, action === 'deploy' ? 'primary' : 'secondary', () => openAction(target, action));
        node.disabled = !canManage(target) || busy || (action !== 'deploy' && !target.currentRelease);
        node.title = target.mode === 'observe' ? '仅观察目标由外部系统发布，不允许在此操作' : !server?.online ? '服务器未在线，暂不可操作' : busy ? '已有任务正在执行' : '';
        actions.append(node);
      }
      actions.append(button('编辑配置', 'secondary', () => openTarget(target))); card.append(actions); list.append(card);
    }
  }

  function openTarget(target) {
    const availableServers = data.servers.filter(item => !item.revoked);
    if (!data.environments.length || !data.services.length || !availableServers.length) { toast('请先配置业务项目、环境、Java 服务，并接入服务器'); return; }
    const m = modal(target ? '编辑部署目标' : '新增部署目标', '仅观察目标不会被自动接管。平台管理目标应使用独立验证环境。', true);
    const base = section(m.form, '部署位置'); const a = grid(base);
    const environment = field(a, 'environmentId', '环境', target?.environmentId || data.environments[0]?.id, { required: true, disabled: !!target,
      choices: data.environments.map(item => [item.id, `${find('applications', item.applicationId)?.name} / ${item.name}`]) });
    const service = field(a, 'serviceId', 'Java 服务', '', { required: true, disabled: !!target, choices: [] });
    const b = grid(base);
    const server = field(b, 'serverId', '目标服务器', target?.serverId || availableServers[0]?.id, { required: true, disabled: !!target,
      choices: availableServers.map(item => [item.id, `${item.name} · ${modeLabel(item.mode)}`]) });
    const mode = field(b, 'mode', '管理方式', target?.mode || 'observe', { disabled: !!target, choices: [['observe', '仅观察（Jenkins / 外部管理）'], ['managed', '平台管理']] });
    const observe = section(m.form, '观察配置', '仅采集这个已存在的容器。发布、重启和回退仍由原系统执行。');
    const containerName = field(observe, 'containerName', '现有容器名称', target?.containerName || '', { placeholder: '例如：solstandard-java-brezze-api-1' });
    const managed = el('div', 'managed-config'); m.form.append(managed);
    const config = target?.config || {};
    const build = section(managed, '构建配置', '在隔离的构建容器内编译，复用该项目的 Maven 依赖缓存。');
    const buildGrid = grid(build);
    field(buildGrid, 'buildImage', '构建镜像', config.buildImage || 'maven:3.9.9-eclipse-temurin-8');
    const artifact = field(buildGrid, 'artifactPath', 'JAR 产物路径', config.artifactPath || '', { hint: '相对于源码根目录；文件名可使用一个 *。' });
    const resources = grid(build);
    field(resources, 'buildCpus', '构建 CPU 上限（核）', config.build?.cpus ?? 1, { type: 'number', min: .1, max: 32, step: .1 });
    field(resources, 'buildMemory', '构建内存上限（MB）', config.build?.memoryMb ?? 1024, { type: 'number', min: 256, max: 65536 });
    const runtime = section(managed, '运行配置'); const runGrid = grid(runtime);
    field(runGrid, 'runtimeImage', '运行镜像', config.runtimeImage || 'eclipse-temurin:8-jre');
    field(runGrid, 'profile', 'Spring Profile', config.profile ?? 'test');
    const limits = grid(runtime);
    field(limits, 'cpus', '运行 CPU 上限（核）', config.runtime?.cpus ?? .5, { type: 'number', min: .1, max: 32, step: .1 });
    field(limits, 'memory', '运行内存上限（MB）', config.runtime?.memoryMb ?? 512, { type: 'number', min: 128, max: 65536 });
    const args = grid(runtime);
    field(args, 'jvmArgs', 'JVM 参数（每行一个）', (config.jvmArgs || ['-Duser.timezone=Asia/Shanghai', '-Xms64m', '-Xmx192m', '-XX:MaxMetaspaceSize=128m', '-XX:+ExitOnOutOfMemoryError']).join('\n'), { multiline: true, rows: 5 });
    field(args, 'args', '应用参数（每行一个）', (config.args || []).join('\n'), { multiline: true, rows: 5, placeholder: '--ybt.enable=false' });
    const connections = section(managed, '端口、网络与存储', '真实项目副本需使用独立的数据库和中间件数据空间，避免影响现有服务。');
    const mapping = grid(connections);
    field(mapping, 'ports', '端口映射（每行一条）', (config.ports || [{ host: '127.0.0.1', hostPort: 18080, containerPort: 8080 }]).map(item => `${item.host}:${item.hostPort}:${item.containerPort}`).join('\n'), { multiline: true, hint: '格式：127.0.0.1:服务器端口:容器端口；允许 0.0.0.0，服务器端口需大于 1023。' });
    field(mapping, 'networks', '已有 Docker 网络（每行一个）', (config.networks || []).join('\n'), { multiline: true, hint: '留空使用平台独立网络。' });
    field(connections, 'volumes', '持久化卷（每行一条）', (config.volumes || [{ name: 'logs', mountPath: '/app/logs' }]).map(item => `${item.name}:${item.mountPath}`).join('\n'), { multiline: true, rows: 2, hint: '例如 logs:/app/logs。卷名使用小写字母、数字和横线；仅支持 /app 子目录中的平台命名卷。' });
    const health = section(managed, '健康检查', '在容器内发起 HTTP 请求，检查通过后才将发布标记为成功。');
    const healthGrid = grid(health);
    field(healthGrid, 'healthPath', '检查路径', config.health?.path || '/health', { placeholder: '/api/swagger-resources' });
    field(healthGrid, 'healthPort', '容器端口', config.health?.port ?? 8080, { type: 'number', min: 1, max: 65535 });
    const healthGrid2 = grid(health);
    field(healthGrid2, 'healthStatus', '成功 HTTP 状态码', config.health?.status ?? 200, { type: 'number', min: 200, max: 399 });
    field(healthGrid2, 'healthBody', '响应内容需包含（可选）', config.health?.bodyIncludes || '', { placeholder: 'swaggerVersion' });
    const healthGrid3 = grid(health);
    field(healthGrid3, 'healthTimeout', '等待健康最长时间（秒）', config.health?.timeoutSeconds ?? 180, { type: 'number', min: 10, max: 900 });
    field(healthGrid3, 'healthInterval', '检查间隔（秒）', config.health?.intervalSeconds ?? 5, { type: 'number', min: 2, max: 60 });
    const changeMode = () => {
      const serverValue = find('servers', server.value);
      const managedOption = [...mode.options].find(item => item.value === 'managed'); managedOption.disabled = serverValue?.mode !== 'managed';
      if (serverValue?.mode !== 'managed') mode.value = 'observe';
      const isObserve = mode.value === 'observe'; observe.hidden = !isObserve; managed.hidden = isObserve;
      containerName.required = isObserve;
      managed.querySelectorAll('input,textarea').forEach(input => { input.disabled = isObserve; });
    };
    const changeService = () => {
      const selected = find('services', service.value);
      if (!target && selected) artifact.value = `${!selected.module || selected.module === '.' ? '' : `${selected.module}/`}target/*.jar`;
    };
    const changeEnvironment = () => {
      const selected = find('environments', environment.value); service.replaceChildren();
      for (const item of data.services.filter(item => item.applicationId === selected?.applicationId)) {
        const option = el('option', '', item.name); option.value = item.id; service.append(option);
      }
      if (target) service.value = target.serviceId;
      changeService();
    };
    environment.addEventListener('change', changeEnvironment); service.addEventListener('change', changeService);
    server.addEventListener('change', changeMode); mode.addEventListener('change', changeMode);
    changeEnvironment(); changeMode();
    const lines = value => (value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    submit(m, '保存部署目标', async input => {
      const body = { environmentId: environment.value, serviceId: service.value, serverId: server.value, mode: mode.value };
      if (!body.serviceId) throw new Error('这个环境所属项目还没有 Java 服务，请先新增服务');
      if (body.mode === 'observe') body.containerName = containerName.value.trim();
      else {
        const ports = lines(input.ports).map(line => {
          const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+):(\d+)$/.exec(line);
          if (!match) throw new Error('端口映射请使用 IP:服务器端口:容器端口 格式');
          return { host: match[1], hostPort: Number(match[2]), containerPort: Number(match[3]) };
        });
        const volumes = lines(input.volumes).map(line => {
          const index = line.indexOf(':'); if (index < 1 || line[index + 1] !== '/') throw new Error('持久化卷请使用 卷名:/容器路径 格式');
          return { name: line.slice(0, index), mountPath: line.slice(index + 1) };
        });
        body.config = { module: find('services', service.value).module, artifactPath: input.artifactPath, buildImage: input.buildImage,
          runtimeImage: input.runtimeImage, jvmArgs: lines(input.jvmArgs), args: lines(input.args), profile: input.profile,
          ports, networks: lines(input.networks), volumes, build: { cpus: Number(input.buildCpus), memoryMb: Number(input.buildMemory) },
          runtime: { cpus: Number(input.cpus), memoryMb: Number(input.memory) },
          health: { path: input.healthPath, port: Number(input.healthPort), status: Number(input.healthStatus), bodyIncludes: input.healthBody,
            timeoutSeconds: Number(input.healthTimeout), intervalSeconds: Number(input.healthInterval) } };
      }
      await send(`/api/deploy/targets${target ? `/${target.id}` : ''}`, body, target ? 'PUT' : 'POST');
      m.dialog.close(); await refresh(); toast('部署目标已保存');
    }); m.show();
  }

  async function openAction(target, action) {
    if (!canManage(target)) { toast('仅允许操作在线服务器的平台管理目标'); return; }
    const m = modal(`${actionNames[action]}服务`, nameOfTarget(target));
    const input = { targetId: target.id, action };
    let release;
    if (action === 'rollback') {
      const result = await api(`/api/deploy/targets/${target.id}/releases`);
      const releases = (result.releases || []).filter(item => item.id !== target.currentRelease?.id && item.available !== false && !['failed', 'deleted'].includes(item.status));
      if (!releases.length) { m.dialog.remove(); toast('还没有可回退的历史版本'); return; }
      release = field(m.form, 'releaseId', '恢复到版本', releases[0].id, { choices: releases.map(item => [item.id, `${short(item.revision)} · ${date(item.createdAt)}`]), required: true });
    }
    m.form.append(notice(action === 'deploy' ? '本次将固定最新源码版本，依次编译、更新此目标并检查健康状态。其他部署目标保持运行。' : action === 'restart' ? '重启会短暂中断这个服务。重启后将重新检查健康状态。' : '将恢复所选版本的镜像与部署配置，并执行健康检查。'));
    submit(m, `确认${actionNames[action]}`, async () => {
      const result = await send('/api/deploy/tasks', { ...input, ...(release ? { releaseId: release.value } : {}) });
      m.dialog.close(); await refresh(); await showTask(result.task.id);
    }); m.show();
  }

  function renderTasks() {
    root.append(summary([
      ['正在处理', data.tasks.filter(item => !finished(item)).length, '任务与业务健康状态分别记录'],
      ['已成功', data.tasks.filter(item => ['succeeded', 'success'].includes(item.status)).length, '最近发布记录中的成功任务'],
      ['需关注', data.tasks.filter(item => ['failed', 'interrupted', 'rolled_back'].includes(item.status)).length, '查看日志与回退结果'],
    ]));
    if (!data.tasks.length) { root.append(emptyState('还没有发布记录', '在部署目标中发起首次发布，即可在这里跟踪进度。')); return; }
    const list = el('div', 'task-list'); root.append(list);
    for (const task of data.tasks) {
      const item = el('article', 'task-row'); item.dataset.taskId = task.id;
      const main = el('div', 'task-main'); main.append(el('strong', '', nameOfTarget(find('targets', task.targetId))),
        el('small', '', `${actionNames[task.action] || task.action} · ${date(task.createdAt)} · ${short(revisionOf(task))}`));
      const stage = el('div', 'task-stage'); stage.append(badge(resultName(task), ['failed', 'interrupted'].includes(task.status) ? 'failed' : task.status === 'rolled_back' ? 'queued' : finished(task) ? 'ready' : 'queued'),
        el('small', '', `${stageNames[task.stage] || task.stage || '等待执行'} · ${duration(task)}`));
      item.append(main, stage, button('查看详情', 'secondary', () => showTask(task.id))); list.append(item);
    }
  }

  async function showTask(id) {
    taskDialog?.close(); openTaskId = id; lastLogSeq = 0;
    const m = modal('发布详情', '', true); taskDialog = m.dialog;
    const info = el('div', 'task-info'); info.id = 'deploy-task-info';
    const stages = el('div', 'task-progress'); stages.id = 'deploy-task-progress';
    const result = el('div'); result.id = 'deploy-task-result';
    const logHeading = el('div', 'section-title'); logHeading.append(el('h3', '', '执行日志'), el('small', '', '断线后自动补传；按原始顺序显示'));
    const logs = el('pre', 'task-logs'); logs.id = 'deploy-task-logs'; logs.setAttribute('aria-label', '执行日志'); logs.tabIndex = 0;
    m.form.append(info, stages, result, logHeading, logs);
    m.dialog.addEventListener('close', () => { if (taskDialog === m.dialog) { openTaskId = undefined; taskDialog = undefined; } });
    m.show(); await refreshTask();
  }
  async function refreshTask() {
    if (!openTaskId || taskFetching) return;
    const id = openTaskId; taskFetching = true;
    try {
      const { task, logs = [] } = await api(`/api/deploy/tasks/${id}?after=${lastLogSeq}`);
      if (id !== openTaskId) return;
      const info = document.querySelector('#deploy-task-info'); info.replaceChildren();
      info.append(row('部署目标', nameOfTarget(find('targets', task.targetId))), row('任务结果', resultName(task)),
        row('源码版本', revisionOf(task) || (finished(task) ? '—' : '准备中')), row('开始 / 结束', `${date(task.startedAt || task.createdAt)} / ${task.finishedAt ? date(task.finishedAt) : '进行中'}`), row('总耗时', duration(task)));
      const result = document.querySelector('#deploy-task-result'); result.replaceChildren();
      if (task.error) result.append(notice(task.error, 'error-note'));
      if (task.result) {
        const outcome = task.result;
        if (typeof outcome === 'string') result.append(notice(outcome));
        else {
          if (outcome.message) result.append(notice(outcome.message));
          if (outcome.error && outcome.error !== task.error) result.append(notice(`失败原因：${outcome.error}`, 'error-note'));
          if (outcome.rollback) {
            const status = typeof outcome.rollback === 'string' ? outcome.rollback : outcome.rollback.status;
            result.append(notice(`自动回退：${({ succeeded: '成功', failed: '失败', unavailable: '没有可恢复的基线' })[status] || status || '请检查日志'}`));
            if (outcome.rollback.error) result.append(notice(`回退失败原因：${outcome.rollback.error}`, 'error-note'));
          }
          if (outcome.cleanupError) result.append(notice(`失败容器清理异常：${outcome.cleanupError}`, 'error-note'));
          if (outcome.image || outcome.release?.image) result.append(el('p', 'image-reference', `镜像：${outcome.image || outcome.release.image}`));
        }
      }
      const output = document.querySelector('#deploy-task-logs'); const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
      const additional = logs.filter(item => item.seq > lastLogSeq).sort((a, b) => a.seq - b.seq);
      for (const line of additional) {
        output.append(document.createTextNode(`[${date(line.at)}] ${line.stage ? `[${stageNames[line.stage] || line.stage}] ` : ''}${line.message}\n`));
        lastLogSeq = line.seq;
      }
      if (nearBottom) output.scrollTop = output.scrollHeight;
      const stages = document.querySelector('#deploy-task-progress'); stages.replaceChildren();
      const stageList = task.action === 'deploy' ? ['preparing', 'queued', 'downloading', 'building', 'deploying', 'verifying'] : ['queued', 'deploying', 'verifying'];
      for (const name of stageList) {
        const entries = (task.stageHistory || []).filter(entry => entry.stage === name);
        const current = entries.some(entry => !entry.finishedAt) && !finished(task);
        const item = el('div', `stage-step ${entries.length ? current ? 'active' : 'complete' : ''}`);
        let text = '等待执行';
        if (entries.length) {
          const milliseconds = entries.reduce((sum, entry) => sum + (entry.durationMs ?? Math.max(0, (entry.finishedAt ? Date.parse(entry.finishedAt) : Date.now()) - Date.parse(entry.startedAt))), 0);
          text = duration({ startedAt: new Date(0).toISOString(), finishedAt: new Date(milliseconds).toISOString() });
        }
        else if (finished(task)) text = '无阶段记录';
        item.append(el('strong', '', stageNames[name]), el('small', '', text)); stages.append(item);
      }
      if (lastLogSeq < task.lastSeq) scheduleRefresh();
    } catch (failure) { if (id === openTaskId) toast(`日志暂时不可用：${failure.message}`); }
    finally { taskFetching = false; if (openTaskId && id !== openTaskId) refreshTask(); }
  }

  function render() {
    if (!deployPages[view]) return;
    root.replaceChildren();
    if (errorMessage) root.append(notice(`中心连接异常：${errorMessage}。下方保留最近一次读取的状态。`, 'error-note'));
    if (view === 'servers') renderServers();
    else if (view === 'applications') renderApplications();
    else if (view === 'deployments') renderTargets();
    else renderTasks();
  }
  async function refresh() {
    if (!getSession()) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      const value = await api('/api/deploy/overview');
      for (const key of Object.keys(data)) data[key] = Array.isArray(value[key]) ? value[key] : [];
      errorMessage = ''; render(); await refreshTask();
    } catch (error) { errorMessage = error.message; render(); }
    finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
    }
  }
  function scheduleRefresh() {
    if (refreshTimer) return;
    // 持续日志也按固定节奏刷新，避免每次事件都延后读取。
    refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 350);
  }
  function start() {
    if (timer) return;
    refresh(); timer = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
    stream = new EventSource('/api/deploy/events');
    stream.addEventListener('update', scheduleRefresh);
    stream.onmessage = scheduleRefresh;
    stream.onopen = scheduleRefresh;
    // 事件流断线时由浏览器重连，定期读取仍可更新状态。
    stream.onerror = () => { if (!getSession()) stop(); };
  }
  function stop() {
    stream?.close(); stream = undefined; clearInterval(timer); timer = undefined;
    clearTimeout(refreshTimer); refreshTimer = undefined; taskDialog?.close();
    for (const dialog of document.querySelectorAll('.deploy-dialog')) dialog.close();
    for (const key of Object.keys(data)) data[key] = [];
    root.replaceChildren();
  }
  return {
    start, stop,
    setView(next) { view = next; render(); if (deployPages[view]) refresh(); },
    create() { if (view === 'servers') openServer(); else if (view === 'applications') openApplication(); else if (view === 'deployments') openTarget(); },
  };
}
