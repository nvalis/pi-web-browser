import assert from "node:assert/strict";
import test from "node:test";
import {
  READ_ONLY_EVALUATE_OPTIONS,
  SerialQueue,
  actionDestination,
  assertScreenshotAllowed,
  blockSensitiveResearchAction,
  classifyElementAction,
  enforceAutonomousResearchRisk,
  installRequiredCapability,
  requireActionCapabilities,
  runAbortable,
  scrubOutputValue,
  scrubSensitiveOutput,
  validateObservationGeneration,
  waitForActionSettlement,
  waitForSharedOperation,
} from "../src/core.ts";
import { inspectElementHandle, waitForPageQuiet } from "../src/page-content.ts";

const riskyLabels = [
  ["Like", "representational"],
  ["Reply", "representational"],
  ["Erase all data", "destructive"],
  ["Transfer funds", "financial"],
  ["Install extension", "permission/download"],
  ["I am not a robot", "CAPTCHA"],
  ["Do the thing", "unclassified control"],
] as const;

for (const [label, family] of riskyLabels) {
  test(`classifier recognizes ${family} action: ${label}`, () => {
    const result = classifyElementAction({ tag: "button", label });
    assert.equal(result.confirmationRequired, true);
    assert.ok(result.reason);
  });
}

test("autonomous research blocks known side effects without prompting", () => {
  const risk = classifyElementAction({ tag: "button", label: "Delete account" });
  assert.throws(() => enforceAutonomousResearchRisk(risk), /Blocked by autonomous research policy/);
});

test("autonomous research allows unfamiliar controls and source downloads without prompting", () => {
  assert.doesNotThrow(() => enforceAutonomousResearchRisk(classifyElementAction({ tag: "button", label: "Do the thing" })));
  assert.doesNotThrow(() => enforceAutonomousResearchRisk({
    confirmationRequired: true,
    action: "navigate to downloadable content",
    reason: "navigation may start a file download",
  }));
});

test("autonomous research blocks sensitive transmission without exposing the value", () => {
  assert.throws(
    () => blockSensitiveResearchAction("type into input", "authentication secret"),
    /would transmit authentication secret/,
  );
});

test("metadata extraction prefers a submitter formAction override", async () => {
  const previousAnchor = (globalThis as any).HTMLAnchorElement;
  (globalThis as any).HTMLAnchorElement = class HTMLAnchorElement {};
  try {
    const node = {
      tagName: "BUTTON",
      type: "submit",
      formAction: "https://payments.example/override",
      form: { action: "https://shop.example/default", method: "post" },
      labels: undefined,
      placeholder: "",
      innerText: "Pay now",
      textContent: "Pay now",
      getAttribute(name: string) {
        return ({ type: "submit", formaction: "/override", role: null, name: "payment" } as Record<string, string | null>)[name] ?? null;
      },
    };
    const handle = { evaluate: async (callback: (element: unknown) => unknown) => callback(node) };
    const metadata = await inspectElementHandle(handle as any);
    assert.equal(metadata.formAction, "https://payments.example/override");
    assert.equal(metadata.formMethod, "post");
  } finally {
    (globalThis as any).HTMLAnchorElement = previousAnchor;
  }
});

test("actual link and cross-origin form destinations override current page", () => {
  assert.equal(
    actionDestination({ tag: "a", label: "Pay", href: "https://pay.example/checkout?token=secret" }, "https://shop.example/cart"),
    "https://pay.example/checkout",
  );
  assert.equal(
    actionDestination({ tag: "button", label: "Submit", formAction: "https://api.example/orders", formMethod: "post" }, "https://shop.example/cart", true),
    "https://api.example/orders",
  );
});

test("central scrubber removes page and evaluation secrets plus remembered values", () => {
  const token = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
  const privateKey = `-----BEGIN PRIVATE ${"KEY"}-----\nabc123\n-----END PRIVATE ${"KEY"}-----`;
  const remembered = "typed-super-secret";
  const pageOutput = scrubSensitiveOutput(`page ${token} ${privateKey} ${remembered}`, [remembered]);
  assert.doesNotMatch(pageOutput, /ghp_|abc123|typed-super-secret/);
  const evalDetails = scrubOutputValue({ result: `Bearer abcdefghijklmnop ${token}` });
  assert.doesNotMatch(JSON.stringify(evalDetails), /abcdefghijklmnop|ghp_/);
});

