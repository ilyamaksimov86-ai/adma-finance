const safeError = error => String(error?.message || error || 'storage_remove_failed').slice(0, 1000);

export async function removeStorageObject(db, bucket, objectPath) {
  if (bucket === 'adma-backups') throw new Error('protected_bucket');
  if (!objectPath) return false;
  const path = String(objectPath);
  const { error } = await db.storage.from(bucket).remove([path]);
  if (!error) return false;

  const queued = await db.from('storage_cleanup_queue').insert({
    bucket,
    object_path: path,
    last_error: safeError(error),
    next_attempt_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  if (queued.error && queued.error.code !== '23505') throw queued.error;
  return true;
}
