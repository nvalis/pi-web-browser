import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  browserConnectOptions,
  executableOnPath,
  nativeLinuxChromeArguments,
  selectAutoLaunchMode,
} from "../index.ts";

test("auto-launch selection prefers Windows Chrome under WSL and native Chrome on Linux", () => {
  assert.equal(selectAutoLaunchMode({ disabled: false, wsl: true, platform: "linux" }), "wsl-windows");
  assert.equal(selectAutoLaunchMode({ disabled: false, wsl: false, platform: "linux" }), "native-linux");
  assert.equal(selectAutoLaunchMode({ disabled: false, wsl: false, platform: "darwin" }), undefined);
  assert.equal(selectAutoLaunchMode({ disabled: true, wsl: true, platform: "linux" }), undefined);
});

test("Linux Chrome discovery searches PATH and requires an executable file", async () => {
  const first = await mkdtemp(join(tmpdir(), "pi-browser-path-a-"));
  const second = await mkdtemp(join(tmpdir(), "pi-browser-path-b-"));
  try {
    const executable = join(second, "chromium");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    assert.equal(executableOnPath("chromium", `${first}${delimiter}${second}`), executable);
    assert.equal(executableOnPath("google-chrome", `${first}${delimiter}${second}`), undefined);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

test("native Linux Chrome receives a dedicated profile and opens maximized", () => {
  const args = nativeLinuxChromeArguments("9333", "/tmp/pi-browser-profile");
  assert.ok(args.includes("--remote-debugging-port=9333"));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--user-data-dir=/tmp/pi-browser-profile"));
  assert.ok(args.includes("--start-maximized"));
  assert.ok(!args.some((argument) => argument.startsWith("--window-size=")));
  assert.equal(args.at(-1), "about:blank");
});

test("Puppeteer connection preserves Chrome's native viewport", () => {
  assert.deepEqual(browserConnectOptions("ws://localhost/devtools/browser/test"), {
    browserWSEndpoint: "ws://localhost/devtools/browser/test",
    defaultViewport: null,
  });
});
