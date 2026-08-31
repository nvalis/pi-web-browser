import type { ElementHandle, Page } from "puppeteer";
import type { ElementSafetyMetadata } from "./core.ts";

export interface PageObservation {
  title: string;
  url: string;
  readableText: string;
  interactiveText: string;
  elementCount: number;
  fingerprint: string;
  domGeneration: number;
}

export async function observePage(page: Page, observationGeneration: number): Promise<PageObservation> {
  const extracted = await page.evaluate((generation) => {
    const MAX_ELEMENTS = 60;
    const generationState = ((window as any).__piDomGenerationState ??= { value: 1, lastAt: performance.now(), observing: false });
    generationState.lastAt ??= performance.now();
    if (!generationState.observing) {
      generationState.observing = true;
      const observer = new MutationObserver((records) => {
        if (records.some((record) => !(
          record.type === "attributes" &&
          (record.attributeName === "data-pi-idx" || record.attributeName === "data-pi-generation")
        ))) {
          generationState.value += 1;
          generationState.lastAt = performance.now();
        }
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const contentSelectors = [
      "article", "main", "[role='main']", "#readme", ".markdown-body", ".post-content",
      ".entry-content", ".article-content", ".content", "#content", ".repository-content", ".container-lg",
    ];
    let root: Element | null = null;
    for (const selector of contentSelectors) {
      root = document.querySelector(selector);
      if (root) break;
    }
    root ??= document.body;

    const blockTags = new Set([
      "P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "DT", "DD", "DETAILS", "SUMMARY",
      "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TR", "TH", "TD", "PRE", "HR", "UL", "OL", "DL", "TABLE", "THEAD", "TBODY",
    ]);
    const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "TEMPLATE"]);
    const noise = new Set<Element>();
    root?.querySelectorAll(
      "nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],[aria-hidden='true'],.cookie-banner,.site-header,.site-footer,.sidebar,.ad,.advertisement",
    ).forEach((element) => noise.add(element));
    const output: string[] = [];

    const hidden = (element: Element): boolean => {
      if (noise.has(element)) return true;
      let parent = element.parentElement;
      while (parent && parent !== root) {
        if (noise.has(parent)) return true;
        parent = parent.parentElement;
      }
      const style = getComputedStyle(element);
      return style.display === "none" || style.visibility === "hidden";
    };
    const inlineText = (element: Element): string => {
      let text = "";
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const childElement = child as Element;
          if (skipTags.has(childElement.tagName) || hidden(childElement)) continue;
          if (childElement.tagName === "BR") text += "\n";
          else if (childElement.tagName === "CODE") text += `\`${(childElement.textContent ?? "").trim()}\``;
          else if (childElement.tagName === "A") {
            const label = (childElement.textContent ?? "").trim();
            const href = childElement.getAttribute("href") ?? "";
            text += label && href && !href.startsWith("javascript:") && !href.startsWith("#") ? `[${label}](${href})` : label;
          } else if (childElement.tagName === "STRONG" || childElement.tagName === "B") text += `**${(childElement.textContent ?? "").trim()}**`;
          else if (childElement.tagName === "EM" || childElement.tagName === "I") text += `*${(childElement.textContent ?? "").trim()}*`;
          else text += inlineText(childElement);
        }
      }
      return text;
    };
    const add = (line = "") => {
      if (line || output.at(-1) !== "") output.push(line);
    };
    const walk = (element: Element): void => {
      if (hidden(element) || skipTags.has(element.tagName)) return;
      const tag = element.tagName;
      if (/^H[1-6]$/.test(tag)) {
        add(); add(`${"#".repeat(Number(tag[1]))} ${(element.textContent ?? "").trim()}`); add(); return;
      }
      if (tag === "HR") { add(); add("---"); add(); return; }
      if (tag === "PRE") {
        const code = element.querySelector("code");
        const language = code?.className.match(/language-(\S+)/)?.[1] ?? "";
        add(); add(`\`\`\`${language}`);
        for (const line of (element.textContent ?? "").trimEnd().split("\n")) output.push(line);
        add("```"); add(); return;
      }
      if (tag === "LI") { const text = inlineText(element).replace(/\s+/g, " ").trim(); if (text) add(`- ${text}`); return; }
      if (tag === "TR") {
        const cells = [...element.querySelectorAll(":scope > th,:scope > td")].map((cell) => (cell.textContent ?? "").trim());
        if (cells.some(Boolean)) add(`| ${cells.join(" | ")} |`);
        return;
      }
      if (blockTags.has(tag)) {
        const container = ["DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "UL", "OL", "DL", "TABLE", "THEAD", "TBODY", "DETAILS"].includes(tag);
        if (container) for (const child of element.children) walk(child);
        else {
          const text = inlineText(element).replace(/\s+/g, " ").trim();
          if (text) add(text);
          if (tag === "P") add();
        }
        return;
      }
      const hasBlockChild = [...element.children].some((child) => blockTags.has(child.tagName));
      if (hasBlockChild || element.children.length > 3) for (const child of element.children) walk(child);
      else { const text = inlineText(element).replace(/\s+/g, " ").trim(); if (text) add(text); }
    };
    if (root) walk(root);
    const readableText = output.join("\n").replace(/\n{3,}/g, "\n\n").trim() || "(empty page)";

    document.querySelectorAll("[data-pi-idx]").forEach((element) => {
      delete (element as HTMLElement).dataset.piIdx;
      delete (element as HTMLElement).dataset.piGeneration;
    });

    const contentRoot = contentSelectors.map((selector) => document.querySelector(selector)).find(Boolean) ?? null;
    const seenHrefs = new Set<string>();
    const entries: Array<{ element: Element; priority: number; description: string }> = [];
    const candidates = document.querySelectorAll(
      "a[href],button,input,textarea,select,[role='button'],[role='link'],[role='tab']",
    );

    candidates.forEach((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if ((rect.width === 0 && rect.height === 0) || style.visibility === "hidden" || style.display === "none") return;

      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role") ?? "";
      const label = (
        (element as HTMLInputElement).labels?.[0]?.textContent ??
        element.getAttribute("aria-label") ??
        (element as HTMLInputElement).placeholder ??
        (element as HTMLElement).innerText ??
        element.textContent ??
        ""
      ).trim().replace(/\s+/g, " ").slice(0, 80);
      const href = element.getAttribute("href") ?? "";
      let priority = 3;
      let description = "";

      if (["input", "textarea", "select"].includes(tag)) {
        priority = 0;
        const type = element.getAttribute("type") ?? (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text");
        description = `${tag}[${type}]`;
        const name = element.getAttribute("name");
        if (name) description += ` name="${name.slice(0, 40)}"`;
        if (label) description += ` "${label}"`;
      } else if (tag === "button" || role === "button" || role === "tab") {
        if (!label) return;
        priority = 1;
        description = `${role === "tab" ? "tab" : "button"} "${label}"`;
      } else if (tag === "a" || role === "link") {
        if (href) {
          let normalized = href;
          try {
            const parsed = new URL(href, location.href);
            normalized = parsed.origin + parsed.pathname;
          } catch {}
          if (seenHrefs.has(normalized)) return;
          seenHrefs.add(normalized);
        }
        if (!label && !href) return;
        priority = contentRoot?.contains(element) ? 2 : 3;
        let displayHref = href;
        try {
          const parsed = new URL(href, location.href);
          if (parsed.origin === location.origin) displayHref = parsed.pathname + parsed.search + parsed.hash;
        } catch {}
        description = `a${label ? ` "${label}"` : ""}${displayHref ? ` -> ${displayHref.slice(0, 100)}` : ""}`;
      } else return;
      entries.push({ element, priority, description });
    });

    entries.sort((a, b) => a.priority - b.priority);
    entries.forEach((entry, index) => {
      (entry.element as HTMLElement).dataset.piIdx = String(index);
      (entry.element as HTMLElement).dataset.piGeneration = String(generation);
    });
    const lines = entries.slice(0, MAX_ELEMENTS).map((entry, index) => `[${index}] ${entry.description}`);
    if (entries.length > MAX_ELEMENTS) lines.push(`… and ${entries.length - MAX_ELEMENTS} more elements (use a CSS selector or re-read after narrowing the page)`);

    const bodyText = document.body?.innerText ?? "";
    return {
      title: document.title,
      url: location.href,
      readableText,
      interactiveText: lines.join("\n"),
      elementCount: entries.length,
      fingerprint: `${location.href}\n${document.title}\n${bodyText.length}\n${bodyText.slice(0, 2048)}`,
      domGeneration: generationState.value,
    };
  }, observationGeneration);
  return extracted;
}

export async function inspectElement(page: Page, selector: string): Promise<ElementSafetyMetadata | null> {
  const element = await page.$(selector);
  return element ? inspectElementHandle(element) : null;
}

export async function inspectElementHandle(element: ElementHandle<Element>): Promise<ElementSafetyMetadata> {
  return element.evaluate((node) => {
    const input = node as HTMLInputElement;
    const form = input.form;
    const submitter = node as HTMLButtonElement | HTMLInputElement;
    const nodeType = (submitter.type || (node.tagName === "BUTTON" ? "submit" : "")).toLowerCase();
    const isSubmitter = (node.tagName === "BUTTON" && nodeType === "submit") ||
      (node.tagName === "INPUT" && (nodeType === "submit" || nodeType === "image"));
    const hasFormActionOverride = isSubmitter && node.getAttribute("formaction") !== null;
    const resolvedFormAction = hasFormActionOverride ? submitter.formAction : form?.action;
    const label = (
      input.labels?.[0]?.textContent ??
      node.getAttribute("aria-label") ??
      input.placeholder ??
      (node as HTMLElement).innerText ??
      node.textContent ??
      ""
    ).trim().replace(/\s+/g, " ").slice(0, 120);
    return {
      tag: node.tagName.toLowerCase(),
      label,
      inputType: node.getAttribute("type") ?? undefined,
      name: node.getAttribute("name") ?? undefined,
      autocomplete: node.getAttribute("autocomplete") ?? undefined,
      href: node instanceof HTMLAnchorElement ? node.href : undefined,
      formAction: resolvedFormAction,
      formMethod: form?.method,
      role: node.getAttribute("role") ?? undefined,
    };
  });
}

export async function pageFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    return `${location.href}\n${document.title}\n${text.length}\n${text.slice(0, 2048)}`;
  });
}

