/* ===========================================================================
   BookStack Companion — frontend logic
   =========================================================================== */
'use strict';

// ---------- Element references ----------
const el = {
  connStatus: document.getElementById('connection-status'),
  bookSelect: document.getElementById('book-select'),
  chapterSelect: document.getElementById('chapter-select'),
  refreshBtn: document.getElementById('refresh-btn'),
  titleInput: document.getElementById('title-input'),
  templateSelect: document.getElementById('template-select'),
  templateDesc: document.getElementById('template-desc'),
  contentArea: document.getElementById('content-area'),
  applyTemplateBtn: document.getElementById('apply-template-btn'),
  publishBtn: document.getElementById('publish-btn'),
  publishLabel: null, // resolved in init (inside publishBtn)
  preview: document.getElementById('preview'),
  toastContainer: document.getElementById('toast-container'),
  pageSelect: document.getElementById('page-select'),
  editBadge: document.getElementById('edit-badge'),
  editorToolbar: document.getElementById('editor-toolbar'),
  editorStats: document.getElementById('editor-stats'),
  dirtyIndicator: document.getElementById('dirty-indicator'),
  fullscreenBtn: document.getElementById('fullscreen-btn'),
  newPageBtn: document.getElementById('new-page-btn'),
  publishView: document.getElementById('view-publish'),
  pageSearch: document.getElementById('page-search'),
  searchResults: document.getElementById('search-results'),
};

let templates = [];
let publishContents = null; // book contents cache for the publish tab
let editingPage = null; // { id, name, link } when editing an existing page
let editorDirty = false;

// ---------- Utilities ----------
function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- Markdown rendering ----------
marked.setOptions({
  breaks: false,
  gfm: true,
  highlight(code, lang) {
    if (window.hljs) {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch {
        /* fall through to plain */
      }
    }
    return code;
  },
});

function renderPreview() {
  const md = el.contentArea.value;
  if (!md.trim()) {
    el.preview.innerHTML =
      '<p class="preview-empty">Preview will appear here as you type.</p>';
    return;
  }
  el.preview.innerHTML = marked.parse(md);
  if (window.hljs) {
    el.preview.querySelectorAll('pre code').forEach((block) => {
      // marked already highlighted; ensure hljs class for theme styling.
      if (!block.classList.contains('hljs')) hljs.highlightElement(block);
    });
  }
}

// ---------- Connection status ----------
async function checkConnection() {
  setConnState('checking', 'Checking…');
  try {
    const data = await api('/api/bookstack/status');
    if (data.connected) setConnState('connected', 'Connected');
    else setConnState('unreachable', 'Unreachable');
  } catch {
    setConnState('unreachable', 'Unreachable');
  }
}

function setConnState(state, label) {
  el.connStatus.className = `conn-status conn-${state}`;
  el.connStatus.querySelector('.conn-label').textContent = label;
  el.connStatus.title =
    state === 'connected'
      ? 'Connected to BookStack'
      : state === 'unreachable'
      ? 'Cannot reach BookStack — check the connection settings (gear icon)'
      : 'Checking connection…';
}

// ---------- Books & chapters ----------
async function loadBooks() {
  el.bookSelect.innerHTML = '<option value="">Loading books…</option>';
  el.bookSelect.disabled = true;
  try {
    const data = await api('/api/bookstack/books');
    const books = (data.data || []).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    if (!books.length) {
      el.bookSelect.innerHTML = '<option value="">No books found</option>';
      return;
    }
    el.bookSelect.innerHTML =
      '<option value="">Select a book…</option>' +
      books
        .map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`)
        .join('');
    el.bookSelect.disabled = false;
  } catch (err) {
    el.bookSelect.innerHTML = '<option value="">Failed to load</option>';
    toast('error', `Could not load books: ${err.message}`);
  }
}

async function loadChapters(bookId) {
  el.chapterSelect.disabled = true;
  publishContents = null;
  if (!bookId) {
    el.chapterSelect.innerHTML = '<option value="">Select a book first</option>';
    resetPublishPages();
    updatePublishState();
    return;
  }
  el.chapterSelect.innerHTML = '<option value="">Loading chapters…</option>';
  try {
    const data = await api(`/api/bookstack/books/${bookId}/contents`);
    publishContents = data.contents || [];
    const chapters = publishContents
      .filter((item) => item.type === 'chapter')
      .sort((a, b) => a.name.localeCompare(b.name));

    el.chapterSelect.innerHTML = [
      '<option value="">— Book root (no chapter) —</option>',
      ...chapters.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`),
    ].join('');
    el.chapterSelect.disabled = false;
    populatePublishPages();
    el.pageSelect.disabled = false;
  } catch (err) {
    el.chapterSelect.innerHTML = '<option value="">Failed to load</option>';
    toast('error', `Could not load chapters: ${err.message}`);
  }
  updatePublishState();
}

function resetPublishPages() {
  el.pageSelect.innerHTML = '<option value="">✚ New page</option>';
  el.pageSelect.disabled = true;
}

// Fill the Page dropdown with the pages in the selected chapter (or whole book).
function populatePublishPages() {
  if (!publishContents) return resetPublishPages();
  const chapterId = el.chapterSelect.value;
  let pages;
  if (chapterId) {
    const ch = publishContents.find((i) => i.type === 'chapter' && String(i.id) === chapterId);
    pages = ch?.pages || [];
  } else {
    const top = publishContents.filter((i) => i.type === 'page');
    const inChapters = publishContents
      .filter((i) => i.type === 'chapter')
      .flatMap((c) => c.pages || []);
    pages = [...top, ...inChapters];
  }
  pages = [...pages].sort((a, b) => a.name.localeCompare(b.name));
  el.pageSelect.innerHTML = [
    '<option value="">✚ New page</option>',
    ...pages.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`),
  ].join('');
  if (editingPage) el.pageSelect.value = String(editingPage.id);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Templates ----------
async function loadTemplates() {
  try {
    templates = await api('/api/config/templates');
  } catch {
    templates = [];
  }
  el.templateSelect.innerHTML = templates
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
    .join('');
  updateTemplateDesc();
}

function updateTemplateDesc() {
  const t = templates.find((t) => t.id === el.templateSelect.value);
  el.templateDesc.textContent = t ? t.description : '';
}

// Detect whether content already looks template-wrapped.
function looksFormatted(content, templateId) {
  if (templateId === 'script') {
    return /^##\s+Summary/m.test(content) && /^##\s+Change Log/m.test(content);
  }
  if (templateId === 'kb') {
    return /^##\s+Overview/m.test(content) && /^##\s+Rollback/m.test(content);
  }
  return false;
}

// Pull fenced code blocks out of free-form input.
function extractCodeBlocks(content) {
  const fence = /```[\w-]*\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = fence.exec(content)) !== null) {
    blocks.push(match[1].replace(/\n$/, ''));
  }
  return blocks;
}

function applyScriptTemplate(content) {
  const trimmed = content.trim();
  const codeBlocks = extractCodeBlocks(trimmed);

  let scriptBody;
  let summary;
  if (codeBlocks.length) {
    scriptBody = codeBlocks.join('\n\n');
    // Use any prose before the first code fence as the summary.
    const prose = trimmed.split('```')[0].trim();
    summary = prose || '_Describe what this script does_';
  } else {
    scriptBody = trimmed || '# Paste your script here';
    summary = '_Describe what this script does_';
  }

  return `## Summary
${summary}

## Environment
_Fill in target environment_

## Parameters
_Document parameters here_

## Risk Notes
_Review and document any destructive operations_

## Script
\`\`\`powershell
${scriptBody}
\`\`\`

## Change Log
- ${todayISO()} — Initial creation
`;
}

function applyKbTemplate(content) {
  const overview = content.trim() || '_Summarise what this article covers_';
  return `## Overview
${overview}

## Prerequisites
- _List requirements, access needed, tools required_

## Steps
1. _Step one_

## Gotchas / Notes
_Common failure points and edge cases_

## Rollback / Undo
_How to reverse this process_

## Related Articles
_Add links to related BookStack pages_
`;
}

async function applyTemplate() {
  const templateId = el.templateSelect.value;
  if (templateId === 'raw') {
    toast('warn', 'Raw template applies no formatting — content unchanged.');
    return;
  }

  const content = el.contentArea.value;

  if (looksFormatted(content, templateId)) {
    const proceed = await confirmDialog({
      title: 'Re-apply template?',
      body:
        "This content looks like it's already formatted with a template. " +
        'Re-applying will wrap it again.',
      confirmText: 'Re-apply',
      cancelText: 'Cancel',
    });
    if (!proceed) return;
  }

  const wrapped =
    templateId === 'script'
      ? applyScriptTemplate(content)
      : templateId === 'kb'
      ? applyKbTemplate(content)
      : content;

  el.contentArea.value = wrapped;
  afterEdit();
  toast('success', 'Template applied.');
}

