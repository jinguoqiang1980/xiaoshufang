'use strict';
/* =========================================================
 * 小书房 — 本地电子书阅读器
 * 所有数据只保存在本机浏览器（IndexedDB / localStorage）
 * ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtPct = p => (Math.min(1, Math.max(0, p || 0)) * 100).toFixed(1) + '%';
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* ---------------- 本地数据库 ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('xiaoshufang', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('books', { keyPath: 'id' });     // 书的信息、进度、书签、笔记
        r.result.createObjectStore('contents', { keyPath: 'id' });  // 书的正文
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  get(s, id) { return this.run(s, 'readonly', st => st.get(id)); },
  all(s) { return this.run(s, 'readonly', st => st.getAll()); },
  put(s, v) { return this.run(s, 'readwrite', st => st.put(v)); },
  del(s, id) { return this.run(s, 'readwrite', st => st.delete(id)); }
};

/* ---------------- 设置 ---------------- */
const DEFAULTS = { fontSize: 19, lineHeight: 1.8, theme: 'sepia', font: 'serif', ttsRate: 1, ttsVoice: '' };
let SET = { ...DEFAULTS };
try { Object.assign(SET, JSON.parse(localStorage.getItem('xsf-settings') || '{}')); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('xsf-settings', JSON.stringify(SET)); } catch (e) {} };
const THEME_BG = { day: '#ffffff', sepia: '#f4ecd8', night: '#121212' };
let reading = false;

function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = SET.theme;
  r.style.setProperty('--fs', SET.fontSize + 'px');
  r.style.setProperty('--lh', SET.lineHeight);
  r.style.setProperty('--font', SET.font === 'sans' ? 'var(--sans)' : 'var(--serif)');
  $('meta[name=theme-color]').content = reading ? THEME_BG[SET.theme] : (SET.theme === 'night' ? '#121212' : SET.theme === 'day' ? '#f6f3ee' : '#f4ecd8');
}

/* =========================================================
 * 解析 TXT
 * ========================================================= */
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) {}
  try { return new TextDecoder('gb18030').decode(u8); } catch (e) {}  // 很多中文 TXT 是 GBK 编码
  return new TextDecoder('gbk').decode(u8);
}

const NUM = '0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟';
const CH_RE = new RegExp(
  `^(?:第[${NUM}]+[章节回卷集部篇幕话]` +
  `|(?:序章|序言|序|楔子|引子|前言|后记|尾声|终章|番外|完本感言)(?=$|[\\s:：·、—\\-（(])` +
  `|chapter\\s*[0-9ivxlc]+\\b)`, 'i');

const cleanLine = l => l.replace(/^[\s　 ﻿]+|[\s　 ]+$/g, '');

function splitChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(cleanLine).filter(Boolean);
  const raw = [];
  let cur = { title: '', lines: [] };
  for (const l of lines) {
    if (l.length <= 40 && CH_RE.test(l)) {
      if (cur.title || cur.lines.length) raw.push(cur);
      cur = { title: l, lines: [] };
    } else cur.lines.push(l);
  }
  raw.push(cur);
  // 去掉只有标题没有正文的（比如书开头的目录）
  let chapters = raw.filter(c => c.lines.length).map(c => ({ title: c.title || '开篇', text: c.lines.join('\n') }));
  const titled = chapters.filter(c => c.title !== '开篇').length;
  if (titled < 2) {
    // 没识别出章节：每 8000 字左右分成一段
    chapters = [];
    let buf = [], size = 0;
    const flush = () => { if (buf.length) { chapters.push({ title: `第 ${chapters.length + 1} 部分`, text: buf.join('\n') }); buf = []; size = 0; } };
    for (const l of lines) { buf.push(l); size += l.length; if (size >= 8000) flush(); }
    flush();
  }
  return chapters;
}

function parseTxt(buf, name) {
  return { title: name, author: '', format: 'txt', chapters: splitChapters(decodeText(buf)) };
}

/* =========================================================
 * 解析 EPUB
 * ========================================================= */
function resolvePath(base, href) {
  const parts = (base + href.split('#')[0]).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}
const byTag = (doc, tag) => Array.from(doc.getElementsByTagNameNS('*', tag));
function parseXml(str, type = 'application/xml') {
  const d = new DOMParser().parseFromString(str, type);
  return d.getElementsByTagName('parsererror').length ? null : d;
}
function parseXhtml(str) {
  return parseXml(str, 'application/xhtml+xml') || new DOMParser().parseFromString(str, 'text/html');
}

const BLOCK = /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|SECTION|ARTICLE|PRE|DT|DD|FIGCAPTION|HR|TABLE|UL|OL|HEADER|FOOTER|ASIDE)$/;
function htmlToText(doc) {
  const body = byTag(doc, 'body')[0] || doc.documentElement;
  let out = '';
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue.replace(/\s+/g, ' ');
      else if (c.nodeType === 1) {
        const tag = (c.localName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD') continue;
        if (tag === 'BR') { out += '\n'; continue; }
        const b = BLOCK.test(tag);
        if (b) out += '\n';
        walk(c);
        if (b) out += '\n';
      }
    }
  })(body);
  return out.split('\n').map(cleanLine).filter(Boolean).join('\n');
}