for (const operationName of ["click", "type", "read evaluation"] as const) {
  test(`active ${operationName} abort waits for cancellation and operation settlement`, async () => {
    const controller = new AbortController();
    let settleOperation!: () => void;
    let settleCancellation!: () => void;
    let cancellationStarted = false;
    const operation = new Promise<void>((resolve) => { settleOperation = resolve; });
    const cancellation = new Promise<void>((resolve) => { settleCancellation = resolve; });
    let finished = false;
    const result = runAbortable(operation, controller.signal, async () => {
      cancellationStarted = true;
      await cancellation;
    }).finally(() => { finished = true; });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancellationStarted, true);
    assert.equal(finished, false);
    settleOperation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "must await cancellation acknowledgement");
    settleCancellation();
    await assert.rejects(result, { name: "AbortError" });
  });
}

test("aborted navigation retains the tab queue until stop and goto settle", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  const events: string[] = [];
  let settleGoto!: () => void;
  let acknowledgeStop!: () => void;
  const goto = new Promise<void>((resolve) => { settleGoto = resolve; });
  const stop = new Promise<void>((resolve) => { acknowledgeStop = resolve; });
  const first = queue.run(() => runAbortable(goto, controller.signal, async () => { events.push("stop-start"); await stop; events.push("stop-end"); }));
  const firstRejection = assert.rejects(first, { name: "AbortError" });
  const second = queue.run(async () => { events.push("next-operation"); });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["stop-start"]);
  settleGoto();
  acknowledgeStop();
  await firstRejection;
  await second;
  assert.deepEqual(events, ["stop-start", "stop-end", "next-operation"]);
});

test("page quiet extraction recognizes a settled input event without a DOM mutation", async () => {
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    __piMutationMarkers: {
      typing: { count: 0, lastAt: performance.now(), inputCount: 1, lastInputAt: performance.now() - 600 },
    },
  };
  try {
    const page = {
      waitForFunction: async (predicate: (...args: any[]) => boolean, _options: unknown, ...args: any[]) => {
        assert.equal(predicate(...args), true);
      },
    };
    await waitForPageQuiet(page as any, "typing", 500, 500, 1000);
  } finally {
    (globalThis as any).window = previousWindow;
  }
});

test("plain typing settles on input quiet without waiting for the full deadline", async () => {
  const started = Date.now();
  const outcome = await waitForActionSettlement({
    perform: async () => {},
    highPriority: new Promise<string>(() => {}),
    domQuiet: async () => "input-quiet",
    deadline: () => new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 1000)),
  });
  assert.equal(outcome, "input-quiet");
  assert.ok(Date.now() - started < 100, "ordinary input should not wait for the action deadline");
});

test("typing-triggered popup outranks the input quiet signal", async () => {
  const outcome = await waitForActionSettlement({
    perform: async () => {},
    highPriority: new Promise<string>((resolve) => setTimeout(() => resolve("popup"), 10)),
    domQuiet: () => new Promise<string>((resolve) => setTimeout(() => resolve("input-quiet"), 40)),
    deadline: () => new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 100)),
  });
  assert.equal(outcome, "popup");
});

test("immediate DOM mutation remains provisional while delayed navigation wins", async () => {
  const outcome = await waitForActionSettlement({
    perform: async () => {},
    highPriority: new Promise<string>((resolve) => setTimeout(() => resolve("navigation"), 20)),
    domQuiet: () => new Promise<string>((resolve) => setTimeout(() => resolve("dom-update"), 50)),
    deadline: () => new Promise<string>((resolve) => setTimeout(() => resolve("no-change"), 100)),
  });
  assert.equal(outcome, "navigation");
});

