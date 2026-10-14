// All save callers share one worker, including multi-file uploads and autosave.
export function createSaveQueue({ isDirty, snapshot, write, commit, onError }) {
  let worker = null;
  return function save() {
    if (worker) return worker;
    if (!isDirty()) return Promise.resolve();
    worker = (async () => {
      while (isDirty()) {
        const value = snapshot();
        const result = await write(value);
        commit(value, result);
      }
    })()
      .catch((error) => {
        onError(error);
        throw error;
      })
      .finally(() => {
        worker = null;
      });
    return worker;
  };
}
