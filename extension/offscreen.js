/**
 * TLDR Shield — Offscreen Document (PDF text extraction)
 *
 * Uses pdf.js (pdfjs-dist) to extract text from a PDF URL.
 * Runs in a chrome.offscreen document — avoids CSP restrictions in content scripts
 * and can use ES modules freely.
 *
 * Message protocol:
 *   IN:  { type: 'EXTRACT_PDF', url: string, tabId: number }
 *   OUT: { type: 'PDF_TEXT',    text: string, tabId: number, url: string }
 *       | { type: 'PDF_ERROR',  error: string, tabId: number }
 */

import * as pdfjsLib from './lib/pdf.min.mjs';

// Point the worker at the extension's local copy
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'EXTRACT_PDF') {
    extractPdfText(message.url, message.tabId);
  } else if (message.type === 'EXTRACT_HTML') {
    extractHtmlText(message.html, message.requestId);
  }
});

/**
 * EXTRACT_HTML handler — parse raw HTML with DOMParser + Readability.
 * Used by batch scan (background.js) to get the same extraction quality
 * as the content script's in-page Readability pass.
 *
 * Message protocol:
 *   IN:  { type: 'EXTRACT_HTML', html: string, requestId: string }
 *   OUT: { type: 'HTML_TEXT', text: string, requestId: string }
 *       | { type: 'HTML_ERROR', error: string, requestId: string }
 */
async function extractHtmlText(html, requestId) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove noise elements before Readability runs
    for (const sel of ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'iframe']) {
      doc.querySelectorAll(sel).forEach(el => el.remove());
    }

    let text = '';

    // Try Readability first (loaded via script tag in offscreen.html)
    if (typeof Readability !== 'undefined') {
      try {
        const reader = new Readability(doc.cloneNode(true));
        const article = reader.parse();
        if (article?.textContent && article.textContent.trim().length > 200) {
          text = article.textContent.trim();
        }
      } catch (_) {
        // Readability parse failed — fall through to textContent
      }
    }

    // Fallback: plain textContent (still better than regex in background.js
    // because DOMParser properly handles nested tags, entities, etc.)
    if (!text) {
      text = doc.body?.textContent?.trim() ?? '';
    }

    // Cap at 80k chars (same as content script)
    text = text.slice(0, 80000);

    chrome.runtime.sendMessage({ type: 'HTML_TEXT', text, requestId });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'HTML_ERROR',
      error: err?.message ?? String(err),
      requestId,
    });
  }
}

async function extractPdfText(url, tabId) {
  try {
    // Fetch the PDF bytes
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching PDF`);
    const arrayBuffer = await response.arrayBuffer();

    // Load with pdf.js
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    const pageTexts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (pageText) pageTexts.push(pageText);
    }

    const text = pageTexts.join('\n\n');
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

    // Detect scanned/image-only PDFs:
    // If the PDF has pages but almost no text (under 20 words for a multi-page doc),
    // it is likely a scanned image or requires OCR, which pdf.js text layer doesn't support.
    if (pdf.numPages > 0 && wordCount < 20) {
      throw new Error('This PDF appears to be a scanned image or is password-protected. TLDR Shield currently only supports text-based PDFs.');
    }

    chrome.runtime.sendMessage({ type: 'PDF_TEXT', text, tabId, url });
  } catch (err) {
    chrome.runtime.sendMessage({
      type:  'PDF_ERROR',
      error: err?.message ?? String(err),
      tabId,
    });
  }
}
