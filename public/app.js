const $ = selector => document.querySelector(selector);
const state = { session: null, overview: { projects: [], credentials: [], events: [] }, view: 'projects' };
const labels = { idle: '等待下载', queued: '排队中', syncing: '同步中', ready: '已就绪', failed: '同步失败', disabled: '已停用' };
let toastTimer;
let loading = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json',
    ...(state.session?.csrf ? { 'X-CSRF-Token': state.session.csrf } : {}), ...options.headers } });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.session && !['/api/login', '/api/password'].includes(url)) {
      state.session = null; await initialize();
    }
    throw new Error(value.error || '请求失败');
  }
  return value;
}
const send = (url, value = {}, method = 'POST') => api(url, { method, body: JSON.stringify(value) });
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
const formatSize = bytes => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const downloadUrl = id => `${location.origin}/api/projects/${id}/source/latest`;
const downloadPage = id => `${location.origin}/download/${id}`;

async function copy(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const field = element('textarea'); field.value = value;
      const host = document.querySelector('dialog[open]') || document.body;
      host.append(field); field.select();
      const success = document.execCommand('copy'); field.remove();
      if (!success) throw new Error();
    }
    toast('已复制到剪贴板');
  } catch { toast('自动复制失败，请选中文字手动复制'); }
}
function button(text, className, action) {
  const node = element('button', className, text); node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); } catch (error) { toast(error.message); }
    finally { node.disabled = false; }
  });
  return node;
}
function emptyState(title, description, actionText, action) {
  const box = element('div', 'empty-state');
  box.append(element('div', 'empty-icon', '▧'), element('h2', '', title), element('p', '', description));
  if (action) box.append(button(actionText, 'primary', action));
  return box;
}
function openDialog(id) {
  const dialog = $(`#${id}`);
  const error = dialog.querySelector('.form-error'); if (error) error.textContent = '';
  dialog.showModal();
}
function openProject(project) {
  const form = $('#project-form'); form.reset();
  $('#project-dialog-title').textContent = project ? '编辑项目' : '新增项目';
  const select = $('#project-credential'); select.replaceChildren();
  const publicOption = element('option', '', '公开仓库（不使用凭证）'); publicOption.value = ''; select.append(publicOption);
  for (const item of state.overview.credentials) { const option = element('option', '', item.name); option.value = item.id; select.append(option); }
  if (project) {
    for (const key of ['id', 'name', 'repository', 'branch', 'credentialId']) form.elements[key].value = project[key] || '';
    form.elements.enabled.checked = project.enabled;
  }
  openDialog('project-dialog');
}
function openCredential(credential) {
  const form = $('#credential-form'); form.reset();
  $('#credential-dialog-title').textContent = credential ? '编辑 Gitee 凭证' : '新增 Gitee 凭证';
  form.elements.password.required = !credential;
  if (credential) for (const key of ['id', 'name', 'username']) form.elements[key].value = credential[key];
  openDialog('credential-dialog');
}
function showSecret(project, token) {
  $('#secret-project-name').textContent = project.name;
  $('#secret-value').value = token; $('#secret-url').value = downloadUrl(project.id); $('#secret-page').value = downloadPage(project.id);
  openDialog('secret-dialog');
}