// ---------- Auto title detection ----------
function maybeAutoTitle() {
  if (el.titleInput.value.trim()) return;
  const match = el.contentArea.value.match(/^#\s+(.+?)\s*$/m);
  if (match) {
    el.titleInput.value = match[1].trim();
    updatePublishState();
  }
}

// ---------- Publish / Update ----------
function updatePublishState() {
  const hasCore = el.titleInput.value.trim() && el.contentArea.value.trim();
  // Editing needs only title + content; creating also needs a destination book.
  const ready = editingPage ? hasCore : hasCore && el.bookSelect.value;
  el.publishBtn.disabled = !ready;
}

async function publish() {
  if (el.publishBtn.disabled) return;

  const title = el.titleInput.value.trim();
  const markdown = el.contentArea.value;

  if (!title) return toast('error', 'A title is required.');
  if (!markdown.trim()) return toast('error', 'Content is empty.');
  if (!editingPage && !el.bookSelect.value) return toast('error', 'Select a destination book.');

  setBtnLoading(el.publishBtn, true);
  el.publishBtn.disabled = true;

  try {
    if (editingPage) {
      const data = await api(`/api/bookstack/pages/${editingPage.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: title, markdown }),
      });
      toast(
        'success',
        `Updated — <a href="${data.link}" target="_blank" rel="noopener">View Page →</a>`,
        true,
        8000
      );
      await finishSaveCleanup();
    } else {
      const payload = { name: title, markdown, book_id: Number(el.bookSelect.value) };
      if (el.chapterSelect.value) payload.chapter_id = Number(el.chapterSelect.value);
      const data = await api('/api/bookstack/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(
        'success',
        `Published — <a href="${data.link}" target="_blank" rel="noopener">View Page →</a>`,
        true,
        8000
      );
      await finishSaveCleanup();
    }
  } catch (err) {
    toast('error', `${editingPage ? 'Update' : 'Publish'} failed: ${err.message}`);
  } finally {
    setBtnLoading(el.publishBtn, false);
    updatePublishState();
  }
}

// Reset the editor to a clean slate after a successful create/update, and
// refresh the page list so the new or renamed page is reflected.
async function finishSaveCleanup() {
  exitEditMode(true); // clear title/content, leave edit mode, reset the Page dropdown
  await refreshPublishContents();
  el.contentArea.scrollTop = 0;
  el.preview.scrollTop = 0;
}

// Re-fetch the current book's contents (chapters + pages), preserving the
// selected chapter, so a freshly created/renamed page appears in the dropdown.
async function refreshPublishContents() {
  const bookId = el.bookSelect.value;
  if (!bookId) return;
  const chapterVal = el.chapterSelect.value;
  await loadChapters(bookId);
  if (chapterVal && [...el.chapterSelect.options].some((o) => o.value === chapterVal)) {
    el.chapterSelect.value = chapterVal;
    populatePublishPages();
  }
  updatePublishState();
}

// ===========================================================================
// Editor — edit existing pages
// ===========================================================================
async function onPageSelectChange() {
  const id = el.pageSelect.value;
  if (!id) {
    // "✚ New page"
    if (editingPage) {
      if (!(await confirmDiscardIfDirty())) {
        el.pageSelect.value = String(editingPage.id);
        return;
      }
      exitEditMode(true);
    }
    return;
  }
  if (editingPage && String(editingPage.id) === id) return;
  if (!(await confirmDiscardIfDirty())) {
    el.pageSelect.value = editingPage ? String(editingPage.id) : '';
    return;
  }
  await loadPageForEdit(id);
}

async function requestNewPage() {
  if (editingPage && !(await confirmDiscardIfDirty())) return;
  exitEditMode(true);
}

// Point the Book/Chapter dropdowns at a page's actual location (used when a
// page is opened from search, possibly in a different book than is selected).
async function syncDestinationToPage(bookId, chapterId) {
  if (bookId && el.bookSelect.value !== String(bookId)) {
    if ([...el.bookSelect.options].some((o) => o.value === String(bookId))) {
      el.bookSelect.value = String(bookId);
      await loadChapters(String(bookId));
    }
  }
  if (chapterId && [...el.chapterSelect.options].some((o) => o.value === String(chapterId))) {
    el.chapterSelect.value = String(chapterId);
    populatePublishPages();
  }
}

async function loadPageForEdit(pageId) {
  try {
    const data = await api(`/api/bookstack/pages/${pageId}`);
    await syncDestinationToPage(data.book_id, data.chapter_id);
    let md = data.markdown;
    let converted = false;
    if (!md && (data.raw_html || data.html)) {
      md = htmlToMarkdown(data.raw_html || data.html);
      converted = true;
    }
    el.titleInput.value = data.name;
    el.contentArea.value = md || '';
    editingPage = { id: data.id, name: data.name, link: data.link, editor: data.editor };
    el.pageSelect.value = String(data.id);
    markClean();
    onContentChanged();
    updateModeUI();
    if (converted) {
      toast(
        'warn',
        'This page was authored in the visual editor; it was converted to Markdown for editing. Saving will store it as Markdown.',
        false,
        9000
      );
    } else {
      toast('success', `Loaded "${data.name}" for editing.`, false, 2500);
    }
  } catch (err) {
    toast('error', `Could not load page: ${err.message}`);
    el.pageSelect.value = editingPage ? String(editingPage.id) : '';
  }
}

function exitEditMode(clear) {
  editingPage = null;
  if (clear) {
    el.titleInput.value = '';
    el.contentArea.value = '';
  }
  el.pageSelect.value = '';
  markClean();
  onContentChanged();
  updateModeUI();
}

function updateModeUI() {
  const editing = !!editingPage;
  if (el.publishLabel) el.publishLabel.textContent = editing ? 'Update page' : 'Publish →';
  el.newPageBtn.hidden = !editing;
  el.bookSelect.disabled = editing;
  el.chapterSelect.disabled = editing || !el.bookSelect.value;
  if (editing) {
    el.editBadge.hidden = false;
    el.editBadge.textContent = editingPage.name;
    el.editBadge.href = editingPage.link;
    el.editBadge.title = `Editing "${editingPage.name}" — open in BookStack`;
  } else {
    el.editBadge.hidden = true;
    el.editBadge.removeAttribute('href');
  }
  updatePublishState();
}

// ---------- Dirty / stats ----------
function updateEditorStats() {
  const text = el.contentArea.value;
  const words = (text.trim().match(/\S+/g) || []).length;
  const mins = Math.max(1, Math.round(words / 200));
  el.editorStats.textContent =
    `${words} word${words === 1 ? '' : 's'} · ${text.length} chars · ~${mins} min read`;
}

function markDirty() {
  if (editorDirty) return;
  editorDirty = true;
  el.dirtyIndicator.hidden = false;
}

function markClean() {
  editorDirty = false;
  if (el.dirtyIndicator) el.dirtyIndicator.hidden = true;
}

async function confirmDiscardIfDirty() {
  if (!editorDirty || !el.contentArea.value.trim()) return true;
  return confirmDialog({
    title: 'Discard changes?',
    body: 'You have unsaved changes. Discard them?',
    confirmText: 'Discard',
    cancelText: 'Keep editing',
  });
}

// ---------- HTML → Markdown (for WYSIWYG pages) ----------
let turndownSvc = null;
function htmlToMarkdown(html) {
  if (!window.TurndownService) return html;
  if (!turndownSvc) {
    turndownSvc = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
    });
    if (window.turndownPluginGfm) {
      try {
        turndownSvc.use(window.turndownPluginGfm.gfm);
      } catch {
        /* gfm plugin optional */
      }
    }
  }
  try {
    return turndownSvc.turndown(html).trim();
  } catch {
    return html;
  }
}

// ===========================================================================
// Editor — Markdown formatting toolbar
// ===========================================================================
const svgIcon = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICON = {
  link: svgIcon(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
  ),
  image: svgIcon(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'
  ),
  ul: svgIcon(
    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.6" cy="6" r="1.2"/><circle cx="3.6" cy="12" r="1.2"/><circle cx="3.6" cy="18" r="1.2"/>'
  ),
  ol: svgIcon(
    '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 4.5h1.2V10"/><path d="M3.4 17.1c0-1.3 2-1.4 2-.2 0 .9-1.9 1.2-1.9 2.5h2"/>'
  ),
  task: svgIcon(
    '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'
  ),
  quote: svgIcon('<path d="M7 17h3l2-4V7H6v6h2zm9 0h3l2-4V7h-6v6h2z"/>'),
  codeblock: svgIcon(
    '<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>'
  ),
  table: svgIcon(
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>'
  ),
  hr: svgIcon('<line x1="4" y1="12" x2="20" y2="12"/>'),
};

const TB_ITEMS = [
  { cmd: 'h1', label: 'H1', title: 'Heading 1' },
  { cmd: 'h2', label: 'H2', title: 'Heading 2' },
  { cmd: 'h3', label: 'H3', title: 'Heading 3' },
  'sep',
  { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)' },
  { cmd: 'italic', label: '<em>I</em>', title: 'Italic (Ctrl+I)' },
  { cmd: 'strike', label: '<s>S</s>', title: 'Strikethrough' },
  { cmd: 'code', label: '&lt;/&gt;', title: 'Inline code (Ctrl+E)' },
  'sep',
  { cmd: 'link', label: ICON.link, title: 'Link (Ctrl+K)' },
  { cmd: 'image', label: ICON.image, title: 'Image' },
  'sep',
  { cmd: 'ul', label: ICON.ul, title: 'Bulleted list' },
  { cmd: 'ol', label: ICON.ol, title: 'Numbered list' },
  { cmd: 'task', label: ICON.task, title: 'Task list' },
  { cmd: 'quote', label: ICON.quote, title: 'Blockquote' },
  'sep',
  { cmd: 'codeblock', label: ICON.codeblock, title: 'Code block' },
  { cmd: 'table', label: ICON.table, title: 'Table' },
  { cmd: 'hr', label: ICON.hr, title: 'Horizontal rule' },
];

function buildEditorToolbar() {
  el.editorToolbar.innerHTML = TB_ITEMS.map((it) =>
    it === 'sep'
      ? '<span class="tb-sep"></span>'
      : `<button class="tb-btn" type="button" data-cmd="${it.cmd}" title="${it.title}" aria-label="${it.title}">${it.label}</button>`
  ).join('');
  // Don't steal focus/selection from the textarea on click.
  el.editorToolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tb-btn')) e.preventDefault();
  });
  el.editorToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-btn[data-cmd]');
    if (btn) mdAction(btn.dataset.cmd);
  });
}

function afterEdit() {
  markDirty();
  onContentChanged();
}

// Insert text at the caret using execCommand so native undo (Ctrl+Z) keeps working.
function insertAtSelection(text) {
  const ta = el.contentArea;
  ta.focus();
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    ta.value = value.slice(0, s) + text + value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
  }
}

function selInfo() {
  const ta = el.contentArea;
  return {
    s: ta.selectionStart,
    e: ta.selectionEnd,
    value: ta.value,
    text: ta.value.slice(ta.selectionStart, ta.selectionEnd),
  };
}

function wrapInline(before, after, placeholder) {
  const ta = el.contentArea;
  const { s, text } = selInfo();
  const inner = text || placeholder;
  insertAtSelection(before + inner + after);
  ta.selectionStart = s + before.length;
  ta.selectionEnd = s + before.length + inner.length;
  afterEdit();
}

// Transform whole lines touched by the selection (headings, lists, quotes).
function transformLines(fn) {
  const ta = el.contentArea;
  const { s, e, value } = selInfo();
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = value.indexOf('\n', e);
  if (lineEnd === -1) lineEnd = value.length;
  const newBlock = fn(value.slice(lineStart, lineEnd).split('\n'));
  ta.selectionStart = lineStart;
  ta.selectionEnd = lineEnd;
  insertAtSelection(newBlock);
  ta.selectionStart = lineStart;
  ta.selectionEnd = lineStart + newBlock.length;
  afterEdit();
}

function headingFn(n) {
  const marker = '#'.repeat(n) + ' ';
  return (lines) =>
    lines
      .map((l) => {
        const stripped = l.replace(/^#{1,6}\s+/, '');
        return l.startsWith(marker) ? stripped : marker + stripped;
      })
      .join('\n');
}

function toggleFn(re, prefix) {
  return (lines) => {
    const has = lines.every((l) => re.test(l));
    return lines.map((l) => (has ? l.replace(re, '') : prefix + l)).join('\n');
  };
}

function orderedFn(lines) {
  const has = lines.every((l) => /^\d+\.\s/.test(l));
  return lines.map((l, i) => (has ? l.replace(/^\d+\.\s/, '') : `${i + 1}. ${l}`)).join('\n');
}

function insertLink() {
  const ta = el.contentArea;
  const { s, text } = selInfo();
  if (text) {
    insertAtSelection(`[${text}](url)`);
    const p = s + 1 + text.length + 2;
    ta.selectionStart = p;
    ta.selectionEnd = p + 3;
  } else {
    insertAtSelection('[text](url)');
    ta.selectionStart = s + 1;
    ta.selectionEnd = s + 5;
  }
  afterEdit();
}

function insertImage() {
  const ta = el.contentArea;
  const { s, text } = selInfo();
  const alt = text || 'alt';
  insertAtSelection(`![${alt}](url)`);
  const p = s + 2 + alt.length + 2;
  ta.selectionStart = p;
  ta.selectionEnd = p + 3;
  afterEdit();
}

function insertCodeBlock() {
  const ta = el.contentArea;
  const { s, text } = selInfo();
  insertAtSelection('```\n' + (text || 'code') + '\n```');
  ta.selectionStart = ta.selectionEnd = s + 3; // after opening fence, to type a language
  afterEdit();
}

function insertBlock(tpl) {
  const { s, value } = selInfo();
  const pre = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
  const post = value[s] && value[s] !== '\n' ? '\n' : '';
  insertAtSelection(pre + tpl + post);
  afterEdit();
}

const TABLE_TPL = '| Column A | Column B |\n| --- | --- |\n| Cell | Cell |\n| Cell | Cell |\n';

function mdAction(cmd) {
  switch (cmd) {
    case 'bold': return wrapInline('**', '**', 'bold text');
    case 'italic': return wrapInline('*', '*', 'italic');
    case 'strike': return wrapInline('~~', '~~', 'strikethrough');
    case 'code': return wrapInline('`', '`', 'code');
    case 'h1': return transformLines(headingFn(1));
    case 'h2': return transformLines(headingFn(2));
    case 'h3': return transformLines(headingFn(3));
    case 'ul': return transformLines(toggleFn(/^- /, '- '));
    case 'ol': return transformLines(orderedFn);
    case 'task': return transformLines(toggleFn(/^- \[[ xX]\] /, '- [ ] '));
    case 'quote': return transformLines(toggleFn(/^> /, '> '));
    case 'link': return insertLink();
    case 'image': return insertImage();
    case 'codeblock': return insertCodeBlock();
    case 'table': return insertBlock(TABLE_TPL);
    case 'hr': return insertBlock('---\n');
    default: return undefined;
  }
}

// ---------- Loading state on buttons ----------
function setBtnLoading(btn, loading) {
  const spinner = btn.querySelector('.btn-spinner');
  if (spinner) spinner.hidden = !loading;
}

// ---------- Toasts ----------
function toast(type, message, isHtml = false, duration = 5000) {
  const icons = { success: '✓', error: '✕', warn: '⚠' };
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ'}</span>
    <div class="toast-body"></div>
    <button class="toast-close" aria-label="Dismiss">×</button>
  `;
  const body = node.querySelector('.toast-body');
  if (isHtml) body.innerHTML = message;
  else body.textContent = message;

  const remove = () => {
    node.classList.add('toast-out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };
  node.querySelector('.toast-close').addEventListener('click', remove);
  el.toastContainer.appendChild(node);

  if (duration) setTimeout(remove, duration);
}

// ---------- Styled confirm modal (replaces window.confirm) ----------
// `body` may contain trusted HTML built by the caller. Returns Promise<boolean>.
function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <h3 class="modal-title">${escapeHtml(title)}</h3>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn btn-secondary modal-cancel" type="button">${escapeHtml(cancelText)}</button>
          <button class="btn btn-primary modal-confirm" type="button">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;

    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.classList.add('modal-out');
      overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    };

    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-confirm').addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(false); // click backdrop to cancel
    });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    overlay.querySelector('.modal-confirm').focus();
  });
}