async function parseEpub(buf, name) {
  if (typeof JSZip === 'undefined') throw new Error('EPUB 组件没有加载');
  const zip = await JSZip.loadAsync(buf);
  const read = p => {
    const f = zip.file(p) || zip.file(decodeURIComponent(p));
    return f ? f.async('string') : Promise.resolve(null);
  };
  const container = parseXml(await read('META-INF/container.xml') || '');
  if (!container) throw new Error('不是有效的 EPUB 文件');
  const opfPath = byTag(container, 'rootfile')[0].getAttribute('full-path');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = parseXml(await read(opfPath) || '');
  if (!opf) throw new Error('EPUB 目录文件损坏');

  const title = (byTag(opf, 'title')[0]?.textContent || '').trim() || name;
  const author = (byTag(opf, 'creator')[0]?.textContent || '').trim();
  const manifest = {};
  let navHref = null, ncxHref = null;
  for (const it of byTag(opf, 'item')) {
    const href = resolvePath(base, it.getAttribute('href') || '');
    manifest[it.getAttribute('id')] = href;
    if ((it.getAttribute('properties') || '').split(/\s+/).includes('nav')) navHref = href;
    if (it.getAttribute('media-type') === 'application/x-dtbncx+xml') ncxHref = href;
  }
  const spine = byTag(opf, 'itemref').map(i => manifest[i.getAttribute('idref')]).filter(Boolean);

  // 读取原书目录，得到 文件 → 章节名
  const tocMap = {};
  if (ncxHref) {
    const ncx = parseXml(await read(ncxHref) || '');
    const nb = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/') + 1) : '';
    if (ncx) for (const np of byTag(ncx, 'navPoint')) {
      const label = (byTag(np, 'text')[0]?.textContent || '').trim();
      const src = byTag(np, 'content')[0]?.getAttribute('src');
      if (label && src) { const p = resolvePath(nb, src); if (!tocMap[p]) tocMap[p] = label; }
    }
  }
  if (!Object.keys(tocMap).length && navHref) {
    const nav = new DOMParser().parseFromString(await read(navHref) || '', 'text/html');
    const nb = navHref.includes('/') ? navHref.slice(0, navHref.lastIndexOf('/') + 1) : '';
    for (const a of nav.querySelectorAll('nav a[href]')) {
      const p = resolvePath(nb, a.getAttribute('href')); const label = a.textContent.trim();
      if (label && !tocMap[p]) tocMap[p] = label;
    }
  }

  const chapters = [];
  for (const href of spine) {
    if (href === navHref) continue;
    const src = await read(href);
    if (!src) continue;
    const doc = parseXhtml(src);
    let text = htmlToText(doc);
    if (!text) continue;
    let t = tocMap[href];
    if (!t) {
      const h = byTag(doc, 'h1')[0] || byTag(doc, 'h2')[0] || byTag(doc, 'h3')[0];
      t = h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
    }
    if (!t && chapters.length) { chapters[chapters.length - 1].text += '\n' + text; continue; } // 同一章被拆成多个文件
    const lines = text.split('\n');
    const first = lines[0].replace(/\s+/g, '');
    if (t && lines.length > 1 && first.length <= 40 && (first === t.replace(/\s+/g, '') || t.replace(/\s+/g, '').startsWith(first)))
      text = lines.slice(1).join('\n');   // 避免标题重复显示
    if (!text) text = '　';
    chapters.push({ title: t || '开篇', text });
  }
  if (!chapters.length) throw new Error('这本 EPUB 里没有可识别的文字（可能是纯图片书）');
  return { title, author, format: 'epub', chapters };
}

/* =========================================================
 * 解析 PDF（用 pdf.js 提取文字）
 * ========================================================= */
let pdfjsReady = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return pdfjsReady || (pdfjsReady = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = './pdfjs/pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) return fail(new Error('PDF 组件没有加载'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = './pdfjs/pdf.worker.min.js';
      ok(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsReady = null; fail(new Error('PDF 组件加载失败，请联网后重试')); };
    document.head.appendChild(s);
  }));
}

// 把一页的文字片段按位置拼成行，再合并成段落
function pdfPageLines(items) {
  const lines = [];
  let cur = '', lastY = null, lastH = 0;
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
    if (lastY !== null && Math.abs(y - lastY) > Math.max(h, lastH) * 0.5) { lines.push({ t: cur, y: lastY, h: lastH }); cur = ''; }
    cur += it.str;
    if (it.hasEOL) { lines.push({ t: cur, y, h }); cur = ''; lastY = null; continue; }
    if (it.str.trim()) { lastY = y; lastH = h; } else if (lastY === null) { lastY = y; lastH = h; }
  }
  if (cur) lines.push({ t: cur, y: lastY, h: lastH });
  // PDF 里常把“一、文、用”等存成康熙部首字符（⼀⽂⽤），统一转回普通汉字
  const fix = t => t.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, c => c.normalize('NFKC'));
  return lines.map(l => ({ ...l, t: cleanLine(fix(l.t)) })).filter(l => l.t);
}

function pdfJoinLines(lines) {
  // 典型行宽：用来判断一行是否“写满”（没写满通常是段落结尾）
  const lens = lines.map(l => l.t.length).sort((a, b) => a - b);
  const full = lens.length ? lens[Math.floor(lens.length * 0.8)] : 0;
  const paras = [];
  let buf = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].t;
    if (/^\d{1,4}$|^[-–—\s]*\d{1,4}[-–—\s]*$|^第\s*\d+\s*页/.test(l)) continue; // 页码
    if (CH_RE.test(l) && l.length <= 40) { if (buf) paras.push(buf); paras.push(l); buf = ''; continue; }
    if (buf && /[a-zA-Z]$/.test(buf) && /^[a-zA-Z]/.test(l)) buf += ' ';
    buf += l;
    const short = full >= 8 && l.length < full * 0.85;
    const endPunct = /[。！？!?」』”…）)：:]$/.test(l);
    if (short || (endPunct && full < 8)) { paras.push(buf); buf = ''; }
  }
  if (buf) paras.push(buf);
  return paras;
}

async function parsePdf(buf, name, onProgress) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(buf), cMapUrl: './pdfjs/cmaps/', cMapPacked: true,
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false
  }).promise;
  let title = name, author = '';
  try {
    const md = await doc.getMetadata();
    if (md.info && md.info.Title && md.info.Title.trim().length > 1) title = md.info.Title.trim();
    if (md.info && md.info.Author) author = md.info.Author.trim();
  } catch (e) {}
  const all = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    if (onProgress) onProgress(p, doc.numPages);
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines = pdfPageLines(tc.items);
    chars += lines.reduce((s, l) => s + l.t.replace(/\s/g, '').length, 0);
    all.push(...lines);
    page.cleanup();
    if (p % 5 === 0) await sleep(0);
  }
  doc.destroy();
  if (chars < Math.max(20, doc.numPages * 5)) throw new Error('这本 PDF 是扫描图片，暂时无法提取文字');
  return { title, author, format: 'pdf', chapters: splitChapters(pdfJoinLines(all).join('\n')) };
}


/* =========================================================
 * 导入 & 书架
 * ========================================================= */
async function importFiles(files) {
  let ok = 0;
  for (const f of files) {
    showLoading(`正在导入《${f.name}》…`);
    await sleep(50);
    try {
      const buf = await f.arrayBuffer();
      const name = f.name.replace(/\.(txt|epub|pdf)$/i, '');
      const head = new Uint8Array(buf.slice(0, 4));
      const isZip = head[0] === 0x50 && head[1] === 0x4B;
      const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
      const res = (/\.pdf$/i.test(f.name) || isPdf)
        ? await parsePdf(buf, name, (p, n) => showLoading(`正在导入《${f.name}》… 第 ${p}/${n} 页`))
        : (/\.epub$/i.test(f.name) || isZip) ? await parseEpub(buf, name) : parseTxt(buf, name);
      if (!res.chapters.length) throw new Error('没有读到文字内容');
      const id = uid();
      const total = res.chapters.reduce((s, c) => s + c.text.length + 1, 0);
      await DB.put('contents', { id, chapters: res.chapters });
      await DB.put('books', {
        id, title: res.title, author: res.author, format: res.format, added: Date.now(), lastRead: 0,
        total, chapterCount: res.chapters.length, pos: { ch: 0, off: 0 }, percent: 0, bookmarks: [], notes: []
      });
      ok++;
      toast(`已导入《${res.title}》，共 ${res.chapters.length} 章`);
    } catch (e) {
      console.error(e);
      hideLoading();
      await dialog({ title: '导入失败', html: esc(`《${f.name}》：${e.message || e}`), buttons: [{ text: '知道了', cls: 'main' }] });
    }
  }
  hideLoading();
  renderShelf();
}

