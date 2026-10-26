// 资料引用归属业务授权模块；这里只保存来源身份，运行与命令结果仍以 T3 为准。
export function initializeInputLifecycleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS t3_input_reference_claims (
      thread_id TEXT NOT NULL, input_id TEXT NOT NULL, command_id TEXT NOT NULL,
      input_owner_id TEXT NOT NULL, caller_id TEXT NOT NULL, kind TEXT NOT NULL,
      message_id TEXT, run_id TEXT, source_thread_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(thread_id,input_id,command_id)
    );
    CREATE INDEX IF NOT EXISTS t3_input_reference_claims_input ON t3_input_reference_claims(input_id);
    CREATE INDEX IF NOT EXISTS t3_thread_input_references_input ON t3_thread_input_references(input_id);
    CREATE TABLE IF NOT EXISTS t3_run_input_requests (
      thread_id TEXT NOT NULL,run_id TEXT NOT NULL,project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,actor_id TEXT NOT NULL,workspace_type TEXT NOT NULL,
      input_id TEXT,created_at TEXT NOT NULL,PRIMARY KEY(thread_id,run_id)
    );
    CREATE INDEX IF NOT EXISTS t3_run_input_requests_input ON t3_run_input_requests(project_id,input_id);
    CREATE INDEX IF NOT EXISTS t3_run_input_requests_request ON t3_run_input_requests(project_id,request_id,actor_id);
    CREATE TABLE IF NOT EXISTS t3_native_input_turns (
      thread_id TEXT NOT NULL,provider_turn_id TEXT NOT NULL,project_id TEXT NOT NULL,
      input_id TEXT NOT NULL,input_owner_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,PRIMARY KEY(thread_id,provider_turn_id)
    );
    CREATE INDEX IF NOT EXISTS t3_native_input_turns_input ON t3_native_input_turns(project_id,input_id);
    CREATE TABLE IF NOT EXISTS t3_workspace_version_resource_releases (
      thread_id TEXT PRIMARY KEY,version_id TEXT NOT NULL,sequence INTEGER NOT NULL,created_at TEXT NOT NULL
    );
  `)
}

export function createAccessInputLifecycle({ db, fail, identifier, now }) {
  const maximumReferences = 1000
  let savepoint = 0
  const write = (operation) => {
    const nested = db.isTransaction,
      name = `autoops_input_lifecycle_${++savepoint}`
    db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE')
    try {
      const result = operation()
      if (result && typeof result.then === 'function')
        throw new Error('资料引用事务不能包含异步操作')
      db.exec(nested ? `RELEASE ${name}` : 'COMMIT')
      return result
    } catch (error) {
      db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK')
      throw error
    }
  }
  function inputResourceSnapshot(projectId, inputId) {
    identifier(projectId, '项目ID')
    identifier(inputId, '资料输入ID')
    const rows = db
      .prepare(
        `SELECT i.*,b.project_id,b.environment_id,b.workspace_type,b.native_thread_id,n.parent_thread_id
      FROM t3_thread_inputs i JOIN t3_thread_bindings b ON b.thread_id=i.thread_id
      LEFT JOIN t3_native_subagent_bindings n ON n.child_thread_id=i.thread_id
      WHERE b.project_id=? AND i.input_id=? ORDER BY i.thread_id,i.run_id LIMIT ?`,
      )
      .all(projectId, inputId, maximumReferences + 1)
    const references = db
      .prepare(
        `SELECT r.*,b.project_id,b.workspace_type,b.native_thread_id,n.parent_thread_id
      FROM t3_thread_input_references r JOIN t3_thread_bindings b ON b.thread_id=r.thread_id
      LEFT JOIN t3_native_subagent_bindings n ON n.child_thread_id=r.thread_id
      WHERE b.project_id=? AND r.input_id=? ORDER BY r.thread_id LIMIT ?`,
      )
      .all(projectId, inputId, maximumReferences + 1)
    const claims = db
      .prepare(
        `SELECT c.* FROM t3_input_reference_claims c JOIN t3_thread_bindings b ON b.thread_id=c.thread_id
      WHERE b.project_id=? AND c.input_id=? ORDER BY c.thread_id,c.command_id LIMIT ?`,
      )
      .all(projectId, inputId, maximumReferences + 1)
    const origins = db
      .prepare(
        'SELECT * FROM t3_run_input_requests WHERE project_id=? AND input_id=? ORDER BY thread_id,run_id LIMIT ?',
      )
      .all(projectId, inputId, maximumReferences + 1)
    const nativeTurns = db
      .prepare(
        'SELECT * FROM t3_native_input_turns WHERE project_id=? AND input_id=? ORDER BY thread_id,provider_turn_id LIMIT ?',
      )
      .all(projectId, inputId, maximumReferences + 1)
    return {
      projectId,
      inputId,
      truncated:
        rows.length > maximumReferences ||
        references.length > maximumReferences ||
        claims.length > maximumReferences ||
        origins.length > maximumReferences ||
        nativeTurns.length > maximumReferences,
      nativeTurns: nativeTurns
        .slice(0, maximumReferences)
        .map((row) => ({
          threadId: row.thread_id,
          providerTurnId: row.provider_turn_id,
          projectId: row.project_id,
          inputId: row.input_id,
          inputOwnerId: row.input_owner_id,
          actorId: row.actor_id,
          createdAt: row.created_at,
        })),
      origins: origins
        .slice(0, maximumReferences)
        .map((row) => ({
          threadId: row.thread_id,
          runId: row.run_id,
          projectId: row.project_id,
          requestId: row.request_id,
          actorId: row.actor_id,
          workspaceType: row.workspace_type,
          inputId: row.input_id,
          createdAt: row.created_at,
        })),
      runs: rows
        .slice(0, maximumReferences)
        .map((row) => ({
          threadId: row.thread_id,
          runId: row.run_id,
          inputId: row.input_id,
          actorId: row.actor_id,
          inputOwnerId: row.input_owner_id,
          actorVerified: Boolean(row.actor_verified),
          createdAt: row.created_at,
          projectId: row.project_id,
          environmentId: row.environment_id || null,
          workspaceType: row.workspace_type || 'internal',
          nativeThreadId: row.native_thread_id || null,
          parentThreadId: row.parent_thread_id || null,
        })),
      references: references
        .slice(0, maximumReferences)
        .map((row) => ({
          threadId: row.thread_id,
          inputId: row.input_id,
          inputOwnerId: row.actor_id,
          createdAt: row.created_at,
          workspaceType: row.workspace_type || 'internal',
          nativeThreadId: row.native_thread_id || null,
          parentThreadId: row.parent_thread_id || null,
        })),
      claims: claims
        .slice(0, maximumReferences)
        .map((row) => ({
          threadId: row.thread_id,
          inputId: row.input_id,
          commandId: row.command_id,
          inputOwnerId: row.input_owner_id,
          callerId: row.caller_id,
          kind: row.kind,
          messageId: row.message_id,
          runId: row.run_id,
          sourceThreadId: row.source_thread_id,
          createdAt: row.created_at,
        })),
    }
  }
  function workspaceVersionResourceSnapshot(threadId) {
    identifier(threadId, '会话ID')
    const binding = db
      .prepare(
        'SELECT thread_id,project_id,workspace_version_id,scope_state,submission_command_id,native_thread_id FROM t3_thread_bindings WHERE thread_id=? AND workspace_version_id IS NOT NULL',
      )
      .get(threadId)
    if (!binding) return null
    const commands = db
      .prepare(
        `SELECT command_id,message_id AS target_id,'message' AS kind,actor_id FROM t3_message_actors WHERE thread_id=?
      UNION ALL SELECT command_id,target_id,kind,actor_id FROM t3_request_actors WHERE thread_id=? ORDER BY command_id LIMIT ?`,
      )
      .all(threadId, threadId, maximumReferences + 1)
    return {
      threadId: binding.thread_id,
      projectId: binding.project_id,
      versionId: binding.workspace_version_id,
      scopeState: binding.scope_state,
      submissionCommandId: binding.submission_command_id,
      nativeThreadId: binding.native_thread_id,
      truncated: commands.length > maximumReferences,
      commands: commands
        .slice(0, maximumReferences)
        .map((row) => ({
          commandId: row.command_id,
          targetId: row.target_id,
          kind: row.kind,
          actorId: row.actor_id,
        })),
    }
  }
  return {
    workspaceVersionResourceSnapshot,
    releaseWorkspaceVersionResource(snapshot, sequence, operation) {
      if (!Number.isSafeInteger(sequence) || sequence < 1)
        fail(400, 'THREAD_NATIVE_SOURCE_INVALID', '原生持久事件位置无效')
      return write(() => {
        const current = workspaceVersionResourceSnapshot(snapshot.threadId)
        if (!current || current.truncated || JSON.stringify(current) !== JSON.stringify(snapshot))
          return false
        db.prepare(
          'INSERT INTO t3_workspace_version_resource_releases VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET version_id=excluded.version_id,sequence=excluded.sequence,created_at=excluded.created_at',
        ).run(current.threadId, current.versionId, sequence, new Date(now()).toISOString())
        const result = operation()
        if (result && typeof result.then === 'function')
          throw new Error('资料引用事务不能包含异步操作')
        return true
      })
    },
    armWorkspaceVersionResource(threadId) {
      db.prepare('DELETE FROM t3_workspace_version_resource_releases WHERE thread_id=?').run(
        identifier(threadId, '会话ID'),
      )
    },
    recordNativeInputTurn(threadId, providerTurnId, projectId, inputId, inputOwnerId, actorId) {
      for (const value of [threadId, providerTurnId, projectId, inputId, inputOwnerId, actorId])
        identifier(value, '原生子轮资料身份')
      return write(() => {
        db.prepare(
          'INSERT INTO t3_native_input_turns VALUES(?,?,?,?,?,?,?) ON CONFLICT(thread_id,provider_turn_id) DO NOTHING',
        ).run(
          threadId,
          providerTurnId,
          projectId,
          inputId,
          inputOwnerId,
          actorId,
          new Date(now()).toISOString(),
        )
        const row = db
          .prepare('SELECT * FROM t3_native_input_turns WHERE thread_id=? AND provider_turn_id=?')
          .get(threadId, providerTurnId)
        if (
          row.project_id !== projectId ||
          row.input_id !== inputId ||
          row.input_owner_id !== inputOwnerId ||
          row.actor_id !== actorId
        )
          fail(409, 'THREAD_INPUT_TURN_CONFLICT', '原生子轮已经固定其他输入或调用者')
      })
    },
    recordRunInputRequest(threadId, runId, projectId, requestId, actorId, workspaceType) {
      for (const value of [threadId, runId, projectId, requestId, actorId])
        identifier(value, '资料准备身份')
      if (!['internal', 'external'].includes(workspaceType))
        fail(400, 'THREAD_INPUT_SCOPE_INVALID', '资料准备范围无效')
      return write(() => {
        const inserted = db
          .prepare(
            'INSERT INTO t3_run_input_requests VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(thread_id,run_id) DO NOTHING',
          )
          .run(
            threadId,
            runId,
            projectId,
            requestId,
            actorId,
            workspaceType,
            new Date(now()).toISOString(),
          )
        const row = db
          .prepare('SELECT * FROM t3_run_input_requests WHERE thread_id=? AND run_id=?')
          .get(threadId, runId)
        if (
          row.project_id !== projectId ||
          row.request_id !== requestId ||
          row.actor_id !== actorId ||
          row.workspace_type !== workspaceType
        )
          fail(409, 'THREAD_INPUT_REQUEST_CONFLICT', '原任务已经固定其他资料准备身份')
        return Number(inserted.changes) === 1
      })
    },
    completeRunInputRequest(origin, inputId) {
      identifier(inputId, '资料输入ID')
      return write(() => {
        const row = db
          .prepare('SELECT * FROM t3_run_input_requests WHERE thread_id=? AND run_id=?')
          .get(origin.threadId, origin.runId)
        if (
          !row ||
          row.project_id !== origin.projectId ||
          row.request_id !== origin.requestId ||
          row.actor_id !== origin.actorId ||
          row.workspace_type !== origin.workspaceType ||
          (row.input_id && row.input_id !== inputId)
        )
          fail(409, 'THREAD_INPUT_REQUEST_CONFLICT', '原任务的资料准备身份无法核验')
        db.prepare(
          'UPDATE t3_run_input_requests SET input_id=? WHERE thread_id=? AND run_id=?',
        ).run(inputId, origin.threadId, origin.runId)
      })
    },
    inputPreparationCandidates(threadId) {
      identifier(threadId, '会话ID')
      const rows = db
        .prepare(
          'SELECT * FROM t3_run_input_requests WHERE thread_id=? AND input_id IS NULL ORDER BY run_id LIMIT ?',
        )
        .all(threadId, maximumReferences + 1)
      if (rows.length > maximumReferences)
        fail(409, 'THREAD_INPUT_REFERENCE_LIMIT', '资料准备记录过多，继续保留原资料')
      return rows.map((row) => ({
        threadId: row.thread_id,
        runId: row.run_id,
        projectId: row.project_id,
        requestId: row.request_id,
        actorId: row.actor_id,
        workspaceType: row.workspace_type,
      }))
    },
    inputRequestThreads(projectId, requestId, actorId) {
      for (const value of [projectId, requestId, actorId]) identifier(value, '资料准备身份')
      const rows = db
        .prepare(
          'SELECT DISTINCT thread_id FROM t3_run_input_requests WHERE project_id=? AND request_id=? AND actor_id=? LIMIT ?',
        )
        .all(projectId, requestId, actorId, maximumReferences + 1)
      if (rows.length > maximumReferences)
        fail(409, 'THREAD_INPUT_REFERENCE_LIMIT', '资料准备记录过多，继续保留原资料')
      return rows.map((row) => row.thread_id)
    },
    inputResourceCandidates(threadId) {
      identifier(threadId, '会话ID')
      const rows = db
        .prepare(
          `SELECT DISTINCT b.project_id,i.input_id,i.input_owner_id FROM t3_thread_inputs i JOIN t3_thread_bindings b ON b.thread_id=i.thread_id WHERE i.thread_id=?
        UNION SELECT b.project_id,r.input_id,r.actor_id FROM t3_thread_input_references r JOIN t3_thread_bindings b ON b.thread_id=r.thread_id WHERE r.thread_id=?
        UNION SELECT project_id,input_id,actor_id FROM t3_run_input_requests WHERE thread_id=? AND input_id IS NOT NULL LIMIT ?`,
        )
        .all(threadId, threadId, threadId, maximumReferences + 1)
      if (rows.length > maximumReferences)
        fail(409, 'THREAD_INPUT_REFERENCE_LIMIT', '会话资料引用过多，继续保留原资料')
      return rows.map((row) => ({
        projectId: row.project_id,
        inputId: row.input_id,
        inputOwnerId: row.input_owner_id,
      }))
    },
    inputResourceSnapshot,
    withInputResourceSnapshot(snapshot, operation) {
      return write(() => {
        const current = inputResourceSnapshot(snapshot.projectId, snapshot.inputId)
        if (current.truncated || JSON.stringify(current) !== JSON.stringify(snapshot)) return false
        return operation()
      })
    },
    retainReference(threadId, inputId, inputOwnerId, callerId, claim) {
      for (const [value, label] of [
        [threadId, '会话ID'],
        [inputId, '资料输入ID'],
        [inputOwnerId, '资料所有者ID'],
        [callerId, '调用者ID'],
      ])
        identifier(value, label)
      return write(() => {
        const previous = db
          .prepare(
            'SELECT actor_id FROM t3_thread_input_references WHERE thread_id=? AND input_id=?',
          )
          .get(threadId, inputId)
        if (previous && previous.actor_id !== inputOwnerId)
          fail(409, 'THREAD_INPUT_OWNER_CONFLICT', '引用已固定其他资料所有者')
        db.prepare(
          'INSERT INTO t3_thread_input_references VALUES(?,?,?,?) ON CONFLICT(thread_id,input_id) DO NOTHING',
        ).run(threadId, inputId, inputOwnerId, new Date(now()).toISOString())
        if (!claim) return
        identifier(claim.commandId, '命令ID')
        if (!['context', 'fork'].includes(claim.kind))
          fail(400, 'THREAD_INPUT_CLAIM_INVALID', '资料引用来源无效')
        for (const [value, label] of [
          [claim.messageId, '消息ID'],
          [claim.runId, '任务ID'],
          [claim.sourceThreadId, '来源会话ID'],
        ])
          if (value !== undefined) identifier(value, label)
        const identity = {
          inputOwnerId,
          callerId,
          kind: claim.kind,
          messageId: claim.messageId ?? null,
          runId: claim.runId ?? null,
          sourceThreadId: claim.sourceThreadId ?? null,
        }
        const stored = db
          .prepare(
            'SELECT * FROM t3_input_reference_claims WHERE thread_id=? AND input_id=? AND command_id=?',
          )
          .get(threadId, inputId, claim.commandId)
        if (
          stored &&
          JSON.stringify(identity) !==
            JSON.stringify({
              inputOwnerId: stored.input_owner_id,
              callerId: stored.caller_id,
              kind: stored.kind,
              messageId: stored.message_id,
              runId: stored.run_id,
              sourceThreadId: stored.source_thread_id,
            })
        )
          fail(409, 'THREAD_INPUT_CLAIM_CONFLICT', '原命令已固定其他资料引用身份')
        db.prepare(
          'INSERT INTO t3_input_reference_claims VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,input_id,command_id) DO NOTHING',
        ).run(
          threadId,
          inputId,
          claim.commandId,
          inputOwnerId,
          callerId,
          claim.kind,
          identity.messageId,
          identity.runId,
          identity.sourceThreadId,
          new Date(now()).toISOString(),
        )
      })
    },
  }
}
