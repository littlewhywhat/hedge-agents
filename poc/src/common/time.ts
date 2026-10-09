export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
};

export const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const log = (role: string, message: string): void => {
  console.log(`${new Date().toISOString()} [${role}] ${message}`);
};