test("dialog acceptance monitor captures acceptance-triggered popup before quiet settlement", async () => {
  let accepted = false;
  const outcome = await waitForActionSettlement({
    perform: async () => { accepted = true; },
    highPriority: new Promise<string>((resolve) => setTimeout(() => resolve(accepted ? "popup" : "invalid"), 10)),
    domQuiet: () => new Promise<string>((resolve) => setTimeout(() => resolve("dialog-quiet"), 50)),
    deadline: () => new Promise<string>((resolve) => setTimeout(() => resolve("deadline"), 100)),
  });
  assert.equal(outcome, "popup");
});

test("degraded capabilities reject dialog resolution before accept/dismiss", () => {
  let resolved = false;
  assert.throws(() => {
    requireActionCapabilities({ downloadTracking: true, frameTracking: false });
    resolved = true;
  }, /frame tracking/);
  assert.equal(resolved, false);
});

test("shared connection wait is caller-abortable without cancelling setup for another caller", async () => {
  let completeSetup!: (value: string) => void;
  let setupCount = 0;
  const setup = new Promise<string>((resolve) => {
    setupCount += 1;
    completeSetup = resolve;
  });
  const initiatingCaller = new AbortController();
  const first = waitForSharedOperation(setup, initiatingCaller.signal);
  const firstRejection = assert.rejects(first, { name: "AbortError" });
  const second = waitForSharedOperation(setup);
  initiatingCaller.abort();
  await firstRejection;
  assert.equal(setupCount, 1);
  completeSetup("connected");
  assert.equal(await second, "connected");
});

test("mocked CDP setup failures are surfaced", async () => {
  const fakeCdp = { send: async () => { throw new Error("CDP unavailable"); } };
  await assert.rejects(
    installRequiredCapability("browser download tracking", () => fakeCdp.send()),
    /required browser download tracking: CDP unavailable/,
  );
});

test("capability failures block actions instead of silently degrading", () => {
  assert.throws(() => requireActionCapabilities({ downloadTracking: false, frameTracking: true }), /download event tracking/);
  assert.throws(() => requireActionCapabilities({ downloadTracking: true, frameTracking: false }), /frame tracking/);
  assert.throws(() => requireActionCapabilities({ downloadTracking: true, frameTracking: true, popupTrackingError: "registration failed" }), /popup tracking/);
  assert.doesNotThrow(() => requireActionCapabilities({ downloadTracking: true, frameTracking: true }));
});

test("generation validation rejects observation, document, and DOM staleness", () => {
  const fresh = { requested: 4, observed: 4, observedDocument: 2, currentDocument: 2, observedDom: 7, currentDom: 7 };
  assert.doesNotThrow(() => validateObservationGeneration(fresh));
  assert.throws(() => validateObservationGeneration({ ...fresh, requested: undefined }), /generation is required/);
  assert.throws(() => validateObservationGeneration({ ...fresh, currentDocument: 3 }), /Stale element/);
  assert.throws(() => validateObservationGeneration({ ...fresh, currentDom: 8 }), /Stale element/);
});

test("complete tab snapshots remain coherent under queued mutation", async () => {
  const queue = new SerialQueue();
  const page = { title: "Old title", url: "https://old.example", dialog: undefined as string | undefined };
  let continueRead!: () => void;
  const paused = new Promise<void>((resolve) => { continueRead = resolve; });
  const snapshotPromise = queue.run(async () => {
    const title = page.title;
    await paused;
    return { title, url: page.url, dialog: page.dialog };
  });
  const mutation = queue.run(async () => {
    page.title = "New title";
    page.url = "https://new.example";
    page.dialog = "dialog-1";
  });
  continueRead();
  assert.deepEqual(await snapshotPromise, { title: "Old title", url: "https://old.example", dialog: undefined });
  await mutation;
});

test("screenshot policy blocks before capture is invoked", () => {
  let captured = false;
  assert.throws(() => {
    assertScreenshotAllowed(true);
    captured = true;
  }, /Screenshot blocked/);
  assert.equal(captured, false);
});

test("read-only CDP options require side-effect rejection", () => {
  assert.equal(READ_ONLY_EVALUATE_OPTIONS.throwOnSideEffect, true);
  assert.equal(READ_ONLY_EVALUATE_OPTIONS.returnByValue, true);
  assert.equal(READ_ONLY_EVALUATE_OPTIONS.awaitPromise, false);
});
