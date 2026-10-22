// @effect-diagnostics nodeBuiltinImport:off
/** Offline migration entry. Only the EventSink/persistence layers run; never provider/worker layers. */
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  ChatAttachment,
  OrchestrationV2DomainEventJson,
  ApplicationProjectEvent,
} from '@t3tools/contracts'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { join } from 'node:path'
import {
  importLegacySnapshot,
  type LegacyImportOptions,
  type NativeImportInput,
} from '../../../../../../agent-demo/migrations/t3-import-data.mjs'
import {
  attachmentRelativePath,
  createDeterministicAttachmentId,
  attachmentFileExtension,
} from '../attachmentStore.ts'
import * as SqlitePersistence from '../persistence/Sqlite.ts'
import * as RuntimeLayer from '../orchestration-v2/runtimeLayer.ts'
import * as EventSink from '../orchestration-v2/EventSink.ts'

export async function writeCanonicalLegacyEvents(input: NativeImportInput): Promise<void> {
  // Validate the entire batch before any event writes. DateTimeUtcFromString
  // decodes ISO timestamps to native Effect DateTime, matching upstream importer.
  const batches = input.threads.map((thread) => ({
    threadId: thread.threadId,
    events: thread.events.map((event) =>
      Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)(event),
    ),
  }))
  const database = SqlitePersistence.layerFromPath(input.dbPath)
  const layer = Layer.merge(RuntimeLayer.layerEventSink, database).pipe(
    Layer.provide(database),
    Layer.provide(NodeServices.layer),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2
      for (const project of input.projects) {
        const commandId = CommandId.make(`autoops:legacy:project:${project.id}`)
        const parsed = yield* Schema.decodeUnknownEffect(ApplicationProjectEvent)({
          sequence: 0,
          eventId: EventId.make(`autoops:legacy:project:${project.id}`),
          aggregateKind: 'project',
          aggregateId: project.id,
          occurredAt: input.createdAt,
          commandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: 'project.created',
          payload: {
            projectId: project.id,
            title: project.name,
            workspaceRoot: join(input.targetDirectory, 't3/workspaces', project.id),
            defaultModelSelection: { instanceId: 'codex', model: input.model },
            scripts: [],
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        })
        const { sequence: _sequence, ...event } = parsed
        yield* sink.commitProjectCommand({
          commandId,
          projectId: ProjectId.make(project.id),
          commandType: 'project.create',
          acceptedAt: DateTime.makeUnsafe(input.createdAt),
          event,
        })
      }
      for (const batch of batches)
        for (let offset = 0; offset < batch.events.length; offset += 100) {
          yield* sink.write({ events: batch.events.slice(offset, offset + 100) })
        }
      const sql = yield* SqlClient.SqlClient
      // No imported record may enqueue a native effect or run without an explicit
      // resume action. This assertion also catches upstream contract changes.
      const pending = yield* sql<{
        count: number
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`
      if ((pending[0]?.count ?? 0) !== 0)
        return yield* Effect.die(new Error('Migration unexpectedly created provider effects'))
      yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)')
    }).pipe(Effect.provide(layer)),
  )
}

export function importLegacyToT3(options: LegacyImportOptions) {
  return importLegacySnapshot(options, {
    providerThreadId: (nativeThreadId) =>
      IdAllocator.derive.providerThread({
        driver: ProviderDriverKind.make('codex'),
        providerInstanceId: ProviderInstanceId.make('codex'),
        nativeThreadId,
      }),
    runId: (threadId, ordinal) =>
      IdAllocator.derive.run({ threadId: ThreadId.make(threadId), ordinal }),
    attachment: (input) => {
      const id = createDeterministicAttachmentId(input.threadId, input.stableKey, input.mime.startsWith('image/') ? undefined : attachmentFileExtension(input.name))
      if (!id) throw new Error('Cannot create native attachment ID')
      const attachment = Schema.decodeUnknownSync(ChatAttachment)({
        type: input.mime.startsWith('image/')
          ? 'image'
          : input.size === 0
            ? 'legacy-empty-file'
            : 'file',
        id,
        name: input.name,
        mimeType: input.mime,
        sizeBytes: input.size,
      })
      const relativePath =
        attachmentRelativePath(attachment) ?? `${id}${attachmentFileExtension(input.name)}`
      return { attachment, relativePath }
    },
    write: writeCanonicalLegacyEvents,
  })
}

export async function runLegacyImportCli(args: readonly string[]) {
  const options: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1]
    if (
      !key ||
      !['--snapshot', '--target', '--model', '--restored-codex-home'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options[key]
    )
      throw new Error(
        'Usage: legacyImport --snapshot DIR --target NEW_DATA_DIR --model MODEL [--restored-codex-home DIR]',
      )
    options[key] = value
  }
  if (!options['--snapshot'] || !options['--target'] || !options['--model'])
    throw new Error('snapshot, target and model are required')
  const report = await importLegacyToT3({
    snapshot: options['--snapshot'],
    target: options['--target'],
    model: options['--model'],
    ...(options['--restored-codex-home']
      ? { restoredCodexHome: options['--restored-codex-home'] }
      : {}),
  })
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}