function renderProjects() {
  const projects = state.overview.projects;
  $('#stat-total').textContent = projects.length;
  $('#stat-enabled').textContent = projects.filter(item => item.enabled).length;
  $('#stat-downloads').textContent = projects.reduce((sum, item) => sum + (item.downloads || 0), 0);
  $('#nav-count').textContent = projects.length;
  $('#project-count').textContent = projects.length;
  const list = $('#project-list'); list.replaceChildren();
  const search = $('#search').value.trim().toLowerCase();
  const filtered = projects.filter(item => [item.name, item.repository, item.branch].some(value => value.toLowerCase().includes(search)));
  if (!filtered.length) {
    list.append(emptyState(projects.length ? '没有匹配的项目' : '连接你的第一个源码仓库',
      projects.length ? '换个关键词，查找项目名称、仓库或分支。' : '添加 Gitee 凭证和交付分支，生成专属下载地址与密码。',
      '＋ 新增项目', projects.length ? null : () => openProject()));
  }
  for (const project of filtered) {
    const card = element('article', 'project-card');
    const heading = element('div', 'card-heading');
    const status = project.enabled ? project.status : 'disabled';
    heading.append(element('span', 'project-icon', '▧'), element('h2', 'card-name', project.name), element('span', `badge ${status}`, labels[status] || status));
    const repository = element('a', 'repo-link', project.repository.replace('https://', ''));
    repository.href = project.repository; repository.target = '_blank'; repository.rel = 'noopener noreferrer'; repository.title = project.repository;
    const branch = element('div', 'branch-line'); branch.append(element('span', '', '交付分支'), element('span', 'branch-tag', `⑂ ${project.branch}`));
    const meta = element('div', 'card-meta');
    const updated = element('div', '', '最近成功同步'); updated.append(element('strong', '', formatTime(project.lastSuccess?.at)));
    const version = element('div', '', '源码版本 / 大小'); version.append(element('strong', '', project.lastSuccess ? `${project.lastSuccess.revision.slice(0, 8)} · ${formatSize(project.lastSuccess.size)}` : '首次下载时生成'));
    meta.append(updated, version);
    const actions = element('div', 'card-actions');
    actions.append(button('复制地址', 'secondary', () => copy(downloadPage(project.id))), button('编辑', 'secondary', () => openProject(project)));
    const syncButton = button('立即同步', 'secondary', async () => {
      toast('正在同步最新源码，请稍候…');
      const result = await send(`/api/projects/${project.id}/sync`);
      toast(result.cached ? '已检查远端，源码包为最新版本' : '最新源码包已生成'); await refresh();
    });
    syncButton.disabled = !project.enabled || ['syncing', 'queued'].includes(project.status);
    actions.append(syncButton, button('重置密码', 'secondary', async () => {
      if (!confirm(`重置「${project.name}」的下载密码？旧密码会立即失效，请同步更新 Jenkins 凭据。`)) return;
      const result = await send(`/api/projects/${project.id}/rotate-token`); showSecret(project, result.token);
    }), button(project.enabled ? '停用' : '启用', 'text-button', async () => {
      await send(`/api/projects/${project.id}/enabled`, { enabled: !project.enabled }); await refresh();
    }));
    card.append(heading, repository, branch, meta);
    if (project.error) card.append(element('p', 'card-error', project.error));
    card.append(actions); list.append(card);
  }
}
function renderCredentials() {
  const list = $('#credential-list'); list.replaceChildren();
  if (!state.overview.credentials.length) list.append(emptyState('还没有 Gitee 凭证', '添加能读取目标仓库的专用账号，在不同项目之间复用连接配置。', '＋ 新增凭证', () => openCredential()));
  for (const credential of state.overview.credentials) {
    const card = element('article', 'credential-card'); const content = element('div');
    const usage = state.overview.projects.filter(item => item.credentialId === credential.id).length;
    content.append(element('h2', '', credential.name), element('p', '', `${credential.username} · ${usage} 个项目使用 · 密码已加密保存`));
    const actions = element('div', 'actions');
    actions.append(button('编辑', 'secondary', () => openCredential(credential)), button('删除', 'secondary', async () => {
      if (!confirm(`删除凭证「${credential.name}」？`)) return;
      await api(`/api/credentials/${credential.id}`, { method: 'DELETE' }); await refresh();
    }));
    card.append(element('span', 'project-icon', '⌘'), content, actions); list.append(card);
  }
}
function renderActivity() {
  const list = $('#activity-list'); list.replaceChildren();
  const names = { setup: '初始化', project: '项目', credential: '凭证', sync: '同步成功', failure: '同步失败', token: '下载密码', enabled: '状态' };
  for (const event of state.overview.events) {
    const row = element('div', 'event-row');
    row.append(element('time', '', formatTime(event.at)), element('span', `badge ${event.action === 'failure' ? 'failed' : ''}`, names[event.action] || event.action), element('span', 'event-message', event.message));
    list.append(row);
  }
  if (!state.overview.events.length) list.append(emptyState('还没有操作记录', '项目创建和同步结果会显示在这里。'));
}
function render() { renderProjects(); renderCredentials(); renderActivity(); }
async function refresh() {
  if (!state.session || loading) return;
  loading = true;
  try { state.overview = await api('/api/overview'); render(); $('#connection-error').hidden = true; }
  catch (error) { $('#connection-error').textContent = `连接异常：${error.message}`; $('#connection-error').hidden = false; }
  finally { loading = false; }
}
function setView(view) {
  state.view = view;
  const names = { projects: ['项目仓库', '从源码到交付，只需一个专属下载地址。'], credentials: ['Gitee 凭证', '在这里配置用于读取源码的 Gitee 账号。'], activity: ['操作记录', '查看最近 100 条管理操作和同步结果。'] };
  $('#page-title').textContent = names[view][0]; $('#breadcrumb').textContent = names[view][0]; $('#page-description').textContent = names[view][1];
  $('#project-summary').hidden = view !== 'projects'; $('#project-toolbar').hidden = view !== 'projects'; $('#project-list').hidden = view !== 'projects';
  $('#credential-list').hidden = view !== 'credentials'; $('#activity-list').hidden = view !== 'activity';
  $('#create-button').hidden = view === 'activity'; $('#create-button').textContent = view === 'credentials' ? '＋ 新增凭证' : '＋ 新增项目';
  document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view));
}
async function initialize() {
  try {
    const session = await api('/api/session');
    state.session = session.authenticated ? session : null;
    $('#auth-view').hidden = session.authenticated; $('#app-view').hidden = !session.authenticated;
    $('#bootstrap-field').hidden = session.initialized; $('#auth-form').elements.bootstrapToken.required = !session.initialized;
    $('#auth-form').elements.password.minLength = session.initialized ? 1 : 12;
    $('#auth-form').elements.password.autocomplete = session.initialized ? 'current-password' : 'new-password';
    $('#auth-form').dataset.setup = String(!session.initialized);
    $('#auth-title').textContent = session.initialized ? '登录工作台' : '创建管理账号';
    $('#auth-description').textContent = session.initialized ? '管理项目、连接凭证与源码交付。' : '输入部署初始化口令，设置至少 12 位的管理员密码。';
    $('#auth-form button').textContent = session.initialized ? '登录工作台 →' : '创建账号并进入 →';
    if (session.authenticated) { $('#admin-name').textContent = session.username; await refresh(); }
  } catch (error) { $('#auth-view').hidden = false; $('#auth-error').textContent = `无法连接服务：${error.message}`; }
}

