import assert from "node:assert/strict";
import test from "node:test";

import { isUnsupportedDirectorySyncError } from "../scripts/durable-directory-sync.mjs";

test("Windows ignores only the documented unsupported directory fsync errors", () => {
  for (const code of ["EPERM", "EINVAL", "ENOTSUP"]) {
    assert.equal(isUnsupportedDirectorySyncError({ code, syscall: "fsync" }, "win32"), true);
  }
  assert.equal(
    isUnsupportedDirectorySyncError({ code: "EIO", syscall: "fsync" }, "win32"),
    false,
  );
  assert.equal(
    isUnsupportedDirectorySyncError({ code: "EPERM", syscall: "open" }, "win32"),
    false,
  );
  assert.equal(
    isUnsupportedDirectorySyncError({ code: "EPERM", syscall: "fsync" }, "darwin"),
    false,
  );
});

test("directory sync keeps unsupported Windows fsync narrow and propagates other failures", async () => {
  const calls = [];
  const unsupportedHandle = {
    async sync() {
      calls.push("sync");
      const error = new Error("unsupported");
      error.code = "EPERM";
      error.syscall = "fsync";
      throw error;
    },
    async close() { calls.push("close"); },
  };
  const { syncDirectory } = await import("../scripts/durable-directory-sync.mjs");
  await syncDirectory("fixture", {
    platform: "win32",
    openDirectory: async () => unsupportedHandle,
  });
  assert.deepEqual(calls, ["sync", "close"]);

  const fatal = new Error("disk failed");
  fatal.code = "EIO";
  fatal.syscall = "fsync";
  await assert.rejects(
    syncDirectory("fixture", {
      platform: "win32",
      openDirectory: async () => ({
        async sync() { throw fatal; },
        async close() {},
      }),
    }),
    fatal,
  );
});