const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; };

async function renderShelf() {
  const books = (await DB.all('books')).sort((a, b) => (b.lastRead || b.added) - (a.lastRead || a.added));
  $('#empty').classList.toggle('hidden', books.length > 0);
  $('#shelfTip').classList.toggle('hidden', books.length === 0);
  $('#books').innerHTML = books.map(b => `
    <div class="book" data-id="${b.id}">
      <div class="cover" style="--h:${hue(b.title)}">
        <span class="cover-title">${esc(b.title)}</span>
        ${b.author ? `<span class="cover-author">${esc(b.author)}</span>` : ''}
        <span class="cover-fmt">${b.format.toUpperCase()}</span>
      </div>
      <div class="book-name">${esc(b.title)}</div>
      <div class="book-prog">${b.lastRead ? '已读 ' + fmtPct(b.percent) : '未读'}</div>
    </div>`).join('');
}

async function confirmDelete(id) {
  const b = await DB.get('books', id);
  if (!b) return;
  const r = await dialog({
    title: '删除这本书？', html: `《${esc(b.title)}》以及它的进度、书签、笔记都会被删除，无法恢复。`,
    buttons: [{ text: '取消' }, { text: '删除', cls: 'danger', key: 'del' }]
  });
  document.querySelectorAll('.book.pressed').forEach(e => e.classList.remove('pressed'));
  if (r.key !== 'del') return;
  await DB.del('books', id); await DB.del('contents', id);
  toast('已删除'); renderShelf();
}

function bindShelf() {
  const fileInput = $('#file');
  const pick = () => { fileInput.value = ''; fileInput.click(); };
  $('#btnImport').onclick = pick;
  $('#btnImport2').onclick = pick;
  fileInput.onchange = () => { if (fileInput.files.length) importFiles([...fileInput.files]); };
  $('#btnExportAll').onclick = exportAllNotes;

  // 点击打开，长按删除
  const books = $('#books');
  let lp = null, lpFiredAt = 0, lastTouch = 0;
  books.addEventListener('touchstart', e => {
    lastTouch = Date.now();
    const el = e.target.closest('.book'); if (!el) return;
    const t = e.touches[0];
    lp = { x: t.clientX, y: t.clientY, timer: setTimeout(() => {
      lpFiredAt = Date.now(); el.classList.add('pressed');
      if (navigator.vibrate) navigator.vibrate(15);
      confirmDelete(el.dataset.id);
    }, 550) };
  }, { passive: true });
  books.addEventListener('touchmove', e => {
    if (!lp) return; const t = e.touches[0];
    if (Math.abs(t.clientX - lp.x) > 10 || Math.abs(t.clientY - lp.y) > 10) { clearTimeout(lp.timer); lp = null; }
  }, { passive: true });
  const end = () => { if (lp) clearTimeout(lp.timer); lp = null; lastTouch = Date.now(); };
  books.addEventListener('touchend', end);
  books.addEventListener('touchcancel', end);
  books.addEventListener('click', e => {
    const el = e.target.closest('.book'); if (!el) return;
    if (Date.now() - lpFiredAt < 900) return;
    openBook(el.dataset.id);
  });
  books.addEventListener('contextmenu', e => {
    e.preventDefault();
    const el = e.target.closest('.book');
    if (el && Date.now() - lastTouch > 1000) confirmDelete(el.dataset.id); // 电脑上右键删除
  });
}

/* =========================================================
 * 阅读器
 * ========================================================= */
const R = { meta: null, chapters: null, starts: [], total: 1, ch: 0, page: 0, pages: 1, off: 0, step: 1, offs: [], ps: [], menu: false, sel: null, lastSearch: null };
let viewer, content;

async function openBook(id) {
  showLoading('正在打开…');
  const [meta, c] = await Promise.all([DB.get('books', id), DB.get('contents', id)]);
  hideLoading();
  if (!meta || !c) return toast('找不到这本书的数据');
  R.meta = meta; R.chapters = c.chapters;
  meta.bookmarks = meta.bookmarks || []; meta.notes = meta.notes || [];
  R.starts = []; let s = 0;
  for (const ch of R.chapters) { R.starts.push(s); s += ch.text.length + 1; }
  R.total = Math.max(1, s);
  reading = true;
  $('#shelf').classList.add('hidden');
  $('#reader').classList.remove('hidden');
  $('#bookTitle').textContent = meta.title;
  applySettings(); hideMenu();
  history.pushState({ reader: 1 }, '');
  const p = meta.pos || { ch: 0, off: 0 };
  openChapter(Math.min(p.ch, R.chapters.length - 1), p.off || 0);
  meta.lastRead = Date.now(); saveMeta();
}

function closeReader() {
  if (!reading) return;
  ttsStop(true); savePos(); closeSheet(true);
  reading = false; R.lastSearch = null;
  $('#reader').classList.add('hidden');
  $('#shelf').classList.remove('hidden');
  $('#selbar').classList.add('hidden');
  applySettings(); renderShelf();
}

/* --- 排版：用 CSS 分栏，每一栏就是一页 --- */
function markup(t, base, notes) {
  const hs = notes.filter(n => n.start < base + t.length && n.end > base);
  if (!hs.length) return esc(t);
  const pts = new Set([0, t.length]);
  hs.forEach(n => { pts.add(Math.max(0, n.start - base)); pts.add(Math.min(t.length, n.end - base)); });
  const arr = [...pts].sort((a, b) => a - b);
  let s = '';
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1]; if (a === b) continue;
    const seg = esc(t.slice(a, b));
    const n = hs.find(n => n.start <= base + a && n.end >= base + b);
    s += n ? `<mark data-nid="${n.id}"${n.note ? ' class="has-note"' : ''}>${seg}</mark>` : seg;
  }
  return s;
}

function renderChapter() {
  const ch = R.chapters[R.ch];
  const notes = R.meta.notes.filter(n => n.ch === R.ch);
  let html = `<h2 class="ch-title">${esc(ch.title || '')}</h2>`;
  let off = 0; R.offs = [];
  for (const t of ch.text.split('\n')) {
    R.offs.push(off);
    html += `<p data-off="${off}">${markup(t, off, notes)}</p>`;
    off += t.length + 1;
  }
  content.innerHTML = html;
  R.ps = Array.from(content.querySelectorAll('p'));
  $('#hdr').textContent = ch.title || R.meta.title;
}

