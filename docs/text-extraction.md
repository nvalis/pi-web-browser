# Web Text Extraction — Design & Strategy

## Overview

Text extraction and interactive element listing are the two main outputs of `web_navigate`, `web_click`, `web_back`, and `web_read_page`. Both are designed to produce compact, LLM-friendly output.

## Text Extraction (`extractReadableText`)

### Approach: DOM-to-Markdown conversion

Instead of dumping raw text nodes, we walk the live DOM and convert structural elements to markdown syntax. This preserves document semantics that help the LLM understand page content.

| HTML Element | Markdown Output |
|---|---|
| `<h1>`–`<h6>` | `# ` – `###### ` headings |
| `<p>` | Paragraph with blank line after |
| `<li>` | `- ` bullet item |
| `<a href="...">text</a>` | `[text](url)` |
| `<strong>`, `<b>` | `**bold**` |
| `<em>`, `<i>` | `*italic*` |
| `<code>` | `` `inline code` `` |
| `<pre><code>` | Fenced code block with language |
| `<tr>` with `<td>`/`<th>` | `\| col1 \| col2 \|` table row |
| `<hr>` | `---` |

### Content area detection

Progressive fallback chain to find the main content, avoiding nav/sidebar/footer noise:

```
article → main → [role='main'] → #readme → .markdown-body →
.post-content → .entry-content → .article-content →
.content → #content → .repository-content → .container-lg → body
```

Only falls back to `<body>` if none of the specific selectors match.

### Noise filtering

Elements matching these selectors are skipped entirely during the walk:

- `nav, header, footer, aside`
- `[role='navigation'], [role='banner'], [role='contentinfo']`
- `[aria-hidden='true']`
- `.cookie-banner, .site-header, .site-footer, .sidebar, .ad`

Script/style/SVG/iframe/noscript tags are also skipped.

### Why this works for JS-rendered pages

The extraction reads the **live DOM**, so it captures content rendered by JavaScript frameworks (React, Vue, Svelte, etc.). Navigation waits for `DOMContentLoaded`; subsequent actions use navigation and DOM-mutation events rather than unconditional sleeps, and `web_read_page` can issue a fresh observation after later SPA updates.

## Interactive Elements (`getInteractiveElements`)

### Compact format

Old format (verbose, ~100 chars per element):
```
[0] <a href="https://github.com/features/copilot"> GitHub CopilotWrite better code with AI
```

New format (~40 chars per element):
```
[0] a "GitHub Copilot" -> /features/copilot
[1] button "Sign in"
[2] input[text] name="q" "Search..."
```

Rules:
- Same-origin URLs shortened to path-only
- Tag brackets and redundant attributes dropped
- Human label in quotes, target after `->`

### Prioritization

Elements are sorted by importance:

| Priority | Type | Rationale |
|---|---|---|
| 0 | `input`, `textarea`, `select` | Always needed for form interaction |
| 1 | `button`, `[role='button']`, `[role='tab']` | Action triggers |
| 2 | Links inside content area | Most relevant to the page's topic |
| 3 | Links outside content area (chrome) | Nav, footer, sidebar links |

### Deduplication

- Links are deduplicated by base href (stripped of query and fragment)
- When duplicates exist, the first one encountered is kept
- Chrome links with no visible text label are dropped entirely

### Cap

Hard cap at **60 elements**. Overflow shows a count:
```
… and 155 more elements (use a CSS selector or re-read after narrowing the page)
```

Elements beyond the cap are still tagged, but every numeric action must include the exact `observation_generation` returned by the read that created the index. A changed document or newer observation makes the index fail closed instead of silently retargeting it. `web_eval` is read-only and is not an interaction escape hatch.

### Content area detection

Uses the same selector chain as text extraction to determine which elements are "in content" vs "chrome". This is what drives the priority 2 vs 3 distinction.

## Results

### Before (GitHub repo page)
- **Text**: 4KB of raw text dump — file names, commit hashes, nav links, sidebar metadata all mixed together
- **Elements**: 275 entries, mostly GitHub platform chrome

### After (same page)
- **Text**: Clean markdown of the README with headings, lists, bold, links
- **Elements**: 60 entries — input first, then buttons, then README links, then capped chrome
