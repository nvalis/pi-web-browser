export function windowsPathToWsl(path: string): string | undefined {
  const match = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return undefined;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function isGoogleHostname(hostname: string): boolean {
  return /^(?:[^.]+\.)*google\.[a-z.]+$/i.test(hostname);
}

function httpUrl(value: string, base?: string): string | undefined {
  try {
    const parsed = new URL(value, base);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Return an HTTP destination embedded in a conventional Google result redirect URL. */
export function embeddedGoogleResultDestination(urlText: string): string | undefined {
  const parsedUrl = httpUrl(urlText);
  if (!parsedUrl) return undefined;
  const parsed = new URL(parsedUrl);
  if (!isGoogleHostname(parsed.hostname)) return parsed.href;
  if (!/^\/(?:url|goto|imgres)$/.test(parsed.pathname)) return undefined;
  for (const name of ["url", "q", "imgurl"]) {
    const destination = parsed.searchParams.get(name);
    if (!destination) continue;
    const resolved = httpUrl(destination, parsed.href);
    if (resolved && !isGoogleHostname(new URL(resolved).hostname)) return resolved;
  }
  return undefined;
}

export interface GoogleResultUrlResolutionOptions {
  signal?: AbortSignal;
  userAgent?: string;
  referrer?: string;
  fetcher?: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
}

/**
 * Resolve Google's conventional and opaque result redirect URLs without loading
 * the destination document. Unresolvable URLs are returned unchanged.
 */
export async function resolveGoogleResultUrl(
  urlText: string,
  options: GoogleResultUrlResolutionOptions = {},
): Promise<string> {
  const original = httpUrl(urlText);
  if (!original) return urlText;
  const direct = embeddedGoogleResultDestination(original);
  if (direct) return direct;
  if (!isGoogleHostname(new URL(original).hostname)) return original;

  const fetcher = options.fetcher ?? fetch;
  let current = original;
  for (let index = 0; index < (options.maxRedirects ?? 4); index += 1) {
    throwIfAborted(options.signal);
    let response: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5000);
      response = await fetcher(current, {
        method: "GET",
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
        headers: {
          ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
          ...(options.referrer ? { referer: options.referrer } : {}),
        },
      });
    } catch (error) {
      throwIfAborted(options.signal);
      return original;
    }
    const location = response.headers.get("location");
    if (!location) return original;
    const next = httpUrl(location, current);
    if (!next) return original;
    const embedded = embeddedGoogleResultDestination(next);
    if (embedded) return embedded;
    if (!isGoogleHostname(new URL(next).hostname)) return next;
    current = next;
  }
  return original;
}

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const slotDone = new Promise<void>((resolve) => { release = resolve; });
    this.tail = previous.then(() => slotDone);
    try {
      await waitForTurn(previous, signal);
      throwIfAborted(signal);
      return await operation();
    } finally {
      release();
    }
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  throwIfAborted(signal);
  let abortHandler!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => reject(abortError(signal));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

/**
 * Observe aborts while retaining ownership of the queue slot until both the
 * cancellation hook and underlying operation settle. This prevents an aborted
 * Puppeteer command from racing the next command on the same tab.
 */
export async function waitForSharedOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function runAbortable<T>(operation: Promise<T>, signal?: AbortSignal, cancel?: () => Promise<void>): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    await Promise.resolve().then(cancel).catch(() => {});
    await operation.catch(() => undefined);
    throw abortError(signal);
  }
  let aborted = false;
  let cancellation: Promise<void> = Promise.resolve();
  const onAbort = () => {
    aborted = true;
    cancellation = Promise.resolve().then(cancel).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await operation.catch((error) => { operationError = error; return undefined as T; });
    await cancellation;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (aborted || signal.aborted) throw abortError(signal);
  if (operationError !== undefined) throw operationError;
  return value as T;
}

export async function waitForActionSettlement<T>(options: {
  perform: () => Promise<void>;
  highPriority: Promise<T>;
  domQuiet: () => Promise<T>;
  deadline: () => Promise<T>;
  signal?: AbortSignal;
  cancel?: () => Promise<void>;
}): Promise<T> {
  await runAbortable(options.perform(), options.signal, options.cancel);
  return runAbortable(
    Promise.race([options.highPriority, options.domQuiet(), options.deadline()]),
    options.signal,
    options.cancel,
  );
}

export type SensitiveCategory =
  | "authentication secret"
  | "payment data"
  | "government identifier"
  | "contact or address data"
  | "private key or access token"
  | "health data";