// 章节内第 off 个字所在的位置
function rangeAt(off) {
  let lo = 0, hi = R.offs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (R.offs[m] <= off) lo = m; else hi = m - 1; }
  const p = R.ps[lo]; let local = off - R.offs[lo];
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n, last = null;
  const r = document.createRange();
  while ((n = w.nextNode())) {
    last = n;
    if (local < n.length) { r.setStart(n, local); r.setEnd(n, local + 1); return r; }
    local -= n.length;
  }
  if (last && last.length) { r.setStart(last, last.length - 1); r.setEnd(last, last.length); }
  else r.selectNodeContents(p);
  return r;
}

function pageOfOff(off) {
  if (!R.ps.length) return 0;
  const r = rangeAt(Math.max(0, off));
  const rects = r.getClientRects();
  const rect = rects.length ? rects[0] : r.getBoundingClientRect();
  const base = content.getBoundingClientRect().left;
  return Math.max(0, Math.floor((rect.left - base + 2) / R.step));
}

function firstOffOfPage(page) {
  if (page <= 0) return 0;
  let lo = 0, hi = Math.max(0, R.chapters[R.ch].text.length - 1);
  while (lo < hi) { const m = (lo + hi) >> 1; if (pageOfOff(m) >= page) hi = m; else lo = m + 1; }
  return lo;
}

function measure() {
  const cs = getComputedStyle(viewer);
  const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight);
  const W = Math.floor(viewer.clientWidth - pl - pr);
  const H = Math.floor(viewer.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  const gap = Math.ceil(pl + pr);
  R.step = W + gap;
  Object.assign(content.style, { width: W + 'px', height: H + 'px', columnWidth: W + 'px', columnGap: gap + 'px' });
  const len = R.chapters[R.ch].text.length;
  R.pages = len ? pageOfOff(len - 1) + 1 : 1;
}

function setPage(p, anim) {
  R.page = Math.max(0, Math.min(p, R.pages - 1));
  content.style.transition = anim ? 'transform .26s ease-out' : 'none';
  content.style.transform = `translate3d(${-R.page * R.step}px,0,0)`;
  R.off = firstOffOfPage(R.page);
  updateStatus(); schedSave();
}

function openChapter(ch, target = 0) {
  R.ch = Math.max(0, Math.min(ch, R.chapters.length - 1));
  renderChapter(); measure();
  setPage(target === 'end' ? R.pages - 1 : pageOfOff(target), false);
}

function relayout() {
  if (!reading) return;
  const off = R.off;
  measure(); setPage(pageOfOff(off), false);
}

function refreshChapter() {   // 加了高亮后重画本章，停在当前页
  const p = R.page; renderChapter(); measure(); setPage(Math.min(p, R.pages - 1), false);
}

function nextPage() {
  if (R.page < R.pages - 1) setPage(R.page + 1, true);
  else if (R.ch < R.chapters.length - 1) openChapter(R.ch + 1, 0);
  else toast('已经是最后一页了');
}
function prevPage() {
  if (R.page > 0) setPage(R.page - 1, true);
  else if (R.ch > 0) openChapter(R.ch - 1, 'end');
  else toast('已经是第一页了');
}

function percentNow() {
  if (R.ch === R.chapters.length - 1 && R.page === R.pages - 1) return 1;
  return (R.starts[R.ch] + R.off) / R.total;
}

function updateStatus() {
  $('#stLeft').textContent = R.meta.title;
  $('#stRight').textContent = `${R.page + 1}/${R.pages}页　${fmtPct(percentNow())}`;
  const bm = bookmarkOnPage();
  $('#ribbon').classList.toggle('hidden', !bm);
  $('#btnBm').classList.toggle('on', !!bm);
  if (R.menu) $('#prog').value = Math.round(percentNow() * 1000);
}

let saveTimer;
function schedSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePos, 400); }
function savePos() {
  clearTimeout(saveTimer);
  if (!R.meta || !reading) return;
  R.meta.pos = { ch: R.ch, off: R.off };
  R.meta.percent = percentNow();
  R.meta.lastRead = Date.now();
  saveMeta();
}
function saveMeta() { return DB.put('books', R.meta).catch(e => console.error(e)); }

function jumpTo(ch, off) { closeSheet(true); hideMenu(); openChapter(ch, off); ttsFollow(); }

/* --- 菜单 --- */
function showMenu() { R.menu = true; $('#reader').classList.add('menu-on'); updateStatus(); }
function hideMenu() { R.menu = false; $('#reader').classList.remove('menu-on'); }

function hasSelection() { const s = getSelection(); return s && !s.isCollapsed && s.toString().trim().length > 0; }

function handleTap(x, y, target) {
  if (R.menu) { hideMenu(); return; }
  const w = window.innerWidth;
  if (x < w * 0.3) { prevPage(); return ttsFollow(); }
  if (x > w * 0.7) { nextPage(); return ttsFollow(); }
  const m = target && target.closest && target.closest('mark[data-nid]');
  if (m) return editNote(m.dataset.nid);
  showMenu();
}

function bindReader() {
  viewer = $('#viewer'); content = $('#content');
  let t0 = null, lastTouch = 0;
  viewer.addEventListener('touchstart', e => {
    lastTouch = Date.now();
    if (e.touches.length > 1 || hasSelection()) { t0 = null; return; }
    const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });
  viewer.addEventListener('touchend', e => {
    lastTouch = Date.now();
    if (!t0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y, dt = Date.now() - t0.time;
    t0 = null;
    if (hasSelection()) return;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 800) {   // 左右滑动翻页
      e.preventDefault(); if (R.menu) hideMenu();
      dx < 0 ? nextPage() : prevPage();
      ttsFollow();
      return;
    }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 400) {                   // 轻点
      e.preventDefault(); handleTap(t.clientX, t.clientY, e.target);
    }
  });
  viewer.addEventListener('click', e => {   // 电脑上用鼠标点
    if (Date.now() - lastTouch < 800 || hasSelection()) return;
    handleTap(e.clientX, e.clientY, e.target);
  });
  document.addEventListener('keydown', e => {
    if (!reading || !$('#modalMask').classList.contains('hidden') || sheetOpen()) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); nextPage(); ttsFollow(); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prevPage(); ttsFollow(); }
  });

  $('#btnBack').onclick = () => { if (history.state && history.state.reader) history.back(); else closeReader(); };
  $('#btnBm').onclick = toggleBookmark;
  $('#btnPrevCh').onclick = () => { if (R.ch > 0) { openChapter(R.ch - 1, 0); ttsFollow(); } else toast('已经是第一章'); };
  $('#btnNextCh').onclick = () => { if (R.ch < R.chapters.length - 1) { openChapter(R.ch + 1, 0); ttsFollow(); } else toast('已经是最后一章'); };
  const prog = $('#prog');
  const target = () => {
    const g = Math.floor(prog.value / 1000 * (R.total - 1));
    let ch = 0; while (ch < R.starts.length - 1 && R.starts[ch + 1] <= g) ch++;
    return { ch, off: Math.min(g - R.starts[ch], R.chapters[ch].text.length) };
  };
  prog.oninput = () => { const t = target(); toast(`${R.chapters[t.ch].title}　${(prog.value / 10).toFixed(1)}%`); };
  prog.onchange = () => { const t = target(); openChapter(t.ch, t.off); ttsFollow(); };

  $('#bottombar').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    ({ toc: showToc, bm: showBookmarks, search: showSearch, notes: showNotes, tts: showTts, settings: showSettings })[b.dataset.tool]();
  });

  // 选中文字 → 高亮 / 笔记
  let selT;
  document.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(checkSelection, 120); });
  $('#selbar').addEventListener('pointerdown', e => {
    const b = e.target.closest('button'); if (!b) return;
    e.preventDefault();
    if (!R.sel) return;
    const n = addHighlight(R.sel.s, R.sel.e);
    R.sel = null;
    getSelection().removeAllRanges();
    $('#selbar').classList.add('hidden');
    if (n && b.dataset.act === 'note') editNote(n.id);
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(relayout, 200); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); else ttsWake(); });
  window.addEventListener('pagehide', savePos);
  window.addEventListener('popstate', () => {
    if (!$('#modalMask').classList.contains('hidden')) { $('#modalMask').querySelector('[data-i="0"]')?.click(); history.pushState({ reader: 1 }, ''); return; }
    if (sheetOpen()) { closeSheet(true); if (reading) history.pushState({ reader: 1 }, ''); return; }
    if (reading) closeReader();
  });
}

