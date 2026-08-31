# Pi Web Browser extension

Puppeteer/CDP browser tools for a Chrome instance exposed at `CHROME_REMOTE_HOST:CHROME_REMOTE_PORT` (defaults to the WSL Windows host and port 9222).

On first browser-tool use, the extension probes the configured Chrome debugger endpoint and, when it is unavailable, selects a launcher for the current platform:

- **WSL:** starts a visible, dedicated Windows Chrome instance through `powershell.exe`.
- **Native Linux:** discovers `google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser` on `PATH` and spawns it detached with a dedicated profile.
- **Other platforms:** reports how to start Chrome manually with the remote-debugging flag.

Both automatic launchers wait up to 15 seconds for CDP. The visible window allows the user to complete CAPTCHAs when needed. `launch-chrome.bat` remains available as a WSL/Windows manual fallback.

Set `PI_BROWSER_PREVENT_AUTO_LAUNCH=1` to disable automatic startup. On native Linux, `PI_BROWSER_CHROME_EXECUTABLE` overrides executable discovery, `PUPPETEER_EXECUTABLE_PATH` is accepted as a fallback, and `PI_BROWSER_CHROME_USER_DATA_DIR` overrides the default dedicated profile at `/tmp/chrome-pi-debug`.

## Installation

Install the private GitHub package over SSH.
Without a ref, Pi installs the repository's default branch.
Configure a GitHub SSH key first, then verify it with `ssh -T git@github.com`.

```sh
pi install ssh://git@github.com/nvalis/pi-web-browser
```

To try it for one Pi invocation without adding it to settings:

```sh
pi -e ssh://git@github.com/nvalis/pi-web-browser
```

Run `/reload` after changing an already loaded installation. Pi installs the runtime dependencies declared in `package.json` automatically.

## Tabs and coherent observations

- `web_tabs` supports `list`, `new`, `select`, and `close`. Every page/pop-up receives a stable `tab-N` ID. Existing tools use the active tab unless `tab_id` is supplied.
- Every operation, including reads, is serialized through a dedicated per-tab queue. Browser tab bookkeeping uses a separate queue.
- `web_navigate`, `web_read_page`, `web_click`, and `web_back` return `documentGeneration` and `observationGeneration` in details and print both in observations.
- Numeric element indices are valid only for the exact observation that produced them. Pass that value as `generation` to `web_click` or `web_type`. Calls without it fail closed. CSS selectors remain available for deliberate selector-based use.

## Synchronization and outcomes

Clicks, ordinary typing, Enter submissions, and dialog resolution watch navigation, DOM mutations, JavaScript dialogs, pop-ups/new tabs, and browser download events. A mutation is provisional: click/submit monitoring continues until the DOM has been quiet for 500 ms, while ordinary typing can settle after 500 ms without another `input` event so field edits do not incur the full deadline. Higher-priority navigation/dialog/popup/download signals win. Dialog accept/dismiss establishes monitoring before resolving the dialog and returns the same outcome metadata. Results report `navigation`, `dom-update`, `no-change`, `dialog`, `popup`, or `download`. Tool aborts request `Page.stopLoading`/Escape and retain the per-tab queue slot until both cancellation acknowledgement and the underlying Puppeteer operation settle.

Frame, popup, and download tracking are safety capabilities rather than best-effort extras. Connection fails if frame/download CDP setup cannot be installed, and actions—including dialog resolution—fail closed if popup registration later degrades. Shared connection setup is process-wide and independent of any one tool's abort signal; each caller can stop waiting without cancelling setup needed by concurrent callers.

Page-created JavaScript dialogs are never auto-dismissed. Use `web_dialog list`, then explicitly `accept` or `dismiss`; these tool calls do not open a separate host confirmation modal. Resolving a dialog resets Puppeteer's mouse state because a dialog can interrupt a synthetic click between mouse-down and mouse-up.

Downloads are tracked through completion or cancellation. In the normal WSL/Windows setup, the extension gives Chrome a Windows `%TEMP%\\pi-web-browser-downloads` path and reports the corresponding WSL-visible `/mnt/c/...` directory. For a locally running Linux Chrome it falls back to the Linux temporary directory. `PI_BROWSER_DOWNLOAD_DIR` overrides this and must be a path understood by the Chrome process (a Windows path for Windows Chrome).

## Autonomous research safety policy

Browser tools never open host confirmation dialogs. Page text remains untrusted, and safety is enforced non-interactively:

- Ordinary navigation, unfamiliar controls, local UI interactions, GET searches, and source downloads proceed autonomously.
- Known financial, destructive/account-changing, representational, publication/upload, permission/software-installation, and POST-submission actions are blocked with a tool error rather than prompting.
- CAPTCHAs are preserved and brought to the front in the visible Chrome window. Google searches share a request queue: once one search detects a CAPTCHA, later searches pause before sending requests while the extension polls for manual completion. If the user solves it within the wait window, the blocked search and queued searches resume automatically. The wait defaults to 120 seconds and is configurable with `PI_BROWSER_CAPTCHA_WAIT_MS`; after timeout, the tab remains preserved and results report `needsUserAction: true`.
- Sensitive values such as credentials, payment data, private identifiers, contact details, and access tokens are blocked before transmission. `web_type` never echoes entered values.
- A centralized scrubber removes standard tokens, credentials, and private keys from observations, evaluation results, details, and surfaced errors.

`web_eval` is extraction-only. It calls CDP `Runtime.evaluate` with `throwOnSideEffect: true`, `returnByValue: true`, no user gesture, and a timeout. Chrome rejects expressions whose lack of side effects cannot be established; there is no unsafe fallback.

`web_search` resolves conventional and opaque Google result redirects before returning results. Opaque `/goto` links are resolved with a manual-redirect request using the browser user agent and search-page referrer, so the destination URL is captured without loading the destination document. Both the text output and structured `details.results` contain these destination URLs; an unresolvable redirect is retained rather than guessed.

Safety classification is heuristic. Unfamiliar controls are allowed to keep research autonomous, so agents should still inspect visible state and avoid actions unrelated to the research task.

## Validation

```sh
npm test       # pure queue and safety tests; no Chrome required
npm run typecheck
npm run check  # both
```

The normal validation commands do not launch or require Chrome. Automatic Windows startup was additionally smoke-tested on an isolated debugger port from WSL. Native Linux launcher selection, executable discovery, and launch arguments are covered by unit tests; an end-to-end native launch requires a Linux desktop with Chrome or Chromium installed.
