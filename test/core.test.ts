import assert from "node:assert/strict";
import test from "node:test";
import {
  SerialQueue,
  classifyElementAction,
  classifySensitiveText,
  classifyUrl,
  embeddedGoogleResultDestination,
  resolveGoogleResultUrl,
  windowsPathToWsl,
} from "../src/core.ts";

test("SerialQueue serializes reads and writes in submission order", async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = queue.run(async () => {
    events.push("first-start");
    await firstBlocked;
    events.push("first-end");
  });
  const second = queue.run(async () => { events.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("an aborted queued operation does not let later work overtake active work", async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run(async () => { events.push("first-start"); await blocked; events.push("first-end"); });
  const controller = new AbortController();
  const aborted = queue.run(async () => { events.push("aborted-ran"); }, controller.signal);
  const third = queue.run(async () => { events.push("third"); });
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  release();
  await Promise.all([first, third]);
  assert.deepEqual(events, ["first-start", "first-end", "third"]);
});

test("safety classifier recognizes risky side effects and CAPTCHA", () => {
  assert.equal(classifyElementAction({ tag: "button", label: "Place order" }).confirmationRequired, true);
  assert.equal(classifyElementAction({ tag: "button", label: "I am not a robot" }).confirmationRequired, true);
  assert.equal(classifyElementAction({ tag: "button", label: "Expand details" }).confirmationRequired, false);
});

test("sensitive classifier uses field context without exposing values", () => {
  assert.equal(classifySensitiveText("anything", { tag: "input", label: "", inputType: "password" }), "authentication secret");
  assert.equal(classifySensitiveText("4111 1111 1111 1111", { tag: "input", label: "Value" }), "payment data");
  assert.equal(classifySensitiveText("ordinary search", { tag: "input", label: "Search" }), undefined);
});

test("URL classifier gates embedded sensitive data", () => {
  assert.equal(classifyUrl("https://user:secret@example.com/").confirmationRequired, true);
  assert.equal(classifyUrl("https://example.com/?email=a%40example.com").dataCategory, "contact or address data");
  assert.equal(classifyUrl("https://example.com/docs").confirmationRequired, false);
  assert.match(classifyUrl("https://example.com/installer.exe").reason ?? "", /download/);
});

test("Windows Chrome download paths map to their WSL-visible location", () => {
  assert.equal(
    windowsPathToWsl("C:\\Users\\tester\\AppData\\Local\\Temp\\pi-web-browser-downloads"),
    "/mnt/c/Users/tester/AppData/Local/Temp/pi-web-browser-downloads",
  );
  assert.equal(windowsPathToWsl("/tmp/pi-web-browser-downloads"), undefined);
});

test("conventional Google result redirects expose their destination URL", () => {
  assert.equal(
    embeddedGoogleResultDestination("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Farticle%3Fx%3D1&sa=U"),
    "https://example.com/article?x=1",
  );
  assert.equal(embeddedGoogleResultDestination("https://example.com/direct"), "https://example.com/direct");
  assert.equal(embeddedGoogleResultDestination("https://www.google.com/search?q=example"), undefined);
});

test("opaque Google result redirects are resolved without loading the destination", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, {
      status: 302,
      headers: { location: "https://publisher.example/news/model-release" },
    });
  };
  const resolved = await resolveGoogleResultUrl("https://www.google.com/goto?url=opaque-token", {
    fetcher,
    userAgent: "test-agent",
    referrer: "https://www.google.com/search?q=models",
  });
  assert.equal(resolved, "https://publisher.example/news/model-release");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.deepEqual(calls[0]?.init?.headers, {
    "user-agent": "test-agent",
    referer: "https://www.google.com/search?q=models",
  });
});

test("failed opaque Google redirect resolution preserves the original URL", async () => {
  const original = "https://www.google.com/goto?url=opaque-token";
  const resolved = await resolveGoogleResultUrl(original, {
    fetcher: async () => { throw new Error("offline"); },
  });
  assert.equal(resolved, original);
});