/* --- 选中文字 --- */
function domToOff(node, offset) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) return 0;
  const p = el.closest('p[data-off]');
  if (!p) {
    if (el.closest('.ch-title')) return 0;
    if (node === content) {
      const c = content.childNodes[offset];
      return c && c.dataset && c.dataset.off ? +c.dataset.off : R.chapters[R.ch].text.length;
    }
    return 0;
  }
  const r = document.createRange(); r.setStart(p, 0); r.setEnd(node, offset);
  return +p.dataset.off + r.toString().length;
}

function checkSelection() {
  const bar = $('#selbar'), sel = getSelection();
  if (!reading || !sel || sel.isCollapsed || !sel.rangeCount || !content.contains(sel.anchorNode)) {
    bar.classList.add('hidden'); R.sel = null; return;
  }
  const r = sel.getRangeAt(0);
  const s = domToOff(r.startContainer, r.startOffset), e = domToOff(r.endContainer, r.endOffset);
  if (e <= s || !R.chapters[R.ch].text.slice(s, e).trim()) { bar.classList.add('hidden'); R.sel = null; return; }
  R.sel = { s, e };
  bar.classList.remove('hidden');
}

/* =========================================================
 * 书签
 * ========================================================= */
function snippet(ch, off, n = 40) { return R.chapters[ch].text.slice(off, off + n).replace(/\n/g, ' '); }
function bookmarkOnPage() {
  if (!R.meta) return null;
  return R.meta.bookmarks.find(b => b.ch === R.ch && pageOfOff(b.off) === R.page) || null;
}
function toggleBookmark() {
  const bm = bookmarkOnPage();
  if (bm) { R.meta.bookmarks = R.meta.bookmarks.filter(b => b !== bm); toast('已删除书签'); }
  else { R.meta.bookmarks.push({ id: uid(), ch: R.ch, off: R.off, text: snippet(R.ch, R.off), time: Date.now() }); toast('已添加书签'); }
  saveMeta(); updateStatus();
}

/* =========================================================
 * 底部面板
 * ========================================================= */
const sheetOpen = () => $('#sheet').classList.contains('open');
function openSheet(title, html, short = false) {
  hideMenu();
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.innerHTML = html; body.onclick = null; body.scrollTop = 0;
  $('#sheet').classList.toggle('short', short);
  $('#sheetMask').classList.remove('hidden');
  $('#sheet').classList.add('open');
  return body;
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheetMask').classList.add('hidden');
  if (document.activeElement) document.activeElement.blur();
}
const chTitle = i => R.chapters[i].title || `第 ${i + 1} 节`;

function showToc() {
  const body = openSheet(`目录（共 ${R.chapters.length} 章）`,
    R.chapters.map((c, i) => `<div class="item${i === R.ch ? ' cur' : ''}" data-i="${i}"><div class="item-main">${esc(chTitle(i))}</div></div>`).join(''));
  body.onclick = e => { const it = e.target.closest('[data-i]'); if (it) jumpTo(+it.dataset.i, 0); };
  const cur = body.querySelector('.cur');
  if (cur) body.scrollTop = cur.offsetTop - body.clientHeight / 2;
}

function showBookmarks() {
  const bms = [...R.meta.bookmarks].sort((a, b) => a.ch - b.ch || a.off - b.off);
  const body = openSheet(`书签（${bms.length}）`,
    `<button class="btn-block" data-act="add">${bookmarkOnPage() ? '当前页已有书签' : '＋ 给当前页加书签'}</button>` +
    (bms.length ? bms.map(b => `
      <div class="item" data-id="${b.id}">
        <div class="item-main">
          <div class="item-title">${esc(chTitle(b.ch))}</div>
          <div class="item-sub">${esc(b.text)}</div>
          <div class="item-meta">${fmtDate(b.time)}</div>
        </div>
        <button class="small-btn" data-del="${b.id}">删除</button>
      </div>`).join('') : '<p class="empty-tip">还没有书签<br>阅读时点屏幕中间，再点右上角的书签图标即可添加</p>'));
  body.onclick = e => {
    const del = e.target.closest('[data-del]');
    if (del) { R.meta.bookmarks = R.meta.bookmarks.filter(b => b.id !== del.dataset.del); saveMeta(); updateStatus(); return showBookmarks(); }
    if (e.target.closest('[data-act=add]')) { if (!bookmarkOnPage()) toggleBookmark(); return showBookmarks(); }
    const it = e.target.closest('[data-id]');
    if (it) { const b = R.meta.bookmarks.find(x => x.id === it.dataset.id); if (b) jumpTo(b.ch, b.off); }
  };
}

