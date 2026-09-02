import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "./database";
import { shutdownAwareIpcHandle } from "./ipc-lifecycle";

describe("renderer requests during shutdown", () => {
  it("serves live history but never accesses SQLite after teardown starts", async () => {
    const db = await SqliteDatabase.open(":memory:");
    let shuttingDown = false;
    let callback: Parameters<IpcMain["handle"]>[1] | undefined;
    const handle = shutdownAwareIpcHandle({ handle: (_channel, listener) => { callback = listener; } }, () => shuttingDown);
    handle("history:list", (_event, limit: number) => db.all("SELECT name FROM sqlite_master LIMIT ?", [limit]));
    const event = {} as IpcMainInvokeEvent;
    expect(callback!(event, 2)).toHaveLength(2);
    shuttingDown = true;
    db.close();
    expect(() => callback!(event, 2)).not.toThrow();
    expect(callback!(event, 2)).toBeUndefined();
  });
});
