import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openDatabase } from '../server/platform/database.ts'

test(
  '并发打开先等待真实独占锁，再校验和升级既有数据库且保留原数据',
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'autoops-database-open-'))
    const filename = join(directory, 'state.sqlite')
    let waitForChild: Promise<number | null> | undefined
    t.after(async () => {
      await waitForChild?.catch(() => {})
      await rm(directory, { recursive: true, force: true })
    })
    const first = {
      version: 1,
      name: '已有数据',
      sql: "CREATE TABLE items(id TEXT PRIMARY KEY); INSERT INTO items VALUES('existing');",
    }
    openDatabase(filename, [first]).close()
    // 子进程真实持有短时独占锁；父进程同步打开时不能依靠本进程计时器释放它。
    const script = `
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA locking_mode=EXCLUSIVE;BEGIN EXCLUSIVE;INSERT INTO items VALUES('locked-writer')");
    process.send('locked');
    setTimeout(()=>{db.exec('COMMIT');db.close();process.disconnect()},300);
  `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, filename], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr?.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-16_384)
    })
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    waitForChild = finished
    const locked = new Promise<void>((resolve) => {
      child.once('message', (message: unknown) => {
        if (message === 'locked') resolve()
      })
    })
    await Promise.race([locked, finished.then(() => assert.fail(`子进程未取得独占锁：${stderr}`))])
    const storage = openDatabase(filename, [
      first,
      {
        version: 2,
        name: '保留原件升级',
        sql: 'ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;',
      },
    ])
    try {
      assert.deepEqual(
        storage.db
          .prepare('SELECT id,revision FROM items ORDER BY id')
          .all()
          .map((row) => ({ ...row })),
        [
          { id: 'existing', revision: 1 },
          { id: 'locked-writer', revision: 1 },
        ],
      )
      assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, 2)
    } finally {
      storage.close()
    }
    assert.equal(await finished, 0, stderr)
  },
)