export async function installMutationMarker(page: Page, token: string): Promise<void> {
  await page.evaluate((key) => {
    const markers = ((window as any).__piMutationMarkers ??= {});
    markers[key] = { count: 0, lastAt: performance.now(), inputCount: 0, lastInputAt: performance.now() };
    const observer = new MutationObserver(() => {
      markers[key].count += 1;
      markers[key].lastAt = performance.now();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const onInput = () => {
      markers[key].inputCount += 1;
      markers[key].lastInputAt = performance.now();
    };
    document.addEventListener("input", onInput, true);
    setTimeout(() => {
      observer.disconnect();
      document.removeEventListener("input", onInput, true);
    }, 10000);
  }, token);
}

export async function waitForPageQuiet(
  page: Page,
  token: string,
  domQuietMilliseconds: number,
  inputQuietMilliseconds: number | undefined,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  await page.waitForFunction(
    (key, domQuiet, inputQuiet) => {
      const marker = (window as any).__piMutationMarkers?.[key];
      if (!marker) return false;
      const domIsQuiet = marker.count > 0 && performance.now() - marker.lastAt >= domQuiet;
      const inputIsQuiet = inputQuiet !== undefined && marker.inputCount > 0 && performance.now() - marker.lastInputAt >= inputQuiet;
      return domIsQuiet || inputIsQuiet;
    },
    { timeout, signal },
    token,
    domQuietMilliseconds,
    inputQuietMilliseconds,
  );
}

export async function isCaptchaPage(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(
    document.querySelector("#recaptcha,#captcha-form,form[action*='sorry'],iframe[src*='captcha'],[class*='captcha' i]") ||
    /unusual traffic|verify (?:that )?you are human|not a robot/i.test(document.body?.innerText ?? ""),
  ));
}