// ===========================================================================
// Browser bridge (companion extension)
// ===========================================================================
// The extension fetches Cloudflare/hotlink-protected images through the live
// browser session and reads clearance cookies — things the server cannot do.
const ext = { available: false };
const extPending = new Map();
let extReqId = 0;

function initExtensionBridge() {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || !m.__bsc) return;
    if (m.announce && m.payload?.ready) {
      ext.available = true;
      updateExtStatus();
      return;
    }
    if (m.id != null && extPending.has(m.id)) {
      const resolve = extPending.get(m.id);
      extPending.delete(m.id);
      resolve(m.payload || {});
    }
  });
  probeExtension(); // retried ping handshake; paints status once it resolves
}

// Ping the content script a few times — covers the race where the page's
// listener isn't ready when the extension first announces.
function probeExtension(attempts = 6) {
  if (ext.available) return;
  extRequest('ping', {}, 700).then((p) => {
    if (p?.ready) {
      ext.available = true;
      updateExtStatus();
    } else if (attempts > 1) {
      setTimeout(() => probeExtension(attempts - 1), 800);
    } else {
      updateExtStatus();
    }
  });
}

function extRequest(action, data, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const id = ++extReqId;
    let settled = false;
    extPending.set(id, (payload) => {
      settled = true;
      resolve(payload);
    });
    window.postMessage({ __bscPage: true, id, action, ...data }, '*');
    setTimeout(() => {
      if (!settled && extPending.has(id)) {
        extPending.delete(id);
        resolve(null);
      }
    }, timeoutMs);
  });
}

