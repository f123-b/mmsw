import type { IpcMain } from "electron";

/** Ignore late renderer requests once resource teardown has begun. */
export function shutdownAwareIpcHandle(ipc: Pick<IpcMain, "handle">, isShuttingDown: () => boolean): IpcMain["handle"] {
  return (channel, listener) => {
    ipc.handle(channel, (event, ...args) => isShuttingDown() ? undefined : listener(event, ...args));
  };
}
