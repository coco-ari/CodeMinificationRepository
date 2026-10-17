export const DEFAULT_STORAGE_POLICY = Object.freeze({ revision: 1, retainedVersions: 2, buildCacheGiB: 2 });

export function storagePolicy(input = DEFAULT_STORAGE_POLICY) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('存储策略格式错误');
  const { revision = 1, retainedVersions, buildCacheGiB } = input;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('存储策略版本无效');
  if (!Number.isInteger(retainedVersions) || retainedVersions < 2 || retainedVersions > 20) throw new Error('本机保留数量必须为 2–20 个成功节点');
  if (!Number.isInteger(buildCacheGiB) || buildCacheGiB < 1 || buildCacheGiB > 20) throw new Error('Docker 构建缓存额度必须为 1–20 GiB');
  return { revision, retainedVersions, buildCacheGiB };
}

export function artifactId(release) { return release.artifactId || release.id; }