const extFetch = (urls) =>
  ext.available && urls.length
    ? extRequest('fetch', { urls }).then((p) => p?.results || [])
    : Promise.resolve([]);

const extGetClearance = (domains) =>
  ext.available && domains.length
    ? extRequest('getClearance', { domains }, 5000).then((p) => p?.cookies || [])
    : Promise.resolve([]);

const extProbe = (urls) =>
  ext.available && urls.length
    ? extRequest('probe', { urls }, 30000).then((p) => p?.results || [])
    : Promise.resolve([]);

function updateExtStatus() {
  const elStatus = document.getElementById('loc-ext-status');
  if (!elStatus) return;
  // Cookie fallback is redundant once the bridge is active — hide it to declutter.
  if (loc.advanced) loc.advanced.style.display = ext.available ? 'none' : '';
  if (ext.available) {
    elStatus.className = 'loc-ext-status ext-on';
    elStatus.innerHTML =
      '<span class="ext-dot"></span> Browser bridge active — blocked images fetched through your browser.';
  } else {
    elStatus.className = 'loc-ext-status ext-off';
    elStatus.innerHTML =
      '<span class="ext-dot"></span><span>Browser bridge not detected. If you just installed it, ' +
      '<strong>reload this page</strong> (Ctrl+Shift+R) — the extension only attaches on a fresh load.</span>' +
      '<button id="loc-recheck-btn" class="btn btn-secondary" type="button">Re-check</button>' +
      '<button id="loc-install-btn" class="btn btn-secondary" type="button">Install bridge</button>';
    const installBtn = document.getElementById('loc-install-btn');
    if (installBtn) installBtn.addEventListener('click', showInstallModal);
    const recheckBtn = document.getElementById('loc-recheck-btn');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', () => {
        ext.available = false;
        probeExtension(4);
        toast('warn', 'Re-checking for the browser bridge…', false, 2500);
      });
    }
  }
  // Reflect the new bridge state on any already-rendered scan results.
  refreshBridgeBadges();
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/firefox/i.test(ua)) return 'firefox';
  if (/edg\//i.test(ua)) return 'edge';
  return 'chrome';
}

// Open a generic styled modal with arbitrary HTML body. Returns the overlay.
function openModal(title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <h3 class="modal-title">${escapeHtml(title)}</h3>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.classList.add('modal-out');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  // Copy-to-clipboard for any [data-copy] element.
  overlay.querySelectorAll('[data-copy]').forEach((elc) => {
    elc.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(elc.dataset.copy);
        toast('success', 'Copied to clipboard.', false, 2500);
      } catch {
        toast('error', 'Copy failed — select and copy manually.');
      }
    });
  });
  overlay.querySelectorAll('.modal-close-btn').forEach((b) => b.addEventListener('click', close));
  document.body.appendChild(overlay);
  return overlay;
}

async function showInstallModal() {
  let info = {};
  try {
    info = await api('/api/extension/info');
  } catch {
    /* paths just won't show */
  }
  const b = detectBrowser();
  const path = b === 'firefox' ? info.firefoxPath : info.chromePath;
  const extUrl =
    b === 'firefox'
      ? 'about:debugging#/runtime/this-firefox'
      : b === 'edge'
      ? 'edge://extensions'
      : 'chrome://extensions';
  const dlBrowser = b === 'firefox' ? 'firefox' : 'chrome';
  const dlFile = b === 'firefox' ? 'bookstack-bridge.xpi' : 'bookstack-bridge.zip';
  const dlBtn = `<a class="btn btn-primary" href="/api/extension/download?browser=${dlBrowser}" download>Download ${dlFile}</a>`;

  const steps =
    b === 'firefox'
      ? `<li>${dlBtn}</li>
         <li>Open <code>${extUrl}</code> <button class="link-copy" data-copy="${extUrl}" type="button">copy</button></li>
         <li>Click <strong>Load Temporary Add-on…</strong> and choose the downloaded <code>.xpi</code>.</li>
         <li>Open <code>about:addons</code> → this extension → <strong>Permissions</strong> → turn on
             <strong>“Access your data for all websites”</strong> (needed so it can fetch images).</li>
         <li>Reload this page.</li>`
      : `<li>${dlBtn}</li>
         <li><strong>Unzip</strong> it to a folder you'll keep (the browser loads from that folder).</li>
         <li>Open <code>${extUrl}</code> <button class="link-copy" data-copy="${extUrl}" type="button">copy</button></li>
         <li>Turn on <strong>Developer mode</strong> (top-right).</li>
         <li>Click <strong>Load unpacked</strong> and select the unzipped folder, then reload this page.</li>`;

  const caveat =
    b === 'firefox'
      ? `<p class="modal-note">Firefox removes temporary add-ons when it restarts — repeat steps 1–3 next
         session. A permanent install requires signing through Mozilla.</p>`
      : '';

  const devNote = path
    ? `<details class="install-dev">
         <summary>Running this from the project source?</summary>
         <p class="modal-note">Skip the download and load this folder directly
           (${b === 'firefox' ? 'select its <code>manifest.json</code>' : 'Load unpacked'}):</p>
         <div class="path-row">
           <code class="path-box">${escapeHtml(path)}</code>
           <button class="btn btn-secondary" data-copy="${escapeHtml(path)}" type="button">Copy</button>
         </div>
       </details>`
    : '';

  const body = `
    <p>Browsers don't allow a web page to install an extension automatically, so set it up once for
    <strong>${escapeHtml(b)}</strong>:</p>
    <ol class="install-steps">${steps}</ol>
    ${caveat}
    ${devNote}
    <div class="modal-actions">
      <button class="btn btn-primary modal-close-btn" type="button">Done</button>
    </div>`;

  openModal('Install the browser bridge', body);
}

// ---------- Content change handler ----------
function onContentChanged() {
  renderPreview();
  maybeAutoTitle();
  updatePublishState();
  updateEditorStats();
}

// ---------- Wire up events ----------
async function init() {
  initTabs();
  initLocalize();
  initExtensionBridge();
  initSearch();
  initSetup();

  el.publishLabel = el.publishBtn.querySelector('.publish-label');
  buildEditorToolbar();

  el.contentArea.addEventListener('input', () => {
    markDirty();
    onContentChanged();
  });
  el.titleInput.addEventListener('input', () => {
    markDirty();
    updatePublishState();
  });

  el.bookSelect.addEventListener('change', () => {
    loadChapters(el.bookSelect.value);
    updatePublishState();
  });
  el.chapterSelect.addEventListener('change', () => {
    populatePublishPages();
    updatePublishState();
  });
  el.pageSelect.addEventListener('change', onPageSelectChange);
  el.newPageBtn.addEventListener('click', requestNewPage);
  el.fullscreenBtn.addEventListener('click', () =>
    el.publishView.classList.toggle('editor-focus')
  );

  el.templateSelect.addEventListener('change', updateTemplateDesc);
  el.applyTemplateBtn.addEventListener('click', applyTemplate);
  el.publishBtn.addEventListener('click', publish);

  el.refreshBtn.addEventListener('click', async () => {
    setBtnLoading(el.refreshBtn, true);
    el.refreshBtn.disabled = true;
    const currentBook = el.bookSelect.value;
    await Promise.all([loadBooks(), checkConnection()]);
    // Restore prior book selection if it still exists.
    if (currentBook && [...el.bookSelect.options].some((o) => o.value === currentBook)) {
      el.bookSelect.value = currentBook;
      await loadChapters(currentBook);
    }
    setBtnLoading(el.refreshBtn, false);
    el.refreshBtn.disabled = false;
    updatePublishState();
  });

  // Ctrl+Enter to publish.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      publish();
    }
  });

  // Editor key handling: Tab to indent, plus Markdown formatting shortcuts.
  el.contentArea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.contentArea.selectionStart;
      const end = el.contentArea.selectionEnd;
      const v = el.contentArea.value;
      el.contentArea.value = v.slice(0, start) + '  ' + v.slice(end);
      el.contentArea.selectionStart = el.contentArea.selectionEnd = start + 2;
      afterEdit();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const map = { b: 'bold', i: 'italic', k: 'link', e: 'code' };
      if (map[k]) {
        e.preventDefault();
        mdAction(map[k]);
      }
    }
  });

  renderPreview();
  updateEditorStats();

  // Config gate: until a BookStack connection is saved, show the setup screen
  // instead of firing doomed API calls.
  try {
    appConfig = await api('/api/config');
  } catch {
    appConfig = null;
  }
  applyEdition(appConfig?.edition);
  if (appConfig?.configured) bootData();
  else showSetup({ firstRun: true });
}

