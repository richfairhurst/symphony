export type ShutdownHandler = () => Promise<void> | void;

export function installSignalHandlers(handler: ShutdownHandler): () => void {
  const onSignal = () => {
    void Promise.resolve(handler());
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}