export interface ElementSafetyMetadata {
  tag: string;
  label: string;
  inputType?: string;
  name?: string;
  autocomplete?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  role?: string;
}

export interface RiskClassification {
  confirmationRequired: boolean;
  action: string;
  reason?: string;
  dataCategory?: SensitiveCategory;
}

const RISKY_ACTIONS: Array<[RegExp, string]> = [
  [/\b(buy|purchase|place order|pay|checkout|subscribe|donate|book|reserve|transfer|wire|withdraw|deposit|send money|fund)\b/i, "financial or contractual transaction"],
  [/\b(delete|remove|destroy|erase|wipe|purge|clear all|reset all|factory reset|cancel account|close account|unsubscribe|revoke|log out|logout|sign out|create account|register account)\b/i, "destructive or account-changing action"],
  [/\b(send|submit|post|publish|share|upload|confirm|approve|sign|accept offer|like|unlike|react|upvote|downvote|reply|comment|follow|unfollow|connect|endorse|rate|review|message)\b/i, "representational communication or external side effect"],
  [/\b(install|open application|allow|grant|authorize|permission)\b/i, "permission-changing or software-installation action"],
  [/\b(captcha|i am human|i'm human|not a robot|verify you are human)\b/i, "CAPTCHA or human-verification action"],
];

export function classifyElementAction(meta: ElementSafetyMetadata): RiskClassification {
  const combined = [meta.label, meta.name, meta.href, meta.formAction].filter(Boolean).join(" ");
  for (const [pattern, reason] of RISKY_ACTIONS) {
    if (pattern.test(combined)) return { confirmationRequired: true, action: describeElement(meta), reason };
  }
  if ((meta.formMethod ?? "").toLowerCase() === "post" && /submit|button/i.test(`${meta.inputType} ${meta.tag}`)) {
    return { confirmationRequired: true, action: describeElement(meta), reason: "form submission with an external side effect" };
  }
  const clearlyLocal = /\b(expand|collapse|show|hide|open menu|close menu|next tab|previous tab|zoom|scroll|play|pause)\b/i.test(combined);
  const actionCapable = meta.tag === "button" || meta.role === "button" || /^(?:button|submit|reset|checkbox|radio)$/i.test(meta.inputType ?? "");
  if (actionCapable && !clearlyLocal) {
    return { confirmationRequired: true, action: describeElement(meta), reason: "unclassified action-capable control" };
  }
  return { confirmationRequired: false, action: describeElement(meta) };
}

export function actionDestination(meta: ElementSafetyMetadata, currentUrl: string, submitting = false): string {
  const destination = submitting ? (meta.formAction || meta.href || currentUrl) : (meta.href || currentUrl);
  return displayDestination(destination, currentUrl);
}

export function displayDestination(destination: string, base?: string): string {
  try {
    const parsed = new URL(destination, base);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "current page";
  }
}

export function enforceAutonomousResearchRisk(risk: RiskClassification): void {
  if (!risk.confirmationRequired) return;
  // Autonomous research must be able to operate unfamiliar local UI and to
  // download source material without stopping for modal approval. Known
  // external side effects remain blocked rather than silently executed.
  if (risk.reason === "unclassified action-capable control" || risk.reason === "navigation may start a file download") return;
  throw new Error(`Blocked by autonomous research policy: ${risk.action}${risk.reason ? ` (${risk.reason})` : ""}.`);
}

export function blockSensitiveResearchAction(action: string, category: SensitiveCategory): never {
  throw new Error(`Blocked by autonomous research policy: ${action} would transmit ${category}.`);
}

export function classifySensitiveText(text: string, meta: ElementSafetyMetadata): SensitiveCategory | undefined {
  const field = `${meta.inputType ?? ""} ${meta.name ?? ""} ${meta.autocomplete ?? ""} ${meta.label}`.toLowerCase();
  if (/password|passcode|pin|one[- ]?time|otp|current-password|new-password/.test(field)) return "authentication secret";
  if (/api.?key|access.?token|auth.?token|secret|private.?key/.test(field)) return "private key or access token";
  if (/cc-|credit|debit|card.?number|cvv|cvc|payment/.test(field)) return "payment data";
  if (/ssn|social.?security|passport|driver.?licen[cs]e|national.?id|tax.?id/.test(field)) return "government identifier";
  if (/email|phone|mobile|address|postal|zip|street/.test(field)) return "contact or address data";
  if (/medical|health|diagnos|prescription|patient/.test(field)) return "health data";
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return "private key or access token";
  if (/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b|\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b/.test(text)) return "private key or access token";
  if (/\b(?:\d[ -]*?){13,19}\b/.test(text)) return "payment data";
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return "government identifier";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())) return "contact or address data";
  return undefined;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[private key hidden]"],
  [/\b(?:ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-?[A-Za-z0-9-]{12,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16})\b/g, "[access token hidden]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [access token hidden]"],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials hidden]@"],
];