// The shared/packaged app ships as the localizer-only edition: no Publish tab,
// the Localize view is the whole app.
let appEdition = 'full';

function applyEdition(edition) {
  appEdition = edition || 'full';
  if (appEdition !== 'localizer') return;
  document.body.classList.add('edition-localizer');
  document.title = 'BookStack Image Localizer';
  const brand = document.querySelector('.brand-title');
  if (brand) brand.innerHTML = 'BookStack <em>Image Localizer</em>';
  const setupBrand = document.querySelector('.setup-brand');
  if (setupBrand) setupBrand.innerHTML = 'BookStack <em>Image Localizer</em>';
  const sub = document.querySelector('.setup-sub');
  if (sub) {
    sub.textContent =
      'Find externally-hosted images across your wiki and re-host them inside ' +
      'BookStack, so they survive link rot. Runs entirely on this machine — ' +
      'your API token never leaves it.';
  }
  switchView('localize');
}

// Data loads that only make sense once a connection is configured.
function bootData() {
  checkConnection();
  if (appEdition === 'localizer') {
    locBooksLoaded = false;
    ensureLocBooks();
  } else {
    loadTemplates();
    loadBooks();
  }
}

// ===========================================================================
// Setup & settings — first-run connection wizard, reopenable from the header
// ===========================================================================
let appConfig = null; // sanitized /api/config payload (never contains the secret)
const setup = {};
let setupTested = false; // saving is gated behind a passing connection test

function initSetup() {
  setup.screen = document.getElementById('setup-screen');
  setup.form = document.getElementById('setup-form');
  setup.title = document.getElementById('setup-title');
  setup.url = document.getElementById('setup-url');
  setup.tokenId = document.getElementById('setup-token-id');
  setup.tokenSecret = document.getElementById('setup-token-secret');
  setup.result = document.getElementById('setup-result');
  setup.testBtn = document.getElementById('setup-test-btn');
  setup.saveBtn = document.getElementById('setup-save-btn');
  setup.saveHint = document.getElementById('setup-save-hint');
  setup.cancelBtn = document.getElementById('setup-cancel-btn');

  document.getElementById('settings-btn').addEventListener('click', () =>
    showSetup({ firstRun: false })
  );
  setup.testBtn.addEventListener('click', runSetupTest);
  setup.form.addEventListener('submit', saveSetup);
  setup.cancelBtn.addEventListener('click', hideSetup);

  // Any edit invalidates the previous test — what you save is what you tested.
  [setup.url, setup.tokenId, setup.tokenSecret].forEach((input) =>
    input.addEventListener('input', invalidateSetupTest)
  );
  // Enter in a field runs the test first when saving isn't unlocked yet.
  setup.form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !setupTested) {
      e.preventDefault();
      runSetupTest();
    }
  });
}

function showSetup({ firstRun }) {
  setup.firstRun = firstRun;
  setup.title.textContent = firstRun ? 'Connect your BookStack' : 'Connection settings';
  setup.url.value = appConfig?.url || '';
  setup.tokenId.value = '';
  setup.tokenSecret.value = '';
  if (appConfig?.configured) {
    setup.tokenId.placeholder = `${appConfig.tokenIdHint} (saved — leave blank to keep)`;
    setup.tokenSecret.placeholder = 'saved — leave blank to keep';
  } else {
    setup.tokenId.placeholder = '';
    setup.tokenSecret.placeholder = '';
  }
  setup.cancelBtn.hidden = firstRun;
  invalidateSetupTest();
  setup.screen.hidden = false;
  document.body.classList.add('setup-open');
  (setup.url.value ? setup.tokenId : setup.url).focus();
}

function hideSetup() {
  setup.screen.hidden = true;
  document.body.classList.remove('setup-open');
}

function invalidateSetupTest() {
  setupTested = false;
  setup.saveBtn.disabled = true;
  setup.saveHint.hidden = false;
  setup.result.innerHTML = '';
}

function setupPayload() {
  return {
    url: setup.url.value.trim(),
    token_id: setup.tokenId.value.trim(),
    token_secret: setup.tokenSecret.value,
  };
}

function setupStamp(ok, label, note) {
  setup.result.innerHTML =
    `<span class="stamp ${ok ? 'stamp-ok' : 'stamp-fail'}">${escapeHtml(label)}</span>` +
    (note ? `<p class="setup-result-note">${escapeHtml(note)}</p>` : '');
}

async function runSetupTest() {
  const p = setupPayload();
  if (!p.url) {
    setupStamp(false, 'No address', 'Enter your BookStack address first.');
    setup.url.focus();
    return;
  }
  setBtnLoading(setup.testBtn, true);
  setup.testBtn.disabled = true;
  setup.result.innerHTML = '<p class="setup-checking">Reaching your BookStack…</p>';
  try {
    const r = await api('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    if (r.ok) {
      setupTested = true;
      setup.saveBtn.disabled = false;
      setup.saveHint.hidden = true;
      setupStamp(true, 'Connected', `Found ${r.books} book${r.books === 1 ? '' : 's'} in this wiki.`);
    } else {
      setupStamp(false, 'No connection', r.reason || 'Unknown error.');
    }
  } catch (err) {
    setupStamp(false, 'No connection', err.message);
  } finally {
    setBtnLoading(setup.testBtn, false);
    setup.testBtn.disabled = false;
  }
}

async function saveSetup(e) {
  e.preventDefault();
  if (!setupTested) return;
  setup.saveBtn.disabled = true;
  try {
    await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(setupPayload()),
    });
    appConfig = await api('/api/config');
    hideSetup();
    toast('success', 'Connected. Settings are saved on this machine.');
    // Reload everything against the (possibly different) instance.
    locBooksLoaded = false;
    resetSelect(loc.book, 'All books');
    bootData();
  } catch (err) {
    setup.saveBtn.disabled = false;
    toast('error', `Could not save settings: ${err.message}`);
  }
}

// ===========================================================================
// Quick search — find any page across the wiki and open it for editing
// ===========================================================================
let searchResultsData = [];
let searchActiveIndex = -1;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function initSearch() {
  el.pageSearch.addEventListener('input', debounce(runSearch, 250));
  el.pageSearch.addEventListener('keydown', onSearchKey);
  el.pageSearch.addEventListener('focus', () => {
    if (searchResultsData.length) el.searchResults.hidden = false;
  });
  // Close the dropdown when clicking outside the search box.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) el.searchResults.hidden = true;
  });
}

function bookNameById(id) {
  if (!id) return '';
  const opt = [...el.bookSelect.options].find((o) => o.value === String(id));
  return opt ? opt.textContent : '';
}

async function runSearch() {
  const q = el.pageSearch.value.trim();
  if (q.length < 2) {
    searchResultsData = [];
    el.searchResults.hidden = true;
    return;
  }
  try {
    const data = await api(`/api/bookstack/search?q=${encodeURIComponent(q)}`);
    searchResultsData = data.data || [];
    renderSearchResults();
  } catch (err) {
    el.searchResults.innerHTML = `<div class="search-empty">Search failed: ${escapeHtml(err.message)}</div>`;
    el.searchResults.hidden = false;
  }
}

function renderSearchResults() {
  searchActiveIndex = -1;
  if (!searchResultsData.length) {
    el.searchResults.innerHTML = '<div class="search-empty">No matches.</div>';
    el.searchResults.hidden = false;
    return;
  }
  el.searchResults.innerHTML = searchResultsData
    .map((r, i) => {
      // preview_html is BookStack-generated and contains <strong> highlights.
      const title = r.preview_html?.name || escapeHtml(r.name);
      const snippet = r.preview_html?.content || '';
      const crumb = r.type !== 'book' ? bookNameById(r.book_id) : '';
      return `<div class="search-item" data-i="${i}" role="option">
        <span class="search-type type-${r.type}">${r.type}</span>
        <div class="search-item-main">
          <div class="search-item-title">${title}</div>
          ${crumb ? `<div class="search-item-meta">${escapeHtml(crumb)}</div>` : ''}
          ${snippet ? `<div class="search-item-snippet">${snippet}</div>` : ''}
        </div>
      </div>`;
    })
    .join('');
  el.searchResults.querySelectorAll('.search-item').forEach((node) => {
    // mousedown (not click) so it fires before the input's blur hides the list.
    node.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openSearchResult(Number(node.dataset.i));
    });
  });
  el.searchResults.hidden = false;
}

