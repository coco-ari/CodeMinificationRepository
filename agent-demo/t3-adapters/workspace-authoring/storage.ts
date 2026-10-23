import { openDatabase } from '../../../autoops/server/platform/database.ts'

const migration = {
  version: 1,
  name: 'workspace-authoring',
  sql: `
CREATE TABLE authoring_projects (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE authoring_sources (project_id TEXT NOT NULL REFERENCES authoring_projects(project_id), id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, url TEXT NOT NULL, ref_kind TEXT NOT NULL, ref TEXT NOT NULL, mount_path TEXT NOT NULL, source_path TEXT, credential_id TEXT, PRIMARY KEY(project_id,id), UNIQUE(project_id,mount_path)) STRICT;
CREATE TABLE authoring_blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size>=0)) STRICT;
CREATE TABLE authoring_extractions (hash TEXT NOT NULL REFERENCES authoring_blobs(hash) ON DELETE CASCADE, mime TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','ready','unavailable')), content TEXT, code TEXT, message TEXT, PRIMARY KEY(hash,mime)) STRICT;
CREATE TABLE authoring_entries (project_id TEXT NOT NULL REFERENCES authoring_projects(project_id), path TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','directory')), revision TEXT NOT NULL, updated_at TEXT NOT NULL, hash TEXT REFERENCES authoring_blobs(hash), mime TEXT NOT NULL, PRIMARY KEY(project_id,path), UNIQUE(project_id,id), CHECK((kind='file' AND hash IS NOT NULL) OR (kind='directory' AND hash IS NULL))) STRICT;
CREATE TABLE authoring_receipts (project_id TEXT NOT NULL REFERENCES authoring_projects(project_id), request_id TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,request_id)) STRICT;
CREATE TABLE authoring_captures (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES authoring_projects(project_id), actor_id TEXT NOT NULL, request_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','released')), resolution TEXT NOT NULL CHECK(resolution IN ('pending','resolved','failed')), resolution_error TEXT, resolved_repositories TEXT, UNIQUE(project_id,request_id)) STRICT;
CREATE TABLE authoring_capture_sources (capture_id TEXT NOT NULL REFERENCES authoring_captures(id), source_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, url TEXT NOT NULL, ref_kind TEXT NOT NULL, ref TEXT NOT NULL, mount_path TEXT NOT NULL, source_path TEXT, credential_id TEXT, PRIMARY KEY(capture_id,source_id)) STRICT;
CREATE TABLE authoring_capture_files (capture_id TEXT NOT NULL REFERENCES authoring_captures(id), path TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, PRIMARY KEY(capture_id,path)) STRICT;
CREATE TABLE authoring_capture_directories (capture_id TEXT NOT NULL REFERENCES authoring_captures(id), path TEXT NOT NULL, PRIMARY KEY(capture_id,path)) STRICT;
CREATE INDEX authoring_entries_hash ON authoring_entries(hash);
CREATE INDEX authoring_capture_files_hash ON authoring_capture_files(hash);
`,
}
export const openAuthoringDatabase = (filename: string) => openDatabase(filename, [migration])
