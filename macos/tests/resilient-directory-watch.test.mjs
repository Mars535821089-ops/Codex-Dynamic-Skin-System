import assert from "node:assert/strict";
import test from "node:test";

function createWatcherHarness() {
  const created = [];
  const timers = [];
  const errors = [];
  const watchDirectory = (_directory, _options, listener) => {
    const handlers = new Map();
    const watcher = {
      listener,
      closed: false,
      on(name, handler) { handlers.set(name, handler); },
      close() {
        if (this.closed) return;
        this.closed = true;
        handlers.get("close")?.();
      },
      drop() {
        this.closed = true;
        handlers.get("close")?.();
      },
      fail(error) { handlers.get("error")?.(error); },
    };
    created.push(watcher);
    return watcher;
  };
  const timerOptions = {
    setTimer: (callback, delay) => {
      timers.push({ callback, delay, cleared: false });
      return timers.at(-1);
    },
    clearTimer: (timer) => { timer.cleared = true; },
  };
  return { created, timers, errors, watchDirectory, timerOptions };
}

test("a silently closed directory watcher is replaced exactly once", async () => {
  const { createResilientDirectoryWatch } = await import(
    `../scripts/resilient-directory-watch.mjs?test=${Date.now()}-silent-close`
  );
  const { created, timers, errors, watchDirectory, timerOptions } = createWatcherHarness();
  const watch = createResilientDirectoryWatch({
    directory: "/fixture/theme",
    onEvent: () => {},
    onError: (error) => errors.push(error.message),
    watchDirectory,
    ...timerOptions,
    retryMs: 750,
  });

  created[0].drop();
  created[0].drop();

  assert.equal(timers.length, 1);
  assert.deepEqual(errors, []);
  timers[0].callback();
  assert.equal(created.length, 2);
  watch.close();
});

test("error followed by close schedules only one replacement", async () => {
  const { createResilientDirectoryWatch } = await import(
    `../scripts/resilient-directory-watch.mjs?test=${Date.now()}-error-close`
  );
  const { created, timers, errors, watchDirectory, timerOptions } = createWatcherHarness();
  const watch = createResilientDirectoryWatch({
    directory: "/fixture/theme",
    onEvent: () => {},
    onError: (error) => errors.push(error.message),
    watchDirectory,
    ...timerOptions,
    retryMs: 750,
  });

  created[0].fail(new Error("directory replaced"));

  assert.equal(created[0].closed, true);
  assert.equal(timers.length, 1);
  assert.deepEqual(errors, ["directory replaced"]);
  timers[0].callback();
  assert.equal(created.length, 2);
  watch.close();
});

test("explicit wrapper close cancels recovery and never restarts", async () => {
  const { createResilientDirectoryWatch } = await import(
    `../scripts/resilient-directory-watch.mjs?test=${Date.now()}-explicit-close`
  );
  const { created, timers, watchDirectory, timerOptions } = createWatcherHarness();
  const watch = createResilientDirectoryWatch({
    directory: "/fixture/theme",
    onEvent: () => {},
    watchDirectory,
    ...timerOptions,
    retryMs: 750,
  });

  created[0].drop();
  assert.equal(timers.length, 1);

  watch.close();
  assert.equal(timers[0].cleared, true);
  timers[0].callback();
  assert.equal(created.length, 1);
});

test("recursive catalog watches forward the recursive filesystem option", async () => {
  const { createResilientDirectoryWatch } = await import(
    `../scripts/resilient-directory-watch.mjs?test=${Date.now()}-recursive`
  );
  let receivedOptions;
  const watcher = {
    on() {},
    close() {},
  };
  const watch = createResilientDirectoryWatch({
    directory: "/fixture/catalog",
    recursive: true,
    onEvent: () => {},
    watchDirectory: (_directory, options) => {
      receivedOptions = options;
      return watcher;
    },
  });

  assert.deepEqual(receivedOptions, { persistent: false, recursive: true });
  watch.close();
});