function onSearchKey(e) {
  if (e.key === 'Escape') {
    el.searchResults.hidden = true;
    return;
  }
  if (el.searchResults.hidden || !searchResultsData.length) {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSearchActive(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSearchActive(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openSearchResult(searchActiveIndex >= 0 ? searchActiveIndex : 0);
  }
}

function moveSearchActive(delta) {
  const items = el.searchResults.querySelectorAll('.search-item');
  if (!items.length) return;
  searchActiveIndex = (searchActiveIndex + delta + items.length) % items.length;
  items.forEach((n, i) => n.classList.toggle('active', i === searchActiveIndex));
  items[searchActiveIndex].scrollIntoView({ block: 'nearest' });
}

async function openSearchResult(i) {
  const r = searchResultsData[i];
  if (!r) return;
  el.searchResults.hidden = true;

  if (r.type === 'page') {
    if (!(await confirmDiscardIfDirty())) return;
    el.pageSearch.value = '';
    searchResultsData = [];
    await loadPageForEdit(r.id); // syncs Book/Chapter + enters edit mode
    return;
  }

  // Book / chapter → browse there (set the destination for a new page).
  const bookId = r.type === 'book' ? r.id : r.book_id;
  if (!bookId || ![...el.bookSelect.options].some((o) => o.value === String(bookId))) return;
  if (editingPage && !(await confirmDiscardIfDirty())) return;
  if (editingPage) exitEditMode(true);
  el.bookSelect.value = String(bookId);
  await loadChapters(String(bookId));
  if (r.type === 'chapter' && [...el.chapterSelect.options].some((o) => o.value === String(r.id))) {
    el.chapterSelect.value = String(r.id);
    populatePublishPages();
  }
  el.pageSearch.value = '';
  updatePublishState();
}

// ===========================================================================
// Tabs
// ===========================================================================
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
}

function switchView(view) {
  document
    .querySelectorAll('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('view-publish').classList.toggle('view-active', view === 'publish');
  document.getElementById('view-localize').classList.toggle('view-active', view === 'localize');
  if (view === 'localize') ensureLocBooks();
}

// ===========================================================================
// Image Localizer
// ===========================================================================
const loc = {
  book: null,
  chapter: null,
  page: null,
  scanBtn: null,
  summary: null,
  results: null,
  selectAll: null,
  selCount: null,
  applyBtn: null,
};

let locBooksLoaded = false;
let locContents = null; // contents of the currently selected book
let scanData = null; // last scan result
let blockedUrlSet = new Set(); // URLs the server probe couldn't reach (need the browser bridge)
let bridgeMetaDone = false; // whether bridge has already filled size/type for blocked images

function initLocalize() {
  loc.book = document.getElementById('loc-book');
  loc.chapter = document.getElementById('loc-chapter');
  loc.page = document.getElementById('loc-page');
  loc.scanBtn = document.getElementById('loc-scan-btn');
  loc.summary = document.getElementById('loc-summary');
  loc.results = document.getElementById('loc-results');
  loc.selectAll = document.getElementById('loc-select-all');
  loc.selCount = document.getElementById('loc-selcount');
  loc.applyBtn = document.getElementById('loc-apply-btn');
  loc.ua = document.getElementById('loc-ua');
  loc.cookieRows = document.getElementById('loc-cookie-rows');
  loc.addCookieBtn = document.getElementById('loc-add-cookie');
  loc.advanced = document.querySelector('.loc-advanced');

  loc.book.addEventListener('change', onLocBookChange);
  loc.chapter.addEventListener('change', populateLocPages);
  loc.scanBtn.addEventListener('click', runScan);
  loc.applyBtn.addEventListener('click', runApply);
  loc.selectAll.addEventListener('change', onSelectAll);
  loc.addCookieBtn.addEventListener('click', () => {
    addCookieRow();
    saveAuth();
  });

  loadAuth(); // restore saved UA + cookies (UA defaults to this browser's own)
  if (!loc.cookieRows.children.length) addCookieRow();
  loc.ua.addEventListener('input', saveAuth);
  loc.cookieRows.addEventListener('input', saveAuth);
}

const AUTH_STORE_KEY = 'bsc.localizer.auth';

// Restore the saved User-Agent + cookies. The UA auto-fills from this very
// browser (navigator.userAgent) so it always matches the cookie's origin —
// you never have to copy it by hand.
function loadAuth() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(AUTH_STORE_KEY) || 'null');
  } catch {
    /* ignore corrupt store */
  }
  loc.ua.value = saved?.userAgent || navigator.userAgent;
  (saved?.cookies || []).forEach((c) => addCookieRow(c.domain, c.cookie));
}

function saveAuth() {
  try {
    const cookies = [...loc.cookieRows.querySelectorAll('.loc-cookie-row')]
      .map((r) => ({
        domain: r.querySelector('.loc-ck-domain').value.trim(),
        cookie: r.querySelector('.loc-ck-cookie').value.trim(),
      }))
      .filter((c) => c.domain || c.cookie);
    localStorage.setItem(
      AUTH_STORE_KEY,
      JSON.stringify({ userAgent: loc.ua.value.trim(), cookies })
    );
  } catch {
    /* storage unavailable — non-fatal */
  }
}

// Ensure a cookie row exists for a domain (reusing an empty row if present).
// Returns true if the domain row's cookie value is still empty (needs pasting).
function ensureCookieRowForDomain(domain) {
  const rows = [...loc.cookieRows.querySelectorAll('.loc-cookie-row')];
  let row = rows.find(
    (r) => r.querySelector('.loc-ck-domain').value.trim().toLowerCase() === domain.toLowerCase()
  );
  if (!row) {
    const empty = rows.find(
      (r) =>
        !r.querySelector('.loc-ck-domain').value.trim() &&
        !r.querySelector('.loc-ck-cookie').value.trim()
    );
    if (empty) {
      empty.querySelector('.loc-ck-domain').value = domain;
      row = empty;
    } else {
      addCookieRow(domain, '');
      row = loc.cookieRows.lastElementChild;
    }
  }
  return !row.querySelector('.loc-ck-cookie').value.trim();
}

// Build the optional auth payload (browser User-Agent + per-domain cookies) used
// to borrow the user's Cloudflare clearance for protected hosts.
function buildAuth() {
  const userAgent = loc.ua.value.trim();
  const cookies = [...loc.cookieRows.querySelectorAll('.loc-cookie-row')]
    .map((r) => ({
      domain: r.querySelector('.loc-ck-domain').value.trim(),
      cookie: r.querySelector('.loc-ck-cookie').value.trim(),
    }))
    .filter((c) => c.domain && c.cookie);
  if (!userAgent && !cookies.length) return undefined;
  return { userAgent: userAgent || undefined, cookies };
}

function addCookieRow(domain = '', cookie = '') {
  const row = document.createElement('div');
  row.className = 'loc-cookie-row';
  row.innerHTML = `
    <input class="text-input loc-ck-domain" placeholder="domain (e.g. starwindsoftware.com)" value="${escapeHtml(domain)}" autocomplete="off" />
    <input class="text-input loc-ck-cookie" placeholder="cookie (e.g. cf_clearance=…)" value="${escapeHtml(cookie)}" autocomplete="off" />
    <button class="btn btn-secondary loc-ck-remove" type="button" title="Remove">✕</button>`;
  row.querySelector('.loc-ck-remove').addEventListener('click', () => {
    row.remove();
    saveAuth();
  });
  loc.cookieRows.appendChild(row);
}