function showSearch() {
  const body = openSheet('全文搜索', `
    <form class="search-form"><input type="search" id="q" placeholder="输入关键词" enterkeyhint="search" autocomplete="off"><button>搜索</button></form>
    <div id="sres"></div>`);
  const q = $('#q');
  body.querySelector('form').onsubmit = e => { e.preventDefault(); q.blur(); doSearch(q.value.trim()); };
  if (R.lastSearch) { q.value = R.lastSearch.kw; renderSearch(); } else setTimeout(() => q.focus(), 300);
  body.onclick = e => {
    const it = e.target.closest('[data-ch]');
    if (it) jumpTo(+it.dataset.ch, +it.dataset.off);
  };
}
function doSearch(kw) {
  if (!kw) return;
  const MAX = 500, res = [], k = kw.toLowerCase();
  for (let i = 0; i < R.chapters.length && res.length < MAX; i++) {
    const t = R.chapters[i].text.toLowerCase();
    let idx = t.indexOf(k);
    while (idx !== -1 && res.length < MAX) { res.push({ ch: i, off: idx }); idx = t.indexOf(k, idx + k.length); }
  }
  R.lastSearch = { kw, res };
  renderSearch();
}
function renderSearch() {
  const { kw, res } = R.lastSearch;
  $('#sres').innerHTML = !res.length ? '<p class="empty-tip">没有找到</p>' :
    `<div class="count-tip">找到 ${res.length >= 500 ? '500+' : res.length} 处</div>` +
    res.map(r => {
      const t = R.chapters[r.ch].text;
      const before = t.slice(Math.max(0, r.off - 16), r.off).replace(/\n/g, ' ');
      const after = t.slice(r.off + kw.length, r.off + kw.length + 30).replace(/\n/g, ' ');
      return `<div class="item" data-ch="${r.ch}" data-off="${r.off}"><div class="item-main">
        <div class="item-meta">${esc(chTitle(r.ch))}</div>
        <div class="item-sub">${esc(before)}<b>${esc(t.substr(r.off, kw.length))}</b>${esc(after)}</div></div></div>`;
    }).join('');
}

/* =========================================================
 * 划线笔记
 * ========================================================= */
function addHighlight(s, e) {
  const text = R.chapters[R.ch].text.slice(s, e);
  if (!text.trim()) return null;
  const n = { id: uid(), ch: R.ch, chTitle: chTitle(R.ch), start: s, end: e, text, note: '', time: Date.now() };
  R.meta.notes.push(n);
  saveMeta(); refreshChapter(); toast('已高亮');
  return n;
}

async function editNote(id) {
  const n = R.meta.notes.find(x => x.id === id);
  if (!n) return;
  const r = await dialog({
    title: '笔记',
    html: `<blockquote>${esc(n.text)}</blockquote><textarea id="noteInput" placeholder="写下你的想法…（可以不写）">${esc(n.note)}</textarea>`,
    buttons: [{ text: '删除划线', cls: 'danger', key: 'del' }, { text: '取消', key: 'cancel' }, { text: '保存', cls: 'main', key: 'save' }],
    focus: '#noteInput'
  });
  if (r.key === 'save') { n.note = (r.value || '').trim(); toast('已保存'); }
  else if (r.key === 'del') { R.meta.notes = R.meta.notes.filter(x => x.id !== id); toast('已删除划线'); }
  else return;
  saveMeta();
  if (n.ch === R.ch) refreshChapter();
  if (sheetOpen() && $('#sheetTitle').textContent.startsWith('笔记')) showNotes();
}

function showNotes() {
  const ns = [...R.meta.notes].sort((a, b) => a.ch - b.ch || a.start - b.start);
  const body = openSheet(`笔记（${ns.length}）`,
    (ns.length ? `<div class="row-btns"><button data-act="share">导出为文件</button><button data-act="copy">复制全部</button></div>` +
      ns.map(n => `
      <div class="item" data-id="${n.id}">
        <div class="item-main">
          <div class="item-meta">${esc(n.chTitle || chTitle(n.ch))} · ${fmtDate(n.time)}</div>
          <blockquote>${esc(n.text)}</blockquote>
          ${n.note ? `<div class="note-text">${esc(n.note)}</div>` : ''}
        </div>
        <button class="small-btn" data-edit="${n.id}">编辑</button>
      </div>`).join('')
      : '<p class="empty-tip">还没有笔记<br>阅读时长按文字选中一段，<br>再点下方出现的「高亮」或「写笔记」</p>'));
  body.onclick = e => {
    const act = e.target.closest('[data-act]');
    if (act) { const txt = notesText([R.meta]); return act.dataset.act === 'copy' ? copyText(txt) : shareFile(txt, `《${R.meta.title}》笔记.txt`); }
    const ed = e.target.closest('[data-edit]');
    if (ed) return editNote(ed.dataset.edit);
    const it = e.target.closest('[data-id]');
    if (it) { const n = R.meta.notes.find(x => x.id === it.dataset.id); if (n) jumpTo(n.ch, n.start); }
  };
}

function notesText(metas) {
  const lines = ['小书房 · 读书笔记', `导出时间：${fmtDate(Date.now())}`, ''];
  for (const m of metas) {
    const ns = [...(m.notes || [])].sort((a, b) => a.ch - b.ch || a.start - b.start);
    if (!ns.length) continue;
    lines.push('════════════════', `《${m.title}》${m.author ? ' ' + m.author : ''}　共 ${ns.length} 条`, '════════════════', '');
    let last = null;
    for (const n of ns) {
      if (n.chTitle !== last) { lines.push(`【${n.chTitle}】`); last = n.chTitle; }
      lines.push(`「${n.text.replace(/\n/g, ' ')}」`);
      if (n.note) lines.push(`笔记：${n.note}`);
      lines.push(`（${fmtDate(n.time)}）`, '');
    }
  }
  return lines.join('\n');
}

async function exportAllNotes() {
  const all = (await DB.all('books')).filter(b => b.notes && b.notes.length);
  if (!all.length) return toast('还没有任何笔记');
  const count = all.reduce((s, b) => s + b.notes.length, 0);
  const r = await dialog({
    title: '导出全部笔记', html: `共 ${all.length} 本书、${count} 条笔记`,
    buttons: [{ text: '取消' }, { text: '复制', key: 'copy' }, { text: '导出文件', cls: 'main', key: 'share' }]
  });
  const txt = notesText(all);
  if (r.key === 'copy') copyText(txt);
  if (r.key === 'share') shareFile(txt, `小书房笔记-${new Date().toISOString().slice(0, 10)}.txt`);
}

async function shareFile(text, filename) {
  const file = new File([text], filename, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('已导出');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制，可以粘贴到微信、备忘录'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制');
  }
}

/* =========================================================
 * 朗读（使用手机自带的语音，不联网）
 * ========================================================= */
const TTS = { on: false, playing: false, ch: 0, pos: 0, cur: null, token: 0, timer: null, endAt: 0, chapterStop: false, wake: null, tick: null };
const ttsOK = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" style="fill:currentColor"><path d="M8 5l11 7-11 7z"/></svg>';

function zhVoices() {
  if (!ttsOK()) return [];
  return speechSynthesis.getVoices().filter(v => /^(zh|cmn|yue)/i.test(v.lang));
}
function pickVoice() {
  const vs = zhVoices();
  return vs.find(v => v.voiceURI === SET.ttsVoice) || vs.find(v => /zh[-_]CN/i.test(v.lang)) || vs[0] || null;
}

