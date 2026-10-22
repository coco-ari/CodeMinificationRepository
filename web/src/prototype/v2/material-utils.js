// 所有文件处理都生成新对象，避免修改输入快照。
export function stripGitFiles(files) {
  return files
    .filter(
      (file) =>
        !file.name
          .replaceAll('\\', '/')
          .split('/')
          .some((segment) => segment === '.git'),
    )
    .map((file) => ({ ...file }))
}

export function sanitizeFiles(files, rules = []) {
  const findings = []
  const output = files.map((file) => {
    let content = String(file.content ?? '')
    content = content.replace(
      /((?:password|passwd|secret|api[_-]?key|api[_-]?token|access[_-]?key|access[_-]?token|token)\s*["']?\s*[:=]\s*["']?)([^"'\s,\n}]+)/gi,
      (match, prefix, value, offset) => {
        if (value === '[REDACTED]' || value.startsWith('${')) return match
        findings.push({
          file: file.name,
          line: content.slice(0, offset).split('\n').length,
          rule: '常见口令与密钥',
        })
        return `${prefix}[REDACTED]`
      },
    )
    content = content.replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      (_match, offset) => {
        findings.push({
          file: file.name,
          line: content.slice(0, offset).split('\n').length,
          rule: '私钥块',
        })
        return '[REDACTED PRIVATE KEY]'
      },
    )
    content = content.replace(
      /\b(?:ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g,
      (_match, offset) => {
        findings.push({
          file: file.name,
          line: content.slice(0, offset).split('\n').length,
          rule: '常见访问凭据格式',
        })
        return '[REDACTED]'
      },
    )
    for (const rule of rules.filter((item) => item.find)) {
      if (!content.includes(rule.find)) continue
      const count = content.split(rule.find).length - 1
      findings.push({ file: file.name, line: null, rule: '项目自定义替换', count })
      content = content.split(rule.find).join(rule.replace ?? '')
    }
    return { ...file, content }
  })
  return { files: output, findings }
}

export function artifactBlockReason(artifact, state, project) {
  if (artifact.deleted) return '产物已删除'
  const task = state.tasks.find(
    (item) =>
      item.status === 'running' &&
      item.projectId === project.id &&
      item.artifactIds?.includes(artifact.id),
  )
  // 依赖保护适用于私有会话；提示不能暴露任务标题中的私有提示词。
  if (task) return '运行中的任务正在使用此产物，请先等待结束或联系任务发起人。'
  const service = project.services.find(
    (item) =>
      !item.deleted &&
      item.versions?.some(
        (version) =>
          version.artifactId === artifact.id && !version.deleted && version.status !== 'removed',
      ),
  )
  if (service)
    return `服务「${service.name}」的保留版本依赖此产物，请先在服务版本记录中移除该版本。`
  return ''
}

export function descendantIds(documents, id) {
  const ids = new Set([id])
  let changed = true
  while (changed) {
    changed = false
    for (const document of documents) {
      if (ids.has(document.parentId) && !ids.has(document.id)) {
        ids.add(document.id)
        changed = true
      }
    }
  }
  return ids
}

export function documentPath(documents, document) {
  const segments = [document.name]
  let cursor = document
  const seen = new Set([document.id])
  while (cursor.parentId) {
    cursor = documents.find((item) => item.id === cursor.parentId)
    if (!cursor || seen.has(cursor.id)) break
    seen.add(cursor.id)
    segments.unshift(cursor.name)
  }
  return segments.join('/')
}

export function simulatedCommit(seed) {
  let hash = 2166136261
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return Array.from({ length: 5 }, (_, i) =>
    ((hash + Math.imul(i + 1, 2654435761)) >>> 0).toString(16).padStart(8, '0'),
  ).join('')
}