// After a scan, surface which external hosts blocked the probe so the user can
// paste a cookie for exactly those domains (pre-filled) and re-scan.
async function handleBlockedHosts(data) {
  const blocked = new Map(); // bare domain -> count
  data.pages.forEach((p) =>
    p.images.forEach((i) => {
      if (i.ok) return;
      try {
        const host = new URL(i.url).host.replace(/^www\./, '');
        blocked.set(host, (blocked.get(host) || 0) + 1);
      } catch {
        /* skip unparseable */
      }
    })
  );
  if (!blocked.size) return;

  const domains = [...blocked.keys()];
  const total = [...blocked.values()].reduce((a, b) => a + b, 0);

  // With the bridge installed, nothing manual is needed — the images get fetched
  // through the browser on Localize. Also auto-pull the clearance cookie so the
  // Advanced fields reflect what's being used.
  if (ext.available) {
    const pulled = await extGetClearance(domains);
    pulled.forEach((c) => {
      ensureCookieRowForDomain(c.domain);
      const row = [...loc.cookieRows.querySelectorAll('.loc-cookie-row')].find(
        (r) => r.querySelector('.loc-ck-domain').value.trim().toLowerCase() === c.domain.toLowerCase()
      );
      if (row) row.querySelector('.loc-ck-cookie').value = c.cookie;
    });
    saveAuth();
    populateBridgeMeta(); // fill in size · type for the blocked rows via the bridge
    toast(
      'success',
      `${total} blocked image${total === 1 ? '' : 's'} will be fetched automatically through your ` +
        `browser on Localize${pulled.length ? ' (clearance cookie auto-pulled)' : ''}.`,
      true,
      8000
    );
    return;
  }

  // No bridge: fall back to the streamlined manual paste.
  let needsCookie = false;
  blocked.forEach((_, domain) => {
    if (ensureCookieRowForDomain(domain)) needsCookie = true;
  });
  saveAuth();

  if (needsCookie) {
    loc.advanced.open = true;
    const [topDomain, topCount] = [...blocked.entries()].sort((a, b) => b[1] - a[1])[0];
    toast(
      'warn',
      `${topCount} image${topCount === 1 ? '' : 's'} on <strong>${escapeHtml(topDomain)}</strong> ` +
        `couldn't be reached server-side (often Cloudflare). Install the browser bridge for ` +
        `automatic handling, or paste its cf_clearance cookie under Advanced and re-scan.`,
      true,
      9000
    );
  }
}

const byName = (a, b) => a.name.localeCompare(b.name);

function resetSelect(sel, label) {
  sel.innerHTML = `<option value="">${label}</option>`;
}

async function ensureLocBooks() {
  if (locBooksLoaded) return;
  // Before setup completes there is nothing to load (and nothing to toast about).
  if (appConfig && !appConfig.configured) return;
  try {
    const data = await api('/api/bookstack/books');
    const books = (data.data || []).sort(byName);
    loc.book.innerHTML =
      '<option value="">All books</option>' +
      books.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    locBooksLoaded = true;
  } catch (err) {
    toast('error', `Could not load books: ${err.message}`);
  }
}

async function onLocBookChange() {
  resetSelect(loc.chapter, 'All chapters');
  resetSelect(loc.page, 'All pages');
  loc.chapter.disabled = true;
  loc.page.disabled = true;
  locContents = null;

  const bookId = loc.book.value;
  if (!bookId) return;

  try {
    const data = await api(`/api/bookstack/books/${bookId}/contents`);
    locContents = data.contents || [];
    const chapters = locContents.filter((i) => i.type === 'chapter').sort(byName);
    loc.chapter.innerHTML =
      '<option value="">All chapters</option>' +
      chapters.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    loc.chapter.disabled = chapters.length === 0;
    populateLocPages();
    loc.page.disabled = false;
  } catch (err) {
    toast('error', `Could not load book contents: ${err.message}`);
  }
}

function populateLocPages() {
  if (!locContents) return;
  const chapterId = loc.chapter.value;
  let pages;
  if (chapterId) {
    const ch = locContents.find((i) => i.type === 'chapter' && String(i.id) === chapterId);
    pages = ch?.pages || [];
  } else {
    const top = locContents.filter((i) => i.type === 'page');
    const inChapters = locContents
      .filter((i) => i.type === 'chapter')
      .flatMap((c) => c.pages || []);
    pages = [...top, ...inChapters];
  }
  pages = [...pages].sort(byName);
  loc.page.innerHTML =
    '<option value="">All pages</option>' +
    pages.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

async function runScan() {
  const scope = {};
  if (loc.page.value) scope.pageId = Number(loc.page.value);
  else if (loc.chapter.value) scope.chapterId = Number(loc.chapter.value);
  else if (loc.book.value) scope.bookId = Number(loc.book.value);
  const auth = buildAuth();
  if (auth) scope.auth = auth;

  setBtnLoading(loc.scanBtn, true);
  loc.scanBtn.disabled = true;
  loc.summary.innerHTML = '';
  loc.results.innerHTML =
    '<p class="loc-empty">Scanning… probing each external image. This can take a moment.</p>';

  try {
    scanData = await api('/api/localize/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope),
    });
    renderScan(scanData);
  } catch (err) {
    loc.results.innerHTML = `<p class="loc-empty">Scan failed: ${escapeHtml(err.message)}</p>`;
    toast('error', `Scan failed: ${err.message}`);
  } finally {
    setBtnLoading(loc.scanBtn, false);
    loc.scanBtn.disabled = false;
  }
}

function renderSummaryChips(t) {
  if (!t) return;
  // The blocked total reads as "unreachable" (red) normally, but "via bridge"
  // (blue) when the bridge is active and will fetch them.
  const blockedChip = t.unreachable
    ? ext.available
      ? `<span class="loc-chip chip-bridge"><strong>${t.unreachable}</strong> via bridge</span>`
      : `<span class="loc-chip chip-dead"><strong>${t.unreachable}</strong> unreachable</span>`
    : '';
  loc.summary.innerHTML = [
    `<span class="loc-chip"><strong>${t.pagesScanned}</strong> pages scanned</span>`,
    `<span class="loc-chip"><strong>${t.pagesWithExternal}</strong> with external images</span>`,
    `<span class="loc-chip"><strong>${t.externalImages}</strong> external images</span>`,
    `<span class="loc-chip chip-ok"><strong>${t.reachable}</strong> reachable</span>`,
    blockedChip,
  ]
    .filter(Boolean)
    .join('');
}

function renderScan(data) {
  renderSummaryChips(data.totals);

  if (!data.pages.length) {
    loc.results.innerHTML =
      '<p class="loc-empty">No externally-hosted images found in this scope. 🎉</p>';
    updateSelCount();
    return;
  }

  blockedUrlSet = new Set();
  bridgeMetaDone = false;
  data.pages.forEach((p) => p.images.forEach((i) => { if (!i.ok) blockedUrlSet.add(i.url); }));

  loc.results.innerHTML = data.pages.map(renderPageCard).join('');
  loc.results
    .querySelectorAll('.loc-img-check')
    .forEach((cb) => cb.addEventListener('change', onCheckChange));
  loc.results
    .querySelectorAll('.loc-page-check')
    .forEach((cb) => cb.addEventListener('change', onPageCheckChange));
  syncPageChecks();
  updateSelCount();
  handleBlockedHosts(data);
}

function renderPageCard(p) {
  const dead = p.images.filter((i) => !i.ok).length;
  const rows = p.images.map((i) => renderImgRow(p.id, i)).join('');
  const count = `${p.images.length} image${p.images.length === 1 ? '' : 's'}`;
  const blockedLabel = ext.available ? 'via bridge' : 'unreachable';
  const blockedCls = ext.available ? 'via-bridge' : 'dead';
  const deadTxt = dead ? ` · <span class="${blockedCls}">${dead} ${blockedLabel}</span>` : '';
  return `
  <div class="loc-page-card" data-page="${p.id}" data-name="${escapeHtml(p.name)}">
    <div class="loc-page-head">
      <input type="checkbox" class="loc-page-check" title="Select all on this page" />
      <a class="loc-page-title" href="${p.link}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>
      <span class="loc-editor-badge">${escapeHtml(p.editor || '')}</span>
      <span class="loc-page-counts">${count}${deadTxt}</span>
    </div>
    ${rows}
  </div>`;
}