// 从 pos 开始取一句（最长约 120 字）
function nextSentence(text, pos) {
  while (pos < text.length && /[\s　]/.test(text[pos])) pos++;
  if (pos >= text.length) return null;
  const MAX = 120;
  let end = -1;
  for (let i = pos; i < Math.min(text.length, pos + MAX); i++) {
    const c = text[i];
    if (c === '\n') { end = i; break; }
    if (/[。！？!?；;…]/.test(c)) {
      end = i + 1;
      while (end < text.length && /[。！？!?…”’」』）)"'\s]/.test(text[end]) && text[end] !== '\n') end++;
      break;
    }
  }
  if (end === -1) {
    const limit = Math.min(text.length, pos + MAX);
    end = limit;
    for (let i = limit - 1; i > pos + 20; i--) if (/[，,、：:]/.test(text[i])) { end = i + 1; break; }
  }
  return { s: pos, e: Math.max(end, pos + 1) };
}

function ttsHighlight(seg) {
  if (!(window.CSS && CSS.highlights && window.Highlight)) return;
  if (!seg || R.ch !== TTS.ch) { CSS.highlights.delete('tts'); return; }
  try {
    const a = rangeAt(seg.s), b = rangeAt(Math.max(seg.s, seg.e - 1));
    const r = document.createRange();
    r.setStart(a.startContainer, a.startOffset); r.setEnd(b.endContainer, b.endOffset);
    CSS.highlights.set('tts', new Highlight(r));
  } catch (e) { CSS.highlights.delete('tts'); }
}

function ttsSpeakNext() {
  if (!TTS.on || !TTS.playing) return;
  let text = R.chapters[TTS.ch].text;
  let seg = nextSentence(text, TTS.pos);
  if (!seg) {   // 本章读完
    if (TTS.chapterStop) return ttsStop(false, '本章读完，已停止朗读');
    if (TTS.ch >= R.chapters.length - 1) return ttsStop(false, '全书读完了');
    TTS.ch++; TTS.pos = 0;
    text = R.chapters[TTS.ch].text;
    seg = nextSentence(text, 0);
    if (!seg) return ttsSpeakNext();
  }
  TTS.cur = seg;
  // 让屏幕跟着朗读走
  if (R.ch !== TTS.ch) openChapter(TTS.ch, seg.s);
  else { const p = pageOfOff(seg.s); if (p !== R.page) setPage(p, true); }
  ttsHighlight(seg);

  const u = new SpeechSynthesisUtterance(text.slice(seg.s, seg.e));
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'zh-CN';
  u.rate = SET.ttsRate;
  const tk = ++TTS.token;
  u.onend = () => { if (tk !== TTS.token) return; TTS.pos = seg.e; ttsSpeakNext(); };
  u.onerror = e => {
    if (tk !== TTS.token || e.error === 'interrupted' || e.error === 'canceled') return;
    TTS.pos = seg.e; setTimeout(ttsSpeakNext, 60);
  };
  speechSynthesis.speak(u);
}

function ttsStart() {
  if (!ttsOK()) return dialog({ title: '无法朗读', html: '这个浏览器不支持朗读功能。iPhone 请用 Safari，安卓请用 Chrome。', buttons: [{ text: '知道了' }] });
  closeSheet(); hideMenu();
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  TTS.on = true; TTS.playing = true; TTS.ch = R.ch; TTS.pos = R.off;
  ttsKeepAwake(); ttsUI();
  ttsSpeakNext();
}

function ttsPause() {
  if (!TTS.on) return;
  TTS.playing = false; TTS.token++;
  speechSynthesis.cancel();
  if (TTS.cur) TTS.pos = TTS.cur.s;   // 继续时从这一句重新读
  ttsUI();
}
function ttsResume() {
  if (!TTS.on) return;
  TTS.playing = true; ttsKeepAwake(); ttsUI();
  ttsSpeakNext();
}

function ttsStop(silent, msg) {
  if (!TTS.on) return;
  TTS.on = false; TTS.playing = false; TTS.token++; TTS.cur = null;
  if (ttsOK()) speechSynthesis.cancel();
  ttsClearTimer();
  if (window.CSS && CSS.highlights) CSS.highlights.delete('tts');
  if (TTS.wake) { TTS.wake.release().catch(() => {}); TTS.wake = null; }
  ttsUI();
  if (!silent) toast(msg || '已退出朗读');
}

// 用户自己翻页 / 跳转时，从新位置接着读
function ttsFollow() {
  if (!TTS.on) return;
  TTS.token++;
  speechSynthesis.cancel();
  TTS.ch = R.ch; TTS.pos = R.off; TTS.cur = null;
  if (TTS.playing) setTimeout(ttsSpeakNext, 80);
}

// 从后台回来：如果朗读被系统打断，接着读
function ttsWake() {
  if (!TTS.on) return;
  ttsKeepAwake();
  if (TTS.playing && !speechSynthesis.speaking && !speechSynthesis.pending) {
    TTS.token++;
    if (TTS.cur) TTS.pos = TTS.cur.s;
    ttsSpeakNext();
  }
}

async function ttsKeepAwake() {   // 朗读时屏幕不自动熄灭
  try { if ('wakeLock' in navigator && !TTS.wake) { TTS.wake = await navigator.wakeLock.request('screen'); TTS.wake.addEventListener('release', () => { TTS.wake = null; }); } }
  catch (e) {}
}

function ttsClearTimer() { clearTimeout(TTS.timer); clearInterval(TTS.tick); TTS.timer = null; TTS.endAt = 0; TTS.chapterStop = false; }
function ttsSetTimer(min) {
  ttsClearTimer();
  if (min === 'ch') { TTS.chapterStop = true; }
  else if (min > 0) {
    TTS.endAt = Date.now() + min * 60000;
    TTS.timer = setTimeout(() => ttsStop(false, '定时结束，已停止朗读'), min * 60000);
    TTS.tick = setInterval(ttsUI, 30000);
  }
  ttsUI();
}

function ttsUI() {
  const bar = $('#ttsbar');
  bar.classList.toggle('hidden', !TTS.on);
  if (!TTS.on) return;
  $('#ttsPlay').innerHTML = TTS.playing ? ICON_PAUSE : ICON_PLAY;
  let info = `朗读 ${SET.ttsRate.toFixed(1)}x`;
  if (TTS.endAt) info += ` · ${Math.max(1, Math.ceil((TTS.endAt - Date.now()) / 60000))}分钟后停`;
  else if (TTS.chapterStop) info += ' · 本章后停';
  $('#ttsInfo').textContent = info;
}

function showTts() {
  const vs = zhVoices();
  const timerVal = TTS.chapterStop ? 'ch' : TTS.endAt ? String(TTS.timerMin || 0) : '0';
  const body = openSheet('朗读', `
    <button class="tts-main" data-act="main">${!TTS.on ? '▶ 从当前页开始朗读' : TTS.playing ? '暂停朗读' : '▶ 继续朗读'}</button>
    ${TTS.on ? '<button class="btn-block" data-act="stop">退出朗读</button>' : ''}
    <div class="set-row"><span>语速</span><div class="stepper"><button data-act="r-">慢</button><output id="rv"></output><button data-act="r+">快</button></div></div>
    <div class="set-row"><span>声音</span></div>
    <div class="voice-list">${vs.length
      ? `<select id="voiceSel">${vs.map(v => `<option value="${esc(v.voiceURI)}"${pickVoice() === v ? ' selected' : ''}>${esc(v.name)}（${esc(v.lang)}）</option>`).join('')}</select>`
      : '<div class="tts-tip">使用系统默认中文语音</div>'}</div>
    <div class="set-row"><span>定时关闭</span><div class="seg wrap">
      ${[['0', '不定时'], ['15', '15分钟'], ['30', '30分钟'], ['60', '60分钟'], ['ch', '本章结束']].map(([k, t]) =>
        `<button data-timer="${k}" class="${k === timerVal ? 'on' : ''}">${t}</button>`).join('')}
    </div></div>
    <p class="tts-tip">朗读时点屏幕左右两边可翻页，会从新的一页接着读。<br>朗读时屏幕会保持常亮；锁屏或切到别的 App 后，手机系统通常会暂停朗读，回来后会自动接着读。</p>`, true);
  $('#rv').textContent = SET.ttsRate.toFixed(1) + 'x';
  const sel = $('#voiceSel');
  if (sel) sel.onchange = () => { SET.ttsVoice = sel.value; saveSettings(); ttsRestartSentence(); };
  body.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'main') { if (!TTS.on) ttsStart(); else if (TTS.playing) { ttsPause(); showTts(); } else { closeSheet(); ttsResume(); } return; }
    if (a === 'stop') { closeSheet(); return ttsStop(); }
    if (a === 'r-' || a === 'r+') {
      SET.ttsRate = Math.round(Math.min(2.5, Math.max(0.5, SET.ttsRate + (a === 'r+' ? 0.1 : -0.1))) * 10) / 10;
      saveSettings(); $('#rv').textContent = SET.ttsRate.toFixed(1) + 'x'; ttsUI(); ttsRestartSentence();
    }
    if (b.dataset.timer) {
      const k = b.dataset.timer;
      TTS.timerMin = k === 'ch' ? 0 : +k;
      ttsSetTimer(k === 'ch' ? 'ch' : +k);
      body.querySelectorAll('[data-timer]').forEach(x => x.classList.toggle('on', x === b));
      if (k !== '0') toast(k === 'ch' ? '读完本章后停止' : `${k} 分钟后停止朗读`);
    }
  };
}

