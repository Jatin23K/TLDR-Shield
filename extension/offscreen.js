/**
 * TLDR Shield — Offscreen Document (PDF text extraction)
 *
 * Uses pdf.js (pdfjs-dist) to extract text from a PDF URL.
 * Runs in a chrome.offscreen document — avoids CSP restrictions in content scripts
 * and can use ES modules freely.
 *
 * Message protocol:
 *   IN:  { type: 'EXTRACT_PDF', url: string, tabId: number }
 *   OUT: { type: 'PDF_TEXT',    text: string, tabId: number }
 *       | { type: 'PDF_ERROR',  error: string, tabId: number }
 */

import * as pdfjsLib from './lib/pdf.min.mjs';

// Point the worker at the extension's local copy
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'EXTRACT_PDF') return;
  extractPdfText(message.url, message.tabId);
});

async function extractPdfText(url, tabId) {
  try {
    // Fetch the PDF bytes
    const response = await fetch(url);
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
    chrome.runtime.sendMessage({ type: 'PDF_TEXT', text, tabId });
  } catch (err) {
    chrome.runtime.sendMessage({
      type:  'PDF_ERROR',
      error: err?.message ?? String(err),
      tabId,
    });
  }
}