function renderImgRow(pageId, img) {
  // A blocked image is recoverable when the browser bridge is active.
  const viaBridge = !img.ok && ext.available;
  const status = String(img.status || 'DEAD');
  let badge;
  if (img.ok) badge = '<span class="badge badge-ok">OK</span>';
  else if (viaBridge)
    badge =
      '<span class="badge badge-bridge" title="Fetched through your browser on Localize">BRIDGE</span>';
  else badge = `<span class="badge badge-dead">${escapeHtml(status)}</span>`;
  const checked = img.ok || viaBridge;
  const size = img.size ? `${Math.round(img.size / 1024)} KB` : '';
  const type = (img.contentType || '').replace(/^image\//, '');
  const meta = [size, type].filter(Boolean).join(' · ') || '—';
  const note = viaBridge ? '' : img.error ? escapeHtml(img.error) : '';
  return `
  <div class="loc-img-row" data-url="${escapeHtml(img.url)}" data-status="${escapeHtml(status)}">
    <input type="checkbox" class="loc-img-check" ${checked ? 'checked' : ''} data-page="${pageId}" />
    ${badge}
    <span class="loc-img-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</span>
    <span class="loc-img-url"><a href="${escapeHtml(img.url)}" target="_blank" rel="noopener" title="${escapeHtml(img.url)}">${escapeHtml(img.url)}</a></span>
    <span class="loc-img-note" title="${note}">${note}</span>
  </div>`;
}

function onCheckChange() {
  syncPageChecks();
  updateSelCount();
}

function onPageCheckChange(e) {
  const card = e.target.closest('.loc-page-card');
  card.querySelectorAll('.loc-img-check').forEach((cb) => {
    if (!cb.disabled) cb.checked = e.target.checked;
  });
  updateSelCount();
}

function onSelectAll() {
  const on = loc.selectAll.checked;
  loc.results.querySelectorAll('.loc-img-row').forEach((row) => {
    const cb = row.querySelector('.loc-img-check');
    if (cb.disabled) return;
    // Reachable images, plus blocked ones the bridge can recover.
    if (row.querySelector('.badge-ok') || row.querySelector('.badge-bridge')) cb.checked = on;
  });
  syncPageChecks();
  updateSelCount();
}

// Re-skin blocked-image rows when the bridge connects/disconnects after a scan:
// red "403" ⇄ blue "BRIDGE", and re-label the per-page counts.
function refreshBridgeBadges() {
  if (!scanData || !loc.results) return;
  loc.results.querySelectorAll('.loc-img-row').forEach((row) => {
    if (!blockedUrlSet.has(row.dataset.url) || row.classList.contains('is-done')) return;
    const badge = row.querySelector('.badge');
    const cb = row.querySelector('.loc-img-check');
    if (ext.available) {
      badge.className = 'badge badge-bridge';
      badge.textContent = 'BRIDGE';
      badge.title = 'Fetched through your browser on Localize';
      cb.checked = true;
      row.querySelector('.loc-img-note').textContent = '';
    } else {
      badge.className = 'badge badge-dead';
      badge.textContent = row.dataset.status || 'DEAD';
      badge.title = '';
    }
  });
  loc.results.querySelectorAll('.loc-page-card').forEach(updatePageCount);
  renderSummaryChips(scanData.totals);
  syncPageChecks();
  updateSelCount();
  if (ext.available) populateBridgeMeta();
}

// Fill in size · type for blocked images by probing them through the bridge.
async function populateBridgeMeta() {
  if (bridgeMetaDone || !ext.available) return;
  const urls = [...blockedUrlSet];
  if (!urls.length) return;
  bridgeMetaDone = true;
  const results = await extProbe(urls);
  results.forEach((r) => {
    if (r.ok) updateImgMeta(r.url, r.size, r.contentType);
  });
}

function updateImgMeta(url, size, contentType) {
  const row = [...loc.results.querySelectorAll('.loc-img-row')].find((r) => r.dataset.url === url);
  if (!row) return;
  const sizeTxt = size ? `${Math.round(size / 1024)} KB` : '';
  const type = (contentType || '').replace(/^image\//, '');
  const meta = [sizeTxt, type].filter(Boolean).join(' · ');
  if (!meta) return;
  const metaEl = row.querySelector('.loc-img-meta');
  if (metaEl) {
    metaEl.textContent = meta;
    metaEl.title = meta;
  }
}

function updatePageCount(card) {
  const countEl = card.querySelector('.loc-page-counts');
  if (!countEl) return;
  const rows = [...card.querySelectorAll('.loc-img-row')];
  const total = rows.length;
  const blocked = rows.filter(
    (r) => blockedUrlSet.has(r.dataset.url) && !r.classList.contains('is-done')
  ).length;
  const label = ext.available ? 'via bridge' : 'unreachable';
  const cls = ext.available ? 'via-bridge' : 'dead';
  countEl.innerHTML =
    `${total} image${total === 1 ? '' : 's'}` +
    (blocked ? ` · <span class="${cls}">${blocked} ${label}</span>` : '');
}

function syncPageChecks() {
  loc.results.querySelectorAll('.loc-page-card').forEach((card) => {
    const boxes = [...card.querySelectorAll('.loc-img-check')].filter((b) => !b.disabled);
    const pc = card.querySelector('.loc-page-check');
    const checked = boxes.filter((b) => b.checked).length;
    pc.checked = boxes.length > 0 && checked === boxes.length;
    pc.indeterminate = checked > 0 && checked < boxes.length;
  });
}

function updateSelCount() {
  const n = loc.results.querySelectorAll('.loc-img-check:checked').length;
  loc.selCount.textContent = `${n} image${n === 1 ? '' : 's'} selected`;
  loc.applyBtn.disabled = n === 0;
}

function getSelections() {
  const map = new Map();
  loc.results.querySelectorAll('.loc-img-check:checked').forEach((cb) => {
    const card = cb.closest('.loc-page-card');
    const pageId = Number(card.dataset.page);
    const url = cb.closest('.loc-img-row').dataset.url;
    if (!map.has(pageId)) map.set(pageId, { pageId, name: card.dataset.name, urls: [] });
    map.get(pageId).urls.push(url);
  });
  return [...map.values()];
}

function findRow(card, url) {
  return [...card.querySelectorAll('.loc-img-row')].find((r) => r.dataset.url === url);
}

async function runApply() {
  const selections = getSelections();
  if (!selections.length) return;
  const total = selections.reduce((n, s) => n + s.urls.length, 0);

  const ok = await confirmDialog({
    title: 'Localize images',
    body:
      `Localize <strong>${total}</strong> image${total === 1 ? '' : 's'} across ` +
      `<strong>${selections.length}</strong> page${selections.length === 1 ? '' : 's'}?` +
      `<p class="modal-note">This downloads each image, re-hosts it in BookStack, and ` +
      `rewrites the page. Every edit is saved to the page's BookStack revision history, ` +
      `so it can be reverted.</p>`,
    confirmText: 'Localize →',
    cancelText: 'Cancel',
  });
  if (!ok) return;

  setBtnLoading(loc.applyBtn, true);
  loc.applyBtn.disabled = true;
  loc.scanBtn.disabled = true;

  let okCount = 0;
  let failCount = 0;

  for (const sel of selections) {
    const card = loc.results.querySelector(`.loc-page-card[data-page="${sel.pageId}"]`);
    const statusEl = markCardWorking(card);
    try {
      // For images the server probe couldn't reach, fetch the bytes through the
      // browser bridge (passes Cloudflare) and hand them to the server.
      const blocked = sel.urls.filter((u) => blockedUrlSet.has(u));
      if (blocked.length && ext.available) {
        if (statusEl) statusEl.textContent = 'fetching via browser…';
        const fetched = await extFetch(blocked);
        const blobs = {};
        fetched.forEach((r) => {
          if (r.ok) blobs[r.url] = { dataBase64: r.dataBase64, contentType: r.contentType };
        });
        if (Object.keys(blobs).length) sel.blobs = blobs;
      }

      const res = await api('/api/localize/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections: [sel], auth: buildAuth() }),
      });
      const r = res.results[0];
      okCount += r.localized.length;
      failCount += r.failed.length;
      applyCardResult(card, r);
    } catch (err) {
      failCount += sel.urls.length;
      if (statusEl) {
        statusEl.textContent = 'error';
        statusEl.style.color = 'var(--red)';
      }
      toast('error', `Page "${sel.name}": ${err.message}`);
    }
  }

  setBtnLoading(loc.applyBtn, false);
  loc.scanBtn.disabled = false;
  updateSelCount();
  toast(
    failCount ? 'warn' : 'success',
    `Localized ${okCount} image${okCount === 1 ? '' : 's'}` +
      (failCount ? `, ${failCount} failed (see rows)` : '') +
      '. Re-scan to confirm.'
  );
}

function markCardWorking(card) {
  let s = card.querySelector('.loc-page-status');
  if (!s) {
    s = document.createElement('span');
    s.className = 'loc-page-status';
    card.querySelector('.loc-page-head').appendChild(s);
  }
  s.textContent = 'localizing…';
  s.style.color = 'var(--accent-hover)';
  return s;
}

function applyCardResult(card, r) {
  (r.localized || []).forEach((m) => {
    const row = findRow(card, m.from);
    if (!row) return;
    row.classList.add('is-done');
    const b = row.querySelector('.badge');
    b.className = 'badge badge-done';
    b.textContent = 'DONE';
    const cb = row.querySelector('.loc-img-check');
    cb.checked = false;
    cb.disabled = true;
  });
  (r.failed || []).forEach((f) => {
    const row = findRow(card, f.url);
    if (!row) return;
    const b = row.querySelector('.badge');
    b.className = 'badge badge-fail';
    b.textContent = 'FAIL';
    const note = row.querySelector('.loc-img-note');
    note.textContent = f.error;
    note.title = f.error;
  });
  const s = card.querySelector('.loc-page-status');
  if (s) {
    s.textContent = r.updated ? 'updated ✓' : r.localized.length ? 'done' : 'no changes';
    s.style.color = r.updated ? 'var(--green)' : 'var(--text-muted)';
  }
}

document.addEventListener('DOMContentLoaded', init);