export function scrubSensitiveOutput(text: string, remembered: Iterable<string> = []): string {
  let output = text;
  for (const value of remembered) {
    if (!value) continue;
    output = output.split(value).join("[sensitive value hidden]");
    output = output.split(encodeURIComponent(value)).join("[sensitive value hidden]");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

export function scrubOutputValue(value: unknown, remembered: Iterable<string> = []): unknown {
  if (typeof value === "string") return scrubSensitiveOutput(value, remembered);
  if (Array.isArray(value)) return value.map((entry) => scrubOutputValue(entry, remembered));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubOutputValue(entry, remembered)]));
  }
  return value;
}

export function validateObservationGeneration(input: {
  requested?: number;
  observed: number;
  observedDocument: number;
  currentDocument: number;
  observedDom: number;
  currentDom: number;
}): void {
  if (input.requested === undefined) throw new Error("generation is required when acting by numeric index. Re-read the page and pass its observation_generation.");
  if (
    input.requested !== input.observed ||
    input.observedDocument !== input.currentDocument ||
    input.observedDom !== input.currentDom
  ) throw new Error(`Stale element index generation ${input.requested}. Current observation_generation is ${input.observed}; the document or DOM changed, so re-read the page before acting.`);
}

export async function installRequiredCapability<T>(name: string, setup: () => Promise<T>): Promise<T> {
  try {
    return await setup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot install required ${name}: ${scrubSensitiveOutput(message)}`);
  }
}

export interface ActionCapabilities {
  downloadTracking: boolean;
  frameTracking: boolean;
  popupTrackingError?: string;
}

export function assertScreenshotAllowed(hasSensitiveData: boolean): void {
  if (hasSensitiveData) throw new Error("Screenshot blocked because sensitive data was entered in this tab; screenshots could expose it.");
}

export function requireActionCapabilities(capabilities: ActionCapabilities): void {
  if (!capabilities.downloadTracking) throw new Error("Blocked: download event tracking is unavailable; browser actions fail closed.");
  if (!capabilities.frameTracking) throw new Error("Blocked: tab frame tracking is unavailable; downloads cannot be correlated safely.");
  if (capabilities.popupTrackingError) throw new Error(`Blocked: popup tracking is degraded: ${scrubSensitiveOutput(capabilities.popupTrackingError)}`);
}

export const READ_ONLY_EVALUATE_OPTIONS = Object.freeze({
  returnByValue: true,
  throwOnSideEffect: true,
  awaitPromise: false,
  timeout: 5000,
  disableBreaks: true,
  allowUnsafeEvalBlockedByCSP: false,
});

export function classifyUrl(urlText: string): RiskClassification {
  let url: URL;
  try { url = new URL(urlText); }
  catch { return { confirmationRequired: false, action: `navigate to ${urlText}` }; }
  if (url.username || url.password) return { confirmationRequired: true, action: `navigate to ${url.origin}`, reason: "URL transmits embedded credentials", dataCategory: "authentication secret" };
  if (/\.(?:exe|msi|dmg|pkg|deb|rpm|apk|crx|zip|tar|gz|7z|pdf|docx?|xlsx?)$/i.test(url.pathname)) {
    return { confirmationRequired: true, action: `navigate to downloadable content on ${url.origin}`, reason: "navigation may start a file download" };
  }
  for (const [name, value] of url.searchParams) {
    const category = classifySensitiveText(value, { tag: "url", label: name, name });
    if (category) return { confirmationRequired: true, action: `navigate to ${url.origin}`, reason: "URL query transmits sensitive data", dataCategory: category };
  }
  return { confirmationRequired: false, action: `navigate to ${url.origin}` };
}

function describeElement(meta: ElementSafetyMetadata): string {
  const label = meta.label.trim().slice(0, 80);
  return label ? `${meta.tag} “${label}”` : meta.tag;
}