function handleForm(selector, action) {
  $(selector).addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget;
    const submit = form.querySelector('[type=submit]'); const error = form.querySelector('.form-error');
    submit.disabled = true; if (error) error.textContent = '';
    try { await action(Object.fromEntries(new FormData(form)), form); }
    catch (failure) { if (error) error.textContent = failure.message; else toast(failure.message); }
    finally { submit.disabled = false; }
  });
}
handleForm('#auth-form', async (input, form) => {
  await send(form.dataset.setup === 'true' ? '/api/setup' : '/api/login', input); form.reset(); await initialize();
});
handleForm('#project-form', async (input, form) => {
  input.enabled = form.elements.enabled.checked;
  const result = await send(input.id ? `/api/projects/${input.id}` : '/api/projects', input, input.id ? 'PUT' : 'POST');
  $('#project-dialog').close(); await refresh();
  if (result.token) showSecret(result.project, result.token); else toast('项目配置已保存');
});
handleForm('#credential-form', async (input, form) => {
  await send(input.id ? `/api/credentials/${input.id}` : '/api/credentials', input, input.id ? 'PUT' : 'POST');
  form.reset(); $('#credential-dialog').close(); await refresh(); toast('Gitee 凭证已保存');
});
handleForm('#password-form', async (input, form) => {
  await send('/api/password', input); form.reset(); $('#password-dialog').close(); state.session = null; await initialize(); toast('密码已更新，请重新登录');
});
document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
document.querySelectorAll('[data-copy]').forEach(node => node.addEventListener('click', () => copy($(`#${node.dataset.copy}`).value)));
document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => setView(node.dataset.view)));
$('#secret-dialog').addEventListener('close', () => { $('#secret-value').value = ''; });
$('#credential-dialog').addEventListener('close', () => { $('#credential-form').elements.password.value = ''; });
$('#password-dialog').addEventListener('close', () => $('#password-form').reset());
$('#create-button').addEventListener('click', () => state.view === 'credentials' ? openCredential() : openProject());
$('#search').addEventListener('input', renderProjects);
$('#password-button').addEventListener('click', () => openDialog('password-dialog'));
$('#logout-button').addEventListener('click', async () => {
  try { await send('/api/logout'); state.session = null; await initialize(); } catch (error) { toast(error.message); }
});

const publicDownload = /^\/download\/([a-f0-9-]{36})$/.exec(location.pathname);
if (publicDownload) {
  $('#download-view').hidden = false;
  handleForm('#download-form', async (input, form) => {
    $('#download-progress').textContent = '正在验证密码、同步最新代码并准备下载，请稍候…';
    try {
      const response = await fetch(`/api/projects/${publicDownload[1]}/source/latest`, { headers: { Authorization: `Bearer ${input.token.trim()}` } });
      if (!response.ok) throw new Error((await response.json()).error || '下载失败');
      $('#download-progress').textContent = '源码包已就绪，正在接收文件…';
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const link = element('a'); link.href = url;
      link.download = `source-${(response.headers.get('X-Source-Revision') || 'latest').slice(0, 12)}.zip`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('#download-progress').textContent = `下载完成 · ${formatSize(blob.size)} · SHA-256：${response.headers.get('X-Archive-SHA256')}`;
      form.reset();
    } catch (error) { $('#download-progress').textContent = '未下载源码包。修正配置或稍后重试。'; throw error; }
  });
} else {
  await initialize();
  setInterval(() => { if (state.session && !document.hidden) refresh(); }, 5000);
}
