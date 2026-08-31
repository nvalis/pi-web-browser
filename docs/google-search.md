# Google Search — Extraction Strategy

## DOM Analysis (April 2026)

Google's search results page no longer uses `.g` class containers. The current structure:

```
#rso                          ← results container
  > div.MjjYud               ← one per result block (class name is unstable!)
      a > h3.LC20lb           ← result link containing title (STABLE pattern)
      [data-sncf] / .VwiC3b  ← snippet text
  > div.MjjYud               ← "People also ask" section
      [data-initq]           ← distinguishing attribute for PAA
      a > h3                 ← PAA answer links (have #:~:text= in URL)
  > div.ULSxyf               ← videos section
```

### What's stable (structural invariants)

| Pattern | Why it's reliable |
|---|---|
| `<a>` containing `<h3>` = organic result | Google needs clickable titled links for SEO/accessibility |
| `#rso` or `#search` as results container | Core structural IDs, stable for years |
| `[data-initq]` marks PAA sections | PAA needs a query attribute for lazy-loading answers |
| `#:~:text=` in URLs = highlight-fragment links | Chrome text-fragment spec, used for PAA answer links |
| `[data-sncf]` for snippet text | Semantic snippet container (present on most results) |

### What's fragile (avoid relying on)

| Pattern | Why it breaks |
|---|---|
| `.g` result container | **Already gone** as of 2026 |
| `.VwiC3b` snippet class | Changes periodically; use as fallback only |
| `.MjjYud` wrapper class | Obfuscated, could change any time |
| Specific nesting depth | Google frequently adds/removes wrapper divs |

## Current Implementation

### Extraction approach

1. **Find `#rso` or `#search`** as the search area
2. **Query `a:has(h3)`** — every organic result has a link wrapping an h3
3. **Filter out noise:**
   - Skip `#:~:text=` URLs (common PAA answer highlights)
   - Deduplicate exact destination URLs
4. **Extract snippet** from the first matching fallback selector:
   - `[data-sncf]` (semantic snippet marker)
   - `.VwiC3b`, `.IsZvec` (known classes, as fallbacks)
5. Resolve result destinations:
   - Conventional `/url?q=...` redirects are decoded locally.
   - Opaque `/goto?url=...` redirects are requested with `redirect: "manual"`, the browser user agent, and the search-page referrer. The `Location` header yields the destination without loading the publisher page.
   - Failed resolution preserves the original URL rather than guessing.
6. Deduplicate resolved destination URLs and return them in both text output and `details.results`. No additional text cleanup or PAA-container traversal is currently applied.

### Consent, CAPTCHA, and tab handling

- **Cookie consent:** Consent is not auto-clicked. If Google presents consent instead of results, the tool reports that no structured results were found; use the managed tab tools to inspect and click the visible consent control autonomously.
- **CAPTCHA detection and coordination:** Checks common CAPTCHA elements and human-verification text. All Google searches share a serial request queue, so only one can reach Google at a time. On detection, the managed search tab is retained, selected, and brought to the front while the extension polls for manual completion. Queued searches remain paused before sending requests. If the CAPTCHA clears within `PI_BROWSER_CAPTCHA_WAIT_MS` (120 seconds by default), extraction and queued searches resume automatically. After timeout, the CAPTCHA tab remains preserved and subsequent queued calls report the same blocked tab without sending more Google requests.
- **Tab isolation:** Each search uses a managed temporary tab. The shared Google queue prevents concurrent search navigation; tabs are closed after extraction unless retained for CAPTCHA inspection.
- **Locale pinning:** `&hl=en` in search URL stabilizes DOM structure across geolocations.

## Future Considerations

- If Google keeps blocking, consider DuckDuckGo HTML (`https://html.duckduckgo.com/html/?q=...`) as a fallback — no consent walls, simpler/stable HTML, no API key needed
- Monitor whether `a:has(h3)` remains the reliable pattern; `:has()` is well-supported in modern Chrome
- Dedicated PAA-container filtering could be added using `[data-initq]` if text-fragment filtering becomes insufficient; that marker may change with Google's lazy-loading implementation.
