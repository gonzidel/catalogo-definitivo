// ADVERTENCIA: este mutex es in-memory y protege la correlatividad ÚNICAMENTE
// si el backend corre como una sola instancia Node.js.
// NO escalar a múltiples instancias/contenedores sin mover el lock a algo
// compartido entre procesos (advisory lock de Postgres o Redis).
// Para el volumen actual (panel interno de despacho) una sola instancia es suficiente.
const locks = new Map<string, Promise<void>>();

export function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let releaseFn!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  locks.set(key, next);
  return prev.then(() => fn()).finally(() => {
    releaseFn();
  });
}
