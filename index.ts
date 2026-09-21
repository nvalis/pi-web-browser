/** Browser tools backed by a shared remote Chrome, with explicit tabs, coherent observations, and host-side safety gates. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import puppeteer, { type Browser, type CDPSession, type Dialog, type Page } from "puppeteer";
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  READ_ONLY_EVALUATE_OPTIONS,
  SerialQueue,
  assertScreenshotAllowed,
  blockSensitiveResearchAction,
  classifyElementAction,
  classifySensitiveText,
  classifyUrl,
  enforceAutonomousResearchRisk,
  installRequiredCapability,
  requireActionCapabilities,
  resolveGoogleResultUrl,
  runAbortable,
  scrubOutputValue,
  scrubSensitiveOutput,
  throwIfAborted,
  validateObservationGeneration,
  waitForActionSettlement,
  waitForSharedOperation,
  windowsPathToWsl,
  type ElementSafetyMetadata,
  type SensitiveCategory,
} from "./src/core.ts";
import {
  inspectElementHandle,
  installMutationMarker,
  isCaptchaPage,
  observePage,
  pageFingerprint,
  waitForPageQuiet,
} from "./src/page-content.ts";

const CHROME_PORT = process.env.CHROME_REMOTE_PORT ?? "9222";
const ACTION_WAIT_MS = 3500;
const DOM_QUIET_MS = 500;
const INPUT_QUIET_MS = 500;
const DOWNLOAD_WAIT_MS = 30000;
const AUTO_LAUNCH_TIMEOUT_MS = 15000;
const GOOGLE_CAPTCHA_POLL_MS = 750;
const GOOGLE_CAPTCHA_WAIT_MS = Math.max(
  1000,
  Number.parseInt(process.env.PI_BROWSER_CAPTCHA_WAIT_MS ?? "120000", 10) || 120000,
);

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function getChromeHostCandidates(): string[] {
  if (process.env.CHROME_REMOTE_HOST) return [process.env.CHROME_REMOTE_HOST];
  const candidates = ["127.0.0.1"];
  if (!isWsl()) return candidates;
  try {
    const match = readFileSync("/etc/resolv.conf", "utf8").match(/nameserver\s+(\S+)/);
    if (match?.[1] && !candidates.includes(match[1])) candidates.push(match[1]);
  } catch {}
  return candidates;
}

export type AutoLaunchMode = "wsl-windows" | "native-linux";

export function selectAutoLaunchMode(input: {
  disabled: boolean;
  wsl: boolean;
  platform: NodeJS.Platform;
}): AutoLaunchMode | undefined {
  if (input.disabled) return undefined;
  if (input.wsl) return "wsl-windows";
  if (input.platform === "linux") return "native-linux";
  return undefined;
}

function autoLaunchMode(): AutoLaunchMode | undefined {
  return selectAutoLaunchMode({
    disabled: process.env.PI_BROWSER_PREVENT_AUTO_LAUNCH === "1",
    wsl: isWsl(),
    platform: process.platform,
  });
}

function launchWindowsChrome(): void {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$paths = @(",
    "  \"$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe\"",
    "  \"${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe\"",
    "  \"$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe\"",
    ")",
    "$chrome = $paths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1",
    "if (-not $chrome) { throw 'Google Chrome executable was not found' }",
    `$arguments = @('--remote-debugging-port=${CHROME_PORT}', '--remote-debugging-address=0.0.0.0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-default-apps', '--disable-extensions', '--disable-sync', '--disable-translate', \"--user-data-dir=$env:TEMP\\chrome-pi-debug\", '--start-maximized', '--new-window', 'about:blank')`,
    "Start-Process -FilePath $chrome -ArgumentList $arguments",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

export function executableOnPath(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
  const candidates = isAbsolute(name)
    ? [name]
    : pathValue.split(delimiter).filter(Boolean).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export function nativeLinuxChromeArguments(port: string, userDataDirectory: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    `--user-data-dir=${userDataDirectory}`,
    "--start-maximized",
    "--new-window",
    "about:blank",
  ];
}

async function launchNativeLinuxChrome(): Promise<void> {
  const configured = process.env.PI_BROWSER_CHROME_EXECUTABLE;
  const defaultNames = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const names = [configured, process.env.PUPPETEER_EXECUTABLE_PATH, ...defaultNames]
    .filter((name): name is string => Boolean(name));
  const executable = names.map((name) => executableOnPath(name)).find((candidate): candidate is string => Boolean(candidate));
  if (!executable) {
    throw new Error(
      `Chrome/Chromium was not found. Install one of ${defaultNames.join(", ")}, ` +
      `or set PI_BROWSER_CHROME_EXECUTABLE to its executable path.`,
    );
  }
  const userDataDirectory = process.env.PI_BROWSER_CHROME_USER_DATA_DIR ?? join(tmpdir(), "chrome-pi-debug");
  const child = spawn(executable, nativeLinuxChromeArguments(CHROME_PORT, userDataDirectory), {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function launchChromeAutomatically(mode: AutoLaunchMode): Promise<void> {
  if (mode === "wsl-windows") launchWindowsChrome();
  else await launchNativeLinuxChrome();
}

async function probeDebuggerEndpoint(host: string): Promise<{ endpoint: string; wsUrl: string }> {
  const endpoint = `http://${host}:${CHROME_PORT}`;
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1200) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const info = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new Error("Chrome did not return webSocketDebuggerUrl");
  return {
    endpoint,
    wsUrl: info.webSocketDebuggerUrl.replace(/127\.0\.0\.1|localhost/, host),
  };
}

export function browserConnectOptions(browserWSEndpoint: string) {
  // Puppeteer's default 800×600 viewport emulates a small page inside the
  // visible Chrome window. Null keeps Chrome's native, window-filling viewport.
  return { browserWSEndpoint, defaultViewport: null };
}

async function findDebuggerEndpoint(timeoutMs: number): Promise<{ endpoint: string; wsUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    for (const host of getChromeHostCandidates()) {
      try {
        return await probeDebuggerEndpoint(host);
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() < deadline) await delayValue(250, undefined);
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error("Chrome debugger endpoint did not become available");
}

type ActionEvent =
  | { kind: "dialog"; dialogId: string; dialogType: string }
  | { kind: "popup"; tabId: string }
  | {
      kind: "download";
      guid: string;
      suggestedFilename: string;
      url: string;
      state: "started" | "completed" | "canceled";
      receivedBytes?: number;
      totalBytes?: number;
      localDirectory?: string;
    };

interface DownloadState {
  tab: TabState;
  started: Extract<ActionEvent, { kind: "download" }>;
  completion: Promise<Extract<ActionEvent, { kind: "download" }>>;
  resolveCompletion: (event: Extract<ActionEvent, { kind: "download" }>) => void;
}

interface PendingDialog {
  id: string;
  dialog: Dialog;
}

interface TabState {
  id: string;
  targetId: string;
  page: Page;
  queue: SerialQueue;
  documentGeneration: number;
  observationGeneration: number;
  observedDocumentGeneration: number;
  observedDomGeneration: number;
  pendingDialog?: PendingDialog;
  eventHistory: ActionEvent[];
  eventListeners: Set<(event: ActionEvent) => void>;
  mainFrameId?: string;
  attached: boolean;
  frameTrackingReady: boolean;
  sensitiveValues: Set<string>;
  sensitiveCategories: Set<SensitiveCategory>;
}

interface ActionOutcome {
  kind: "navigation" | "dom-update" | "no-change" | "dialog" | "popup" | "download";
  url: string;
  events: ActionEvent[];
  operationWarning?: string;
}

export default function webBrowserExtension(pi: ExtensionAPI) {
  let browser: Browser | null = null;
  let browserConnectPromise: Promise<Browser> | null = null;
  let browserCdp: CDPSession | null = null;
  const browserQueue = new SerialQueue();
  const tabs = new Map<string, TabState>();
  const tabIdByTarget = new Map<string, string>();
  let nextTabId = 1;
  let nextDialogId = 1;
  let activeTabId: string | null = null;
  let downloadTrackingReady = false;
  let downloadBrowserPath: string | undefined;
  let downloadLocalPath: string | undefined;
  const downloads = new Map<string, DownloadState>();
  let popupTrackingError: string | undefined;
  const googleSearchQueue = new SerialQueue();
  let googleCaptcha: { tab: TabState; timedOut: boolean } | undefined;

  function truncateOutput(text: string): string {
    const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    if (!result.truncated) return result.content;
    return `${result.content}\n\n[Truncated: showing ${result.outputLines}/${result.totalLines} lines, ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}]`;
  }

  function emitTabEvent(tab: TabState, event: ActionEvent): void {
    tab.eventHistory.push(event);
    if (tab.eventHistory.length > 20) tab.eventHistory.shift();
    for (const listener of tab.eventListeners) listener(event);
  }

  async function targetIdFor(page: Page): Promise<string> {
    const privateId = (page.target() as unknown as { _targetId?: string })._targetId;
    if (privateId) return privateId;
    const client = await page.createCDPSession();
    try {
      const result = await client.send("Target.getTargetInfo");
      return result.targetInfo.targetId;
    } finally {
      await client.detach().catch(() => {});
    }
  }

  async function registerPage(page: Page): Promise<TabState> {
    const targetId = await targetIdFor(page);
    const existingId = tabIdByTarget.get(targetId);
    if (existingId) {
      const existing = tabs.get(existingId);
      if (existing) {
        existing.page = page;
        await attachTabListeners(existing);
        return existing;
      }
    }
    const id = existingId ?? `tab-${nextTabId++}`;
    const tab: TabState = {
      id,
      targetId,
      page,
      queue: new SerialQueue(),
      documentGeneration: 1,
      observationGeneration: 0,
      observedDocumentGeneration: 0,
      observedDomGeneration: 0,
      eventHistory: [],
      eventListeners: new Set(),
      attached: false,
      frameTrackingReady: false,
      sensitiveValues: new Set(),
      sensitiveCategories: new Set(),
    };
    tabs.set(id, tab);
    tabIdByTarget.set(targetId, id);
    activeTabId ??= id;
    await attachTabListeners(tab);
    return tab;
  }

  async function attachTabListeners(tab: TabState): Promise<void> {
    if (!tab.attached) {
      tab.attached = true;
      tab.page.on("framenavigated", (frame) => {
        if (frame === tab.page.mainFrame()) {
          tab.documentGeneration += 1;
          tab.observedDocumentGeneration = 0;
        }
      });
      tab.page.on("dialog", (dialog) => {
        const pending = { id: `dialog-${nextDialogId++}`, dialog };
        tab.pendingDialog = pending;
        emitTabEvent(tab, { kind: "dialog", dialogId: pending.id, dialogType: dialog.type() });
      });
      tab.page.on("close", () => {
        void browserQueue.run(async () => {
          tabs.delete(tab.id);
          if (activeTabId === tab.id) activeTabId = [...tabs.keys()][0] ?? null;
        });
      });
    }
    if (!tab.frameTrackingReady) await setupPageFrameTracking(tab);
  }

  async function setupPageFrameTracking(tab: TabState): Promise<void> {
    tab.frameTrackingReady = false;
    const client = await tab.page.createCDPSession();
    try {
      const tree = await installRequiredCapability("tab frame/download tracking", () => client.send("Page.getFrameTree"));
      tab.mainFrameId = tree.frameTree.frame.id;
      client.on("Page.frameNavigated", ({ frame }) => {
        if (!frame.parentId) tab.mainFrameId = frame.id;
      });
      tab.frameTrackingReady = true;
    } catch (error) {
      await client.detach().catch(() => {});
      downloadTrackingReady = false;
      browser?.disconnect();
      browser = null;
      throw new Error(`Cannot install frame/download tracking for ${tab.id}: ${scrubSensitiveOutput(errorMessage(error))}`);
    }
  }

  async function setupBrowserCdp(connected: Browser): Promise<void> {
    downloadTrackingReady = false;
    browserCdp = await connected.target().createCDPSession();
    const paths = await resolveDownloadPaths();
    downloadBrowserPath = paths.browserPath;
    downloadLocalPath = paths.localPath;
    await installRequiredCapability("browser download tracking", () =>
      browserCdp!.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: paths.browserPath,
        eventsEnabled: true,
      }),
    );
    downloadTrackingReady = true;
    browserCdp.on("Browser.downloadWillBegin", (event) => {
      const tab = [...tabs.values()].find((candidate) => candidate.mainFrameId === event.frameId);
      if (!tab) return;
      let resolveCompletion!: (value: Extract<ActionEvent, { kind: "download" }>) => void;
      const completion = new Promise<Extract<ActionEvent, { kind: "download" }>>((resolve) => {
        resolveCompletion = resolve;
      });
      const started: Extract<ActionEvent, { kind: "download" }> = {
        kind: "download",
        guid: event.guid,
        suggestedFilename: event.suggestedFilename,
        url: event.url,
        state: "started",
        localDirectory: paths.localPath,
      };
      downloads.set(event.guid, { tab, started, completion, resolveCompletion });
      emitTabEvent(tab, started);
    });
    browserCdp.on("Browser.downloadProgress", (event) => {
      if (event.state === "inProgress") return;
      const pending = downloads.get(event.guid);
      if (!pending) return;
      const terminal: Extract<ActionEvent, { kind: "download" }> = {
        ...pending.started,
        state: event.state === "completed" ? "completed" : "canceled",
        receivedBytes: event.receivedBytes,
        totalBytes: event.totalBytes,
      };
      pending.resolveCompletion(terminal);
      emitTabEvent(pending.tab, terminal);
    });
  }

  async function ensureConnectedBrowser(signal?: AbortSignal): Promise<Browser> {
    throwIfAborted(signal);
    if (browserConnectPromise) return waitForSharedOperation(browserConnectPromise, signal);
    if (browser?.connected && downloadTrackingReady) return browser;
    if (browser?.connected) browser.disconnect();
    if (!browserConnectPromise) {
      browserConnectPromise = (async () => {
        let debuggerEndpoint: { endpoint: string; wsUrl: string };
        try {
          debuggerEndpoint = await findDebuggerEndpoint(1500);
        } catch (initialError) {
          const launchMode = autoLaunchMode();
          if (!launchMode) {
            const hosts = getChromeHostCandidates().map((host) => `http://${host}:${CHROME_PORT}`).join(", ");
            throw new Error(
              `Cannot connect to Chrome at ${hosts}. Automatic launch is unavailable on this platform or disabled. ` +
              `Start Chrome with --remote-debugging-port=${CHROME_PORT}, or unset PI_BROWSER_PREVENT_AUTO_LAUNCH=1. ` +
              `Error: ${errorMessage(initialError)}`,
            );
          }
          try {
            await launchChromeAutomatically(launchMode);
          } catch (launchError) {
            const platform = launchMode === "wsl-windows" ? "Windows Chrome from WSL" : "Chrome/Chromium on Linux";
            throw new Error(`Cannot start ${platform}: ${errorMessage(launchError)}`);
          }
          try {
            debuggerEndpoint = await findDebuggerEndpoint(AUTO_LAUNCH_TIMEOUT_MS);
          } catch (startupError) {
            const platform = launchMode === "wsl-windows" ? "Windows Chrome" : "Linux Chrome/Chromium";
            throw new Error(
              `${platform} was started but its debugger endpoint did not become available within ` +
              `${AUTO_LAUNCH_TIMEOUT_MS / 1000} seconds: ${errorMessage(startupError)}`,
            );
          }
        }
        const connected = await puppeteer.connect(browserConnectOptions(debuggerEndpoint.wsUrl));
        browser = connected;
        popupTrackingError = undefined;
        connected.on("targetcreated", (target) => {
          void target.page().then((newPage) => {
            if (!newPage) return;
            return browserQueue.run(async () => {
              const popup = await registerPage(newPage);
              const openerTarget = target.opener();
              if (openerTarget) {
                const openerId = tabIdByTarget.get((openerTarget as unknown as { _targetId?: string })._targetId ?? "");
                const opener = openerId ? tabs.get(openerId) : undefined;
                if (opener) emitTabEvent(opener, { kind: "popup", tabId: popup.id });
              }
            });
          }).catch((error) => {
            popupTrackingError = scrubSensitiveOutput(errorMessage(error));
          });
        });
        connected.on("disconnected", () => {
          browser = null;
          browserCdp = null;
          downloadTrackingReady = false;
          for (const tab of tabs.values()) {
            tab.attached = false;
            tab.frameTrackingReady = false;
          }
        });
        await browserQueue.run(async () => {
          const seenTargetIds = new Set<string>();
          for (const candidate of await connected.pages()) {
            if (candidate.isClosed()) continue;
            const registered = await registerPage(candidate);
            seenTargetIds.add(registered.targetId);
          }
          for (const [id, tab] of tabs) {
            if (!seenTargetIds.has(tab.targetId)) tabs.delete(id);
          }
          if (!activeTabId || !tabs.has(activeTabId)) activeTabId = [...tabs.keys()][0] ?? null;
        });
        try {
          await setupBrowserCdp(connected);
        } catch (error) {
          connected.disconnect();
          browser = null;
          browserCdp = null;
          downloadTrackingReady = false;
          throw new Error(`Cannot install required browser download tracking: ${scrubSensitiveOutput(errorMessage(error))}`);
        }
        return connected;
      })().finally(() => { browserConnectPromise = null; });
    }
    return waitForSharedOperation(browserConnectPromise, signal);
  }

  async function createTab(signal?: AbortSignal, makeActive = true): Promise<TabState> {
    const connected = await ensureConnectedBrowser(signal);
    return browserQueue.run(async () => {
      throwIfAborted(signal);
      const page = await connected.newPage();
      const tab = await registerPage(page);
      if (makeActive) activeTabId = tab.id;
      return tab;
    }, signal);
  }

  async function resolveTab(tabId: string | undefined, signal?: AbortSignal): Promise<TabState> {
    await ensureConnectedBrowser(signal);
    const resolved = await browserQueue.run(async () => {
      const id = tabId ?? activeTabId;
      if (!id) return undefined;
      const tab = tabs.get(id);
      if (!tab || tab.page.isClosed()) throw new Error(`Unknown or closed tab_id: ${id}`);
      return tab;
    }, signal);
    return resolved ?? createTab(signal);
  }

  async function withTab<T>(tabId: string | undefined, signal: AbortSignal | undefined, operation: (tab: TabState) => Promise<T>): Promise<T> {
    const tab = await resolveTab(tabId, signal);
    return tab.queue.run(async () => {
      throwIfAborted(signal);
      if (tab.page.isClosed()) throw new Error(`Tab ${tab.id} is closed`);
      try {
        return await operation(tab);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new Error(scrubSensitiveOutput(errorMessage(error), tab.sensitiveValues));
      }
    }, signal);
  }

  function safePageUrl(tab: TabState): string {
    const raw = tab.page.url();
    if (tab.sensitiveValues.size === 0) return raw;
    try {
      const parsed = new URL(raw);
      return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[sensitive query hidden]" : ""}`;
    } catch {
      return "[page URL hidden after sensitive input]";
    }
  }

  function redactTabText(tab: TabState, text: string): string {
    return scrubSensitiveOutput(text, tab.sensitiveValues);
  }

  function sanitizeTabValue<T>(tab: TabState, value: T): T {
    return scrubOutputValue(value, tab.sensitiveValues) as T;
  }

  function sanitizeOutcome(tab: TabState, outcome: ActionOutcome): ActionOutcome {
    return sanitizeTabValue(tab, {
      ...outcome,
      url: tab.sensitiveValues.size > 0 ? safePageUrl(tab) : outcome.url,
      events: outcome.events.map((event) => event.kind === "download"
        ? { ...event, url: tab.sensitiveValues.size > 0 ? safeDestination(event.url) : event.url }
        : event),
    });
  }

  function assertActionCapabilities(tab: TabState): void {
    requireActionCapabilities({
      downloadTracking: downloadTrackingReady,
      frameTracking: tab.frameTrackingReady,
      popupTrackingError,
    });
  }

  async function navigate(tab: TabState, url: string, signal: AbortSignal | undefined): Promise<ActionOutcome> {
    assertActionCapabilities(tab);
    if (!/^https?:\/\//i.test(url) && url !== "about:blank") throw new Error("Only http:, https:, and about:blank navigation is allowed.");
    const classification = classifyUrl(url);
    if (classification.dataCategory) blockSensitiveResearchAction(classification.action, classification.dataCategory);
    enforceAutonomousResearchRisk(classification);
    const before = tab.page.url();
    try {
      await runAbortable(
        tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
        signal,
        () => cancelPageOperation(tab.page),
      );
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("timeout"))) throw error;
    }
    return sanitizeOutcome(tab, { kind: tab.page.url() !== before ? "navigation" : "dom-update", url: tab.page.url(), events: [] });
  }

  async function waitForActionOutcome(
    tab: TabState,
    perform: () => Promise<void>,
    signal?: AbortSignal,
    mode: "dom" | "input" | "dialog" = "dom",
  ): Promise<ActionOutcome> {
    assertActionCapabilities(tab);
    const cancelAction = () => cancelPageOperation(tab.page, mode !== "dialog");
    const beforeUrl = tab.page.url();
    const beforeDocumentGeneration = tab.documentGeneration;
    const beforeDomGeneration = tab.observedDomGeneration;
    const beforeFingerprint = mode === "dialog"
      ? undefined
      : await runAbortable(pageFingerprint(tab.page), signal, cancelAction);
    const capturedEvents: ActionEvent[] = [];
    const token = `m${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (mode !== "dialog") {
      await runAbortable(installMutationMarker(tab.page, token), signal, cancelAction);
    }

    let resolveEvent!: (event: ActionEvent) => void;
    const eventPromise = new Promise<ActionEvent>((resolve) => { resolveEvent = resolve; });
    const listener = (event: ActionEvent) => {
      capturedEvents.push(event);
      resolveEvent(event);
    };
    tab.eventListeners.add(listener);
    const navigationMonitor = new AbortController();
    const navigationPromise = tab.page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 0,
      signal: navigationMonitor.signal,
    }).then(() => "navigation" as const).catch(() => "deadline" as const);
    const highPriority = Promise.race([navigationPromise, eventPromise.then(() => "browser-event" as const)]);
    const pageQuiet = () => mode === "dialog"
      ? delay(DOM_QUIET_MS).then(() => "page-quiet" as const)
      : waitForPageQuiet(
          tab.page,
          token,
          DOM_QUIET_MS,
          mode === "input" ? INPUT_QUIET_MS : undefined,
          ACTION_WAIT_MS,
          signal,
        ).then(() => "page-quiet" as const).catch(() => "deadline" as const);

    let operationError: unknown;
    const monitoredPerform = async () => {
      try {
        await perform();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        operationError = error;
      }
    };
    let settlement: "navigation" | "browser-event" | "page-quiet" | "deadline" | "no-change";
    try {
      settlement = await waitForActionSettlement({
        perform: monitoredPerform,
        highPriority,
        domQuiet: pageQuiet,
        deadline: () => delay(ACTION_WAIT_MS),
        signal,
        cancel: cancelAction,
      });
    } finally {
      navigationMonitor.abort();
      tab.eventListeners.delete(listener);
    }

    if (popupTrackingError) throw new Error(`Popup tracking failed during the action: ${scrubSensitiveOutput(popupTrackingError)}`);
    const startedDownload = capturedEvents.find(
      (event): event is Extract<ActionEvent, { kind: "download" }> => event.kind === "download" && event.state === "started",
    );
    if (startedDownload) {
      const pending = downloads.get(startedDownload.guid);
      if (pending) {
        const terminal = await runAbortable(
          Promise.race([
            pending.completion,
            delayValue(DOWNLOAD_WAIT_MS, undefined),
          ]),
          signal,
          cancelAction,
        );
        if (terminal) capturedEvents.push(terminal);
        downloads.delete(startedDownload.guid);
      }
    }
    const events = capturedEvents;
    const url = tab.page.url();
    const afterFingerprint = tab.pendingDialog
      ? beforeFingerprint
      : await runAbortable(pageFingerprint(tab.page), signal, cancelAction);
    const afterDomGeneration = tab.pendingDialog
      ? beforeDomGeneration
      : await runAbortable(
          tab.page.evaluate(() => (window as any).__piDomGenerationState?.value ?? 0),
          signal,
          cancelAction,
        );
    let kind: ActionOutcome["kind"] = "no-change";
    if (events.some((event) => event.kind === "dialog")) kind = "dialog";
    else if (events.some((event) => event.kind === "popup")) kind = "popup";
    else if (events.some((event) => event.kind === "download")) kind = "download";
    else if (url !== beforeUrl || tab.documentGeneration !== beforeDocumentGeneration) kind = "navigation";
    else if (
      (mode === "input" && settlement === "page-quiet") ||
      (beforeFingerprint !== undefined && afterFingerprint !== beforeFingerprint) ||
      (mode === "dialog" && afterDomGeneration !== beforeDomGeneration)
    ) kind = "dom-update";
    if (operationError !== undefined && kind === "no-change") throw operationError;
    const terminalDownload = events.find(
      (event): event is Extract<ActionEvent, { kind: "download" }> => event.kind === "download" && event.state !== "started",
    );
    const downloadWarning = startedDownload && !terminalDownload
      ? `Download did not finish within ${DOWNLOAD_WAIT_MS / 1000} seconds.`
      : terminalDownload?.state === "canceled"
        ? "The browser canceled the download."
        : undefined;
    return sanitizeOutcome(tab, {
      kind,
      url,
      events,
      operationWarning: [
        operationError === undefined ? undefined : `The browser operation ended after the observed page event: ${errorMessage(operationError)}`,
        downloadWarning,
      ].filter(Boolean).join(" ") || undefined,
    });
  }

  async function requireFreshIndex(tab: TabState, index: number, generation: number | undefined, signal?: AbortSignal): Promise<string> {
    if (generation === undefined) throw new Error("generation is required when acting by numeric index. Re-read the page and pass its observation_generation.");
    const currentDomGeneration = await runAbortable(
      tab.page.evaluate(() => (window as any).__piDomGenerationState?.value ?? 0),
      signal,
      () => cancelPageOperation(tab.page),
    );
    validateObservationGeneration({
      requested: generation,
      observed: tab.observationGeneration,
      observedDocument: tab.observedDocumentGeneration,
      currentDocument: tab.documentGeneration,
      observedDom: tab.observedDomGeneration,
      currentDom: currentDomGeneration,
    });
    return `[data-pi-idx="${index}"][data-pi-generation="${generation}"]`;
  }

  async function renderObservation(tab: TabState, prefix = "", signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown> }> {
    if (tab.pendingDialog) {
      const dialog = tab.pendingDialog;
      return {
        text: `${prefix}${prefix ? "\n\n" : ""}Tab: ${tab.id}\nURL: ${safePageUrl(tab)}\nPending dialog: ${dialog.id} (${dialog.dialog.type()})\nUse web_dialog to accept or dismiss it. Page observation is paused while the dialog is open.`,
        details: { tabId: tab.id, url: safePageUrl(tab), documentGeneration: tab.documentGeneration, pendingDialog: dialog.id },
      };
    }
    const captcha = await runAbortable(isCaptchaPage(tab.page), signal, () => cancelPageOperation(tab.page));
    if (captcha) {
      activeTabId = tab.id;
      await runAbortable(tab.page.bringToFront(), signal, () => cancelPageOperation(tab.page));
      prefix = [
        prefix,
        `USER ACTION REQUIRED: CAPTCHA or human-verification is open in ${tab.id}.`,
        "Solve it manually in the visible Chrome window, then tell me when it is complete. The tab is preserved.",
      ].filter(Boolean).join("\n");
    }
    tab.observationGeneration += 1;
    tab.observedDocumentGeneration = tab.documentGeneration;
    const observation = await runAbortable(
      observePage(tab.page, tab.observationGeneration),
      signal,
      () => cancelPageOperation(tab.page),
    );
    tab.observedDomGeneration = observation.domGeneration;
    const text = [
      prefix,
      `Tab: ${tab.id}`,
      `URL: ${safePageUrl(tab)}`,
      `Title: ${observation.title}`,
      `Document generation: ${tab.documentGeneration}`,
      `Observation generation: ${tab.observationGeneration}`,
      "\n── Page Content ──────────────────────────────────────",
      observation.readableText,
      "\n── Interactive Elements ───────────────────────────────",
      observation.interactiveText,
    ].filter(Boolean).join("\n");
    return {
      text: redactTabText(tab, text),
      details: sanitizeTabValue(tab, {
        tabId: tab.id,
        url: safePageUrl(tab),
        title: observation.title,
        documentGeneration: tab.documentGeneration,
        observationGeneration: tab.observationGeneration,
        elementCount: observation.elementCount,
        captcha,
        needsUserAction: captcha,
      }),
    };
  }

  async function relayCaptchaToUser(tab: TabState, signal?: AbortSignal): Promise<never> {
    activeTabId = tab.id;
    await runAbortable(tab.page.bringToFront(), signal, () => cancelPageOperation(tab.page));
    throw new Error(
      `User action required: CAPTCHA or human-verification is open in ${tab.id}. ` +
      `Please solve it manually in the visible Chrome window, then tell me when it is complete. ` +
      `The tab and page state have been preserved.`,
    );
  }

  async function googleCaptchaIsOpen(tab: TabState, signal?: AbortSignal): Promise<boolean> {
    if (tab.page.isClosed()) return false;
    return runAbortable(isCaptchaPage(tab.page), signal, () => cancelPageOperation(tab.page));
  }

  async function waitForGoogleCaptchaResolution(tab: TabState, signal?: AbortSignal): Promise<boolean> {
    activeTabId = tab.id;
    await runAbortable(tab.page.bringToFront(), signal, () => cancelPageOperation(tab.page));
    googleCaptcha = { tab, timedOut: false };
    const deadline = Date.now() + GOOGLE_CAPTCHA_WAIT_MS;
    let clearObservations = 0;
    while (Date.now() < deadline) {
      await runAbortable(delayValue(GOOGLE_CAPTCHA_POLL_MS, undefined), signal);
      if (tab.page.isClosed()) {
        googleCaptcha = undefined;
        return false;
      }
      if (await googleCaptchaIsOpen(tab, signal)) {
        clearObservations = 0;
        continue;
      }
      clearObservations += 1;
      if (clearObservations < 2) continue;
      googleCaptcha = undefined;
      return true;
    }
    if (googleCaptcha?.tab === tab) googleCaptcha.timedOut = true;
    return false;
  }

  function googleCaptchaResult(tab: TabState, waitingTimedOut: boolean) {
    return {
      ...textResult(
        `USER ACTION REQUIRED: Google presented a CAPTCHA in ${tab.id}. ` +
        `Other Google searches were paused before sending their requests. ` +
        `Please solve it manually in the visible Chrome window, then retry or continue the searches. ` +
        (waitingTimedOut
          ? `Automatic waiting stopped after ${Math.round(GOOGLE_CAPTCHA_WAIT_MS / 1000)} seconds; the tab and search state remain preserved.`
          : "The tab and search state remain preserved."),
        { tabId: tab.id, blocked: true, captcha: true, needsUserAction: true, otherSearchesPaused: true },
      ),
      terminate: true,
    };
  }

  async function enforceElementAction(tab: TabState, metadata: ElementSafetyMetadata, signal?: AbortSignal): Promise<void> {
    const risk = classifyElementAction(metadata);
    if (risk.reason?.includes("CAPTCHA") || await runAbortable(isCaptchaPage(tab.page), signal, () => cancelPageOperation(tab.page))) {
      await relayCaptchaToUser(tab, signal);
    }
    enforceAutonomousResearchRisk(risk);
  }

  const tabIdParam = Type.Optional(Type.String({ description: "Tab ID. Defaults to the active tab." }));
  const generationParam = Type.Optional(Type.Number({ description: "Required observation_generation when using index." }));

  pi.registerTool({
    name: "web_tabs",
    label: "Web Tabs",
    description: "List, create, select, or close browser tabs. Existing browser tools default to the active tab.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("select"), Type.Literal("close")]),
      tab_id: tabIdParam,
      url: Type.Optional(Type.String({ description: "Optional URL for a new tab." })),
    }),
    async execute(_id, params, signal) {
      await ensureConnectedBrowser(signal);
      if (params.action === "new") {
        const tab = await createTab(signal, true);
        if (params.url) {
          await tab.queue.run(async () => {
            try {
              await navigate(tab, params.url!, signal);
            } catch (error) {
              if (error instanceof Error && error.name === "AbortError") throw error;
              throw new Error(scrubSensitiveOutput(errorMessage(error), tab.sensitiveValues));
            }
          }, signal);
        }
        return textResult(`Created and selected ${tab.id}.\nURL: ${safePageUrl(tab)}`, { tabId: tab.id, active: true });
      }
      if (params.action === "select") {
        if (!params.tab_id) throw new Error("tab_id is required for select");
        const tab = await resolveTab(params.tab_id, signal);
        const selected = await tab.queue.run(() => browserQueue.run(async () => {
          activeTabId = tab.id;
          await runAbortable(tab.page.bringToFront(), signal, () => cancelPageOperation(tab.page));
          return { tabId: tab.id, url: safePageUrl(tab), active: true };
        }, signal), signal);
        return textResult(`Selected ${selected.tabId}.\nURL: ${selected.url}`, selected);
      }
      if (params.action === "close") {
        const tab = await resolveTab(params.tab_id, signal);
        await tab.queue.run(async () => {
          await runAbortable(tab.page.close(), signal, () => cancelPageOperation(tab.page));
        }, signal);
        await browserQueue.run(async () => {
          tabs.delete(tab.id);
          if (activeTabId === tab.id) activeTabId = [...tabs.keys()][0] ?? null;
        }, signal);
        return textResult(`Closed ${tab.id}. Active tab: ${activeTabId ?? "none"}`, { tabId: tab.id, activeTabId });
      }
      const browserSnapshot = await browserQueue.run(async () => ({
        activeId: activeTabId,
        openTabs: [...tabs.values()].filter((tab) => !tab.page.isClosed()),
      }), signal);
      const snapshots: Array<{ id: string; title: string; url: string; dialogId?: string }> = [];
      for (const tab of browserSnapshot.openTabs) {
        snapshots.push(await tab.queue.run(async () => ({
          id: tab.id,
          title: tab.pendingDialog ? "(dialog pending)" : redactTabText(tab, await runAbortable(tab.page.title(), signal, () => cancelPageOperation(tab.page))),
          url: safePageUrl(tab),
          dialogId: tab.pendingDialog?.id,
        }), signal));
      }
      const lines = snapshots.map((snapshot) =>
        `${snapshot.id === browserSnapshot.activeId ? "*" : " "} ${snapshot.id}  ${snapshot.title}\n  ${snapshot.url}${snapshot.dialogId ? `  [${snapshot.dialogId}]` : ""}`,
      );
      const capabilityWarning = popupTrackingError ? `\n\nCapability warning: popup tracking is degraded: ${scrubSensitiveOutput(popupTrackingError)}` : "";
      return textResult(`${lines.length ? lines.join("\n") : "No open tabs."}${capabilityWarning}`, {
        activeTabId: browserSnapshot.activeId,
        count: lines.length,
        popupTrackingError,
      });
    },
  });

  pi.registerTool({
    name: "web_navigate",
    label: "Web Navigate",
    description: "Navigate a tab and return readable content plus generation-scoped interactive elements.",
    promptGuidelines: ["Pass observation_generation to web_click/web_type whenever using a numeric index."],
    parameters: Type.Object({ url: Type.String(), tab_id: tabIdParam }),
    async execute(_id, params, signal, update) {
      return withTab(params.tab_id, signal, async (tab) => {
        update?.({ content: [{ type: "text", text: `Navigating ${tab.id} to ${safeDestination(params.url)}` }], details: {} });
        const outcome = await navigate(tab, params.url, signal);
        const rendered = await renderObservation(tab, `Outcome: ${outcome.kind}`, signal);
        return textResult(truncateOutput(rendered.text), { ...rendered.details, outcome });
      });
    },
  });

  pi.registerTool({
    name: "web_click",
    label: "Web Click",
    description: "Click by a fresh generation-scoped index or CSS selector, with autonomous-research safety checks and an event-aware outcome.",
    parameters: Type.Object({
      index: Type.Optional(Type.Number()), selector: Type.Optional(Type.String()), generation: generationParam, tab_id: tabIdParam,
    }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        const selector = params.index !== undefined ? await requireFreshIndex(tab, params.index, params.generation, signal) : params.selector;
        if (!selector) throw new Error("Provide index or selector");
        const element = await runAbortable(tab.page.$(selector), signal, () => cancelPageOperation(tab.page));
        if (!element) throw new Error("Element not found. Re-read the page before acting.");
        const metadata = await runAbortable(inspectElementHandle(element), signal, () => cancelPageOperation(tab.page));
        await enforceElementAction(tab, metadata, signal);
        const latestMetadata = await runAbortable(inspectElementHandle(element), signal, () => cancelPageOperation(tab.page));
        if (JSON.stringify(latestMetadata) !== JSON.stringify(metadata)) {
          throw new Error("Element changed during safety inspection; re-read the page and use the current target.");
        }
        const outcome = await waitForActionOutcome(tab, async () => { await element.click(); }, signal);
        const rendered = await renderObservation(tab, `Clicked successfully.\nOutcome: ${formatOutcome(outcome)}`, signal);
        return textResult(truncateOutput(rendered.text), { ...rendered.details, outcome });
      });
    },
  });

  pi.registerTool({
    name: "web_type",
    label: "Web Type",
    description: "Type into a field by fresh index or selector. Autonomous research blocks sensitive-data transmission and CAPTCHA interaction without opening confirmation dialogs.",
    parameters: Type.Object({
      text: Type.String(), index: Type.Optional(Type.Number()), selector: Type.Optional(Type.String()), generation: generationParam,
      press_enter: Type.Optional(Type.Boolean()), clear_first: Type.Optional(Type.Boolean()), tab_id: tabIdParam,
    }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        const selector = params.index !== undefined ? await requireFreshIndex(tab, params.index, params.generation, signal) : params.selector;
        if (!selector) throw new Error("Provide index or selector");
        const element = await runAbortable(tab.page.$(selector), signal, () => cancelPageOperation(tab.page));
        if (!element) throw new Error("Input element not found. Re-read the page before acting.");
        const metadata = await runAbortable(inspectElementHandle(element), signal, () => cancelPageOperation(tab.page));
        const category = classifySensitiveText(params.text, metadata);
        if (category) blockSensitiveResearchAction(`type into ${metadata.tag}`, category);
        enforceAutonomousResearchRisk(classifyElementAction(metadata));
        if (params.press_enter && (metadata.formMethod ?? "").toLowerCase() === "post") {
          throw new Error("Blocked by autonomous research policy: pressing Enter would submit a POST form.");
        }
        if (await runAbortable(isCaptchaPage(tab.page), signal, () => cancelPageOperation(tab.page))) {
          await relayCaptchaToUser(tab, signal);
        }
        const latestMetadata = await runAbortable(inspectElementHandle(element), signal, () => cancelPageOperation(tab.page));
        if (JSON.stringify(latestMetadata) !== JSON.stringify(metadata)) {
          throw new Error("Input changed during safety inspection; re-read the page before typing.");
        }
        const perform = async () => {
          if (params.clear_first !== false) {
            await element.click({ count: 3 });
            await tab.page.keyboard.press("Backspace");
          }
          await element.type(params.text);
          if (params.press_enter) await tab.page.keyboard.press("Enter");
        };
        const outcome = await waitForActionOutcome(tab, perform, signal, params.press_enter ? "dom" : "input");
        const rendered = await renderObservation(tab, `Typed into the field${params.press_enter ? " and pressed Enter" : ""}. The value is hidden.\nOutcome: ${formatOutcome(outcome)}`, signal);
        const safeText = category ? redactExact(rendered.text, params.text) : rendered.text;
        return textResult(truncateOutput(safeText), { ...rendered.details, outcome, typedValueRedacted: true, sensitiveCategory: category });
      });
    },
  });

  pi.registerTool({
    name: "web_read_page",
    label: "Web Read Page",
    description: "Read a coherent tab snapshot and issue a new observation_generation.",
    parameters: Type.Object({ scroll_to: Type.Optional(Type.String()), tab_id: tabIdParam }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        if (params.scroll_to) {
          await runAbortable(tab.page.evaluate((target) => {
            if (target === "top") window.scrollTo(0, 0);
            else if (target === "bottom") window.scrollTo(0, document.body.scrollHeight);
            else document.querySelector(target)?.scrollIntoView({ block: "center" });
          }, params.scroll_to), signal, () => cancelPageOperation(tab.page));
        }
        const rendered = await renderObservation(tab, "", signal);
        return textResult(truncateOutput(rendered.text), rendered.details);
      });
    },
  });

  pi.registerTool({
    name: "web_back",
    label: "Web Back",
    description: "Go back in a tab and return a fresh coherent observation.",
    parameters: Type.Object({ tab_id: tabIdParam }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        assertActionCapabilities(tab);
        try {
          await runAbortable(tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }), signal, () => cancelPageOperation(tab.page));
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("timeout"))) throw error;
        }
        const rendered = await renderObservation(tab, "Outcome: navigation", signal);
        return textResult(truncateOutput(rendered.text), { ...rendered.details, outcome: "navigation" });
      });
    },
  });

  pi.registerTool({
    name: "web_screenshot",
    label: "Web Screenshot",
    description: "Capture a tab screenshot.",
    parameters: Type.Object({ full_page: Type.Optional(Type.Boolean()), tab_id: tabIdParam }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        assertScreenshotAllowed(tab.sensitiveValues.size > 0);
        const data = await runAbortable(
          tab.page.screenshot({ encoding: "base64", fullPage: params.full_page ?? false, type: "png" }),
          signal,
          () => cancelPageOperation(tab.page),
        );
        return {
          content: [
            { type: "text" as const, text: redactTabText(tab, `Tab: ${tab.id}\nURL: ${safePageUrl(tab)}\nDocument generation: ${tab.documentGeneration}`) },
            { type: "image" as const, mimeType: "image/png", data: data as string },
          ],
          details: sanitizeTabValue(tab, { tabId: tab.id, url: safePageUrl(tab), documentGeneration: tab.documentGeneration }),
        };
      });
    },
  });

  pi.registerTool({
    name: "web_eval",
    label: "Web Eval (Read Only)",
    description: "Evaluate a genuinely read-only JavaScript expression. CDP rejects expressions whose lack of side effects cannot be proven.",
    promptGuidelines: ["web_eval is extraction-only; use web_click/web_type for actions."],
    parameters: Type.Object({ code: Type.String(), tab_id: tabIdParam }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        if (tab.pendingDialog) throw new Error("Resolve the pending dialog before evaluating the page.");
        if (tab.sensitiveValues.size > 0) throw new Error("web_eval is blocked after sensitive data was entered in this tab because even read-only evaluation could extract it.");
        const client = await tab.page.createCDPSession();
        try {
          const response = await runAbortable(client.send("Runtime.evaluate", {
            expression: params.code,
            ...READ_ONLY_EVALUATE_OPTIONS,
          }), signal, () => cancelPageOperation(tab.page));
          if (response.exceptionDetails) {
            const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
            throw new Error(`Read-only evaluation rejected: ${scrubSensitiveOutput(description, tab.sensitiveValues)}`);
          }
          const value = response.result.value ?? response.result.description ?? null;
          const output = typeof value === "string" ? value : JSON.stringify(value, null, 2);
          return textResult(
            truncateOutput(redactTabText(tab, `Tab: ${tab.id}\nRead-only result:\n${output ?? "undefined"}`)),
            sanitizeTabValue(tab, { tabId: tab.id, url: safePageUrl(tab), readOnly: true }),
          );
        } finally {
          await client.detach().catch(() => {});
        }
      });
    },
  });

  pi.registerTool({
    name: "web_dialog",
    label: "Web Dialog",
    description: "Inspect, explicitly accept, or explicitly dismiss a pending JavaScript dialog. Dialogs are never auto-dismissed.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("accept"), Type.Literal("dismiss")]),
      dialog_id: Type.Optional(Type.String()), prompt_text: Type.Optional(Type.String()), tab_id: tabIdParam,
    }),
    async execute(_id, params, signal) {
      return withTab(params.tab_id, signal, async (tab) => {
        const pending = tab.pendingDialog;
        if (params.action === "list") {
          if (!pending) return textResult(`Tab ${tab.id} has no pending dialog.`, { tabId: tab.id, pending: false });
          return textResult(`Tab: ${tab.id}\nDialog: ${pending.id}\nType: ${pending.dialog.type()}\nMessage: ${truncateOutput(redactTabText(tab, pending.dialog.message()))}`, { tabId: tab.id, dialogId: pending.id, type: pending.dialog.type() });
        }
        if (!pending) throw new Error(`Tab ${tab.id} has no pending dialog.`);
        if (params.dialog_id && params.dialog_id !== pending.id) throw new Error(`Stale dialog_id ${params.dialog_id}; pending dialog is ${pending.id}.`);
        const category = params.prompt_text
          ? classifySensitiveText(params.prompt_text, { tag: "dialog prompt", label: pending.dialog.message() })
          : undefined;
        if (category) blockSensitiveResearchAction(`enter text into ${pending.dialog.type()} dialog`, category);
        const settleDialog = async () => {
          if (tab.pendingDialog === pending) tab.pendingDialog = undefined;
          try {
            if (params.action === "accept") await pending.dialog.accept(params.prompt_text);
            else await pending.dialog.dismiss();
            // A JavaScript dialog can interrupt Puppeteer's synthetic click after
            // mouse-down. Resetting input state prevents the next click from
            // failing with “left is already pressed”.
            await tab.page.mouse.reset();
          } catch (error) {
            tab.pendingDialog ??= pending;
            throw error;
          }
        };
        const outcome = await waitForActionOutcome(tab, settleDialog, signal, "dialog");
        const rendered = await renderObservation(
          tab,
          `${params.action === "accept" ? "Accepted" : "Dismissed"} ${pending.id}${params.prompt_text ? " (prompt value hidden)" : ""}.\nOutcome: ${formatOutcome(outcome)}`,
          signal,
        );
        const safeText = params.prompt_text ? redactExact(rendered.text, params.prompt_text) : rendered.text;
        return textResult(truncateOutput(safeText), {
          ...rendered.details,
          dialogId: pending.id,
          action: params.action,
          outcome,
          promptValueRedacted: Boolean(params.prompt_text),
        });
      });
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search Google through a CAPTCHA-aware shared queue and return compact organic results with destination URLs instead of Google redirect URLs.",
    parameters: Type.Object({ query: Type.String(), num_results: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, signal, update) {
      const category = classifySensitiveText(params.query, { tag: "search", label: "search query", name: "q" });
      if (category) blockSensitiveResearchAction("send search query", category);
      return googleSearchQueue.run(async () => {
        let tab: TabState | undefined;
        let keepOpen = false;
        try {
          if (googleCaptcha) {
            const captchaTab = googleCaptcha.tab;
            if (await googleCaptchaIsOpen(captchaTab, signal)) {
              activeTabId = captchaTab.id;
              await runAbortable(captchaTab.page.bringToFront(), signal, () => cancelPageOperation(captchaTab.page));
              if (googleCaptcha.timedOut) return googleCaptchaResult(captchaTab, false);
              update?.({
                content: [{ type: "text", text: `Google CAPTCHA is open in ${captchaTab.id}; this search is paused before its request is sent.` }],
                details: { tabId: captchaTab.id, captcha: true, otherSearchesPaused: true },
              });
              if (!await waitForGoogleCaptchaResolution(captchaTab, signal)) return googleCaptchaResult(captchaTab, true);
            } else {
              googleCaptcha = undefined;
            }
          }

          tab = await createTab(signal, false);
          return await tab.queue.run(async () => {
            update?.({ content: [{ type: "text", text: `Searching in ${tab!.id}` }], details: {} });
            await navigate(tab!, `https://www.google.com/search?q=${encodeURIComponent(params.query)}&num=${params.num_results ?? 10}&hl=en`, signal);
            if (await googleCaptchaIsOpen(tab!, signal)) {
              keepOpen = true;
              update?.({
                content: [{
                  type: "text",
                  text: `Google presented a CAPTCHA in ${tab!.id}. Other Google searches are paused; solve it in the visible Chrome window to resume automatically.`,
                }],
                details: { tabId: tab!.id, captcha: true, needsUserAction: true, otherSearchesPaused: true },
              });
              if (!await waitForGoogleCaptchaResolution(tab!, signal)) return googleCaptchaResult(tab!, true);
              keepOpen = false;
              update?.({
                content: [{ type: "text", text: `CAPTCHA cleared in ${tab!.id}; resuming this search and the queued Google searches.` }],
                details: { tabId: tab!.id, captchaCleared: true },
              });
            }

            const results = await runAbortable(tab!.page.evaluate(() => {
              const area = document.querySelector("#rso") ?? document.querySelector("#search");
              if (!area) return [];
              const seen = new Set<string>();
              const output: Array<{ title: string; url: string; snippet: string }> = [];
              for (const link of area.querySelectorAll<HTMLAnchorElement>("a:has(h3)")) {
                const title = link.querySelector("h3")?.textContent?.trim() ?? "";
                const url = link.href;
                if (!title || !url || url.includes("#:~:text=") || seen.has(url)) continue;
                seen.add(url);
                let container: Element = link;
                while (container.parentElement && container.parentElement !== area) container = container.parentElement;
                const snippet = container.querySelector("[data-sncf],.VwiC3b,.IsZvec")?.textContent?.trim() ?? "";
                output.push({ title, url, snippet });
              }
              return output;
            }), signal, () => cancelPageOperation(tab!.page));

            const userAgent = await tab!.page.browser().userAgent();
            const canonicalResults: Array<{ title: string; url: string; snippet: string }> = [];
            const seenDestinations = new Set<string>();
            const resultLimit = params.num_results ?? 10;
            for (const result of results) {
              if (canonicalResults.length >= resultLimit) break;
              const url = await resolveGoogleResultUrl(result.url, {
                signal,
                userAgent,
                referrer: tab!.page.url(),
              });
              if (seenDestinations.has(url)) continue;
              seenDestinations.add(url);
              canonicalResults.push({ ...result, url });
            }
            const text = canonicalResults.length
              ? canonicalResults.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`).join("\n\n")
              : "No structured results were found (a consent page or changed markup may be present).";
            const displayedQuery = category ? `[${category} hidden]` : params.query;
            return textResult(
              truncateOutput(redactTabText(tab!, `Search results for: ${displayedQuery}\n\n${text}`)),
              {
                tabId: tab!.id,
                queryRedacted: Boolean(category),
                resultCount: canonicalResults.length,
                results: canonicalResults,
              },
            );
          }, signal);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw new Error(scrubSensitiveOutput(errorMessage(error), [params.query]));
        } finally {
          if (tab && !keepOpen && googleCaptcha?.tab !== tab && !tab.page.isClosed()) {
            await tab.queue.run(() => tab!.page.close().then(() => undefined)).catch(() => {});
          }
        }
      }, signal);
    },
  });

  pi.on("session_start", async (_event, ctx) => { ctx.ui.notify("Web browser tools loaded (tab and safety support enabled)", "info"); });
  pi.on("session_shutdown", async () => { disconnect(); });

  function disconnect(): void {
    browserCdp?.detach().catch(() => {});
    browserCdp = null;
    downloadTrackingReady = false;
    downloadBrowserPath = undefined;
    downloadLocalPath = undefined;
    downloads.clear();
    for (const tab of tabs.values()) {
      tab.attached = false;
      tab.frameTrackingReady = false;
    }
    browser?.disconnect();
    browser = null;
    browserConnectPromise = null;
    // Preserve tab IDs and sensitive-value redaction state for a later reconnect.
    // The next connection reconciles this map with Chrome's live targets.
  }

  pi.registerCommand("web-close", {
    description: "Disconnect from the shared Chrome instance",
    handler: async (_args, ctx) => { disconnect(); ctx.ui.notify("Disconnected from browser", "info"); },
  });
  pi.registerCommand("web-status", {
    description: "Show browser and active-tab status",
    handler: async (_args, ctx) => {
      const active = activeTabId ? tabs.get(activeTabId) : undefined;
      const status = browser?.connected
        ? `Browser connected; ${tabs.size} tab(s)\nActive: ${active?.id ?? "none"}\n${active ? redactTabText(active, safePageUrl(active)) : ""}${downloadLocalPath ? `\nDownloads: ${downloadLocalPath}` : ""}${popupTrackingError ? `\nPopup tracking degraded: ${scrubSensitiveOutput(popupTrackingError)}` : ""}`
        : "Browser not connected (connects on first use)";
      ctx.ui.notify(status, "info");
    },
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: scrubSensitiveOutput(text) }],
    details: scrubOutputValue(details) as Record<string, unknown>,
  };
}

function formatOutcome(outcome: ActionOutcome): string {
  const extras = outcome.events.map((event) => {
    if (event.kind === "popup") return `new tab ${event.tabId}`;
    if (event.kind === "dialog") return `pending ${event.dialogId} (${event.dialogType})`;
    const location = event.state === "completed" && event.localDirectory ? ` in ${event.localDirectory}` : "";
    return `download ${event.suggestedFilename} ${event.state}${location}`;
  });
  return `${outcome.kind}${extras.length ? `; ${extras.join(", ")}` : ""}${outcome.operationWarning ? `; warning: ${outcome.operationWarning}` : ""}`;
}

function safeDestination(url: string): string {
  try { return new URL(url).origin; } catch { return "requested URL"; }
}

function redactExact(text: string, secret: string): string {
  return scrubSensitiveOutput(text, [secret]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cancelPageOperation(page: Page, pressEscape = true): Promise<void> {
  const client = await page.createCDPSession().catch(() => undefined);
  try {
    await Promise.all([
      client?.send("Page.stopLoading").catch(() => undefined),
      pressEscape ? page.keyboard.press("Escape").catch(() => undefined) : Promise.resolve(),
    ]);
  } finally {
    await client?.detach().catch(() => {});
  }
}

function delay(milliseconds: number): Promise<"no-change"> {
  return delayValue(milliseconds, "no-change");
}

function delayValue<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds));
}

async function resolveDownloadPaths(): Promise<{ browserPath: string; localPath: string }> {
  const configured = process.env.PI_BROWSER_DOWNLOAD_DIR;
  if (configured) {
    const localPath = windowsPathToWsl(configured) ?? configured;
    await mkdir(localPath, { recursive: true });
    return { browserPath: configured, localPath };
  }

  // Chrome runs on Windows in the normal WSL setup, so CDP needs a Windows
  // path—not Node's Linux /tmp path. Keep a WSL path for verification/reporting.
  try {
    const windowsTemp = execFileSync("cmd.exe", ["/d", "/c", "echo", "%TEMP%"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    }).replace(/\r/g, "").trim();
    if (windowsTemp && windowsTemp !== "%TEMP%") {
      const browserPath = `${windowsTemp.replace(/[\\/]+$/, "")}\\pi-web-browser-downloads`;
      const localPath = windowsPathToWsl(browserPath);
      if (localPath) {
        await mkdir(localPath, { recursive: true });
        return { browserPath, localPath };
      }
    }
  } catch {}

  const localPath = join(tmpdir(), "pi-web-browser-downloads");
  await mkdir(localPath, { recursive: true });
  return { browserPath: localPath, localPath };
}