// 改了语速/声音：当前这句用新设置重读
function ttsRestartSentence() {
  if (!TTS.on || !TTS.playing) return;
  TTS.token++; speechSynthesis.cancel();
  if (TTS.cur) TTS.pos = TTS.cur.s;
  setTimeout(ttsSpeakNext, 80);
}

function bindTts() {
  $('#ttsPlay').onclick = () => TTS.playing ? ttsPause() : ttsResume();
  $('#ttsInfo').onclick = showTts;
  $('#ttsStop').onclick = () => ttsStop();
  if (ttsOK()) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => {});
  }
}

/* =========================================================
 * 设置
 * ========================================================= */
function showSettings() {
  const body = openSheet('阅读设置', `
    <div class="set-row"><span>字号</span><div class="stepper"><button data-act="fs-">A−</button><output id="fsv"></output><button data-act="fs+">A＋</button></div></div>
    <div class="set-row"><span>行距</span><div class="stepper"><button data-act="lh-">−</button><output id="lhv"></output><button data-act="lh+">＋</button></div></div>
    <div class="set-row"><span>背景</span><div class="seg">
      <button class="t-day" data-theme="day">白天</button><button class="t-sepia" data-theme="sepia">护眼</button><button class="t-night" data-theme="night">夜间</button></div></div>
    <div class="set-row"><span>字体</span><div class="seg">
      <button data-font="serif" style="font-family:var(--serif)">宋体</button><button data-font="sans" style="font-family:var(--sans)">黑体</button></div></div>`, true);
  const sync = () => {
    $('#fsv').textContent = SET.fontSize;
    $('#lhv').textContent = SET.lineHeight.toFixed(1);
    body.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('on', b.dataset.theme === SET.theme));
    body.querySelectorAll('[data-font]').forEach(b => b.classList.toggle('on', b.dataset.font === SET.font));
  };
  sync();
  body.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'fs-') SET.fontSize = Math.max(13, SET.fontSize - 1);
    if (a === 'fs+') SET.fontSize = Math.min(34, SET.fontSize + 1);
    if (a === 'lh-') SET.lineHeight = Math.max(1.2, Math.round((SET.lineHeight - 0.1) * 10) / 10);
    if (a === 'lh+') SET.lineHeight = Math.min(2.8, Math.round((SET.lineHeight + 0.1) * 10) / 10);
    if (b.dataset.theme) SET.theme = b.dataset.theme;
    if (b.dataset.font) SET.font = b.dataset.font;
    saveSettings(); applySettings(); sync(); relayout();
  };
}

/* =========================================================
 * 通用：对话框 / 提示 / 加载
 * ========================================================= */
function dialog({ title, html = '', buttons, focus }) {
  return new Promise(res => {
    const modal = $('#modal'), mask = $('#modalMask');
    modal.innerHTML = `<div class="m-title">${esc(title)}</div>${html ? `<div class="m-body">${html}</div>` : ''}
      <div class="m-btns">${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.text)}</button>`).join('')}</div>`;
    mask.classList.remove('hidden');
    if (focus) setTimeout(() => modal.querySelector(focus)?.focus(), 250);
    modal.querySelector('.m-btns').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const i = +b.dataset.i;
      const value = modal.querySelector('textarea')?.value;
      mask.classList.add('hidden'); modal.innerHTML = '';
      res({ i, key: buttons[i].key, value });
    };
  });
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}
function showLoading(text) { $('#loadingText').textContent = text; $('#loading').classList.remove('hidden'); }
function hideLoading() { $('#loading').classList.add('hidden'); }

/* =========================================================
 * 启动
 * ========================================================= */
(async function init() {
  applySettings();
  bindShelf(); bindReader(); bindTts();
  $('#sheetClose').onclick = () => closeSheet();
  $('#sheetMask').onclick = () => closeSheet();
  try { await DB.open(); }
  catch (e) { return dialog({ title: '无法使用本地存储', html: '请不要使用无痕/隐私模式打开。', buttons: [{ text: '知道了' }] }); }
  renderShelf();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('离线缓存注册失败', e));
  }
})();
