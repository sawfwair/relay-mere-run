/** Serialize admission across external quota/storage checks within an account. */
const admissions = new WeakMap<DurableObjectStorage, Promise<unknown>>();

export async function withGraphAdmission<T>(storage: DurableObjectStorage, operation: () => Promise<T>): Promise<T> {
  const previous = admissions.get(storage) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  admissions.set(storage, current);
  try {
    return await current;
  } finally {
    if (admissions.get(storage) === current) admissions.delete(storage);
  }
}
