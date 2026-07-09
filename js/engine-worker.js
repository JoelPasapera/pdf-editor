/* ============================================================
   GUILLOTINA · motor de edición (worker) · v3
   ------------------------------------------------------------
   Envuelve MuPDF (WebAssembly) y expone operaciones de EDICIÓN
   REAL del PDF: el contenido original se elimina del archivo
   (redacción sin cajas negras) y el nuevo se inserta como
   contenido nativo. Journal del motor = deshacer/rehacer.

   El archivo es un módulo doble:
   - En el navegador corre como Web Worker (protocolo postMessage).
   - En Node se importa `api` directamente para las pruebas.

   Espacios de coordenadas:
   - La interfaz trabaja en espacio "fitz": origen arriba-izquierda,
     y hacia abajo, rotación de página ya aplicada.
   - El contenido PDF se escribe en espacio PDF (y hacia arriba);
     la conversión usa la inversa de page.getTransform().
   ============================================================ */

let mupdf = null;
async function ensureEngine() {
  if (!mupdf) mupdf = await import(new URL('../vendor/mupdf/mupdf.js', import.meta.url).href);
  return mupdf;
}

/* ---------- estado ---------- */
const docs = new Map(); // key → {doc, resSeq}

function getDoc(key) {
  const d = docs.get(key);
  if (!d) throw new Error('documento no abierto en el motor: ' + key);
  return d;
}
function loadPage(rec, idx) {
  return rec.doc.loadPage(idx); // barato; siempre fresco tras cada operación
}

/* ---------- utilidades de geometría ---------- */
const invAffine = (m) => {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const ra = d / det, rb = -b / det, rc = -c / det, rd = a / det;
  return [ra, rb, rc, rd, -(e * ra + f * rc), -(e * rb + f * rd)];
};
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* ---------- utilidades PDF ---------- */
function escWinAnsi(s) {
  let out = '', dropped = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c < 256) out += '\\' + c.toString(8).padStart(3, '0');
    else { out += '?'; dropped++; }
  }
  return { out, dropped };
}

function appendContent(rec, page, ops) {
  const pageObj = page.getObject();
  const cont = pageObj.get('Contents');
  let old = '';
  if (cont && !cont.isNull()) {
    if (cont.isArray()) {
      for (let i = 0; i < cont.length; i++) old += cont.get(i).readStream().asString() + '\n';
    } else {
      old = cont.readStream().asString() + '\n';
    }
  }
  pageObj.put('Contents', rec.doc.addStream(old + ops, null));
}

function ensureRes(rec, page, group) {
  const pageObj = page.getObject();
  let res = pageObj.get('Resources');
  if (!res || res.isNull()) { res = rec.doc.newDictionary(); pageObj.put('Resources', res); }
  let g = res.get(group);
  if (!g || g.isNull()) { g = rec.doc.newDictionary(); res.put(group, g); }
  return g;
}

function freshName(rec, dict, prefix) {
  let name;
  do { name = prefix + (++rec.resSeq); } while (dict.get(name) && !dict.get(name).isNull());
  return name;
}

function redactRect(page, rect, imageMethod, textMethod) {
  const annot = page.createAnnotation('Redact');
  annot.setRect([rect.x0, rect.y0, rect.x1, rect.y1]);
  page.applyRedactions(false, imageMethod, mupdf.PDFPage.REDACT_LINE_ART_NONE, textMethod);
}

function decodeColor(raw) {
  if (Array.isArray(raw)) {
    if (raw.length >= 3) return [raw[0], raw[1], raw[2]].map((v) => Math.min(1, Math.max(0, v)));
    if (raw.length === 1) return [raw[0], raw[0], raw[0]];
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = raw >>> 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return [0, 0, 0];
}

function fitzToPdfOps(page) {
  return invAffine(page.getTransform());
}

/* Inserta texto: (x, baselineY) en espacio fitz. */
function insertTextOps(rec, page, x, baselineY, text, size, color) {
  const { out, dropped } = escWinAnsi(text);
  const inv = fitzToPdfOps(page);
  const [px, py] = applyM(inv, x, baselineY);
  const fontRef = rec.doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  const fonts = ensureRes(rec, page, 'Font');
  const fname = freshName(rec, fonts, 'GLF');
  fonts.put(fname, fontRef);
  const [r, g, b] = color;
  appendContent(rec, page,
    `q BT /${fname} ${size.toFixed(2)} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ` +
    `1 0 0 1 ${px.toFixed(2)} ${py.toFixed(2)} Tm (${out}) Tj ET Q`);
  return dropped;
}

/* Inserta una imagen ocupando rect (espacio fitz). */
function insertImageOps(rec, page, imgRef, rect) {
  const inv = fitzToPdfOps(page);
  const [ax, ay] = applyM(inv, rect.x0, rect.y1); // esquina inferior-izquierda en PDF
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const xob = ensureRes(rec, page, 'XObject');
  const name = freshName(rec, xob, 'GLI');
  xob.put(name, imgRef);
  appendContent(rec, page,
    `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${ax.toFixed(2)} ${ay.toFixed(2)} cm /${name} Do Q`);
}

function imageBlocksOf(page) {
  const found = [];
  page.toStructuredText('preserve-images').walk({
    onImageBlock(bbox, transform, image) {
      const [x0, y0, x1, y1] = bbox;
      found.push({ x0, y0, x1, y1, image });
    },
  });
  return found;
}

function findImageAt(page, rect, tol = 3) {
  const blocks = imageBlocksOf(page);
  for (const b of blocks) {
    if (Math.abs(b.x0 - rect.x0) <= tol && Math.abs(b.y0 - rect.y0) <= tol &&
        Math.abs(b.x1 - rect.x1) <= tol && Math.abs(b.y1 - rect.y1) <= tol) return b;
  }
  return null;
}

/* ---------- API ---------- */
export const api = {

  async open({ key, bytes }) {
    await ensureEngine();
    api.close({ key });
    const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
    doc.enableJournal();
    docs.set(key, { doc, resSeq: 0 });
    return { pages: doc.countPages() };
  },

  close({ key }) {
    const d = docs.get(key);
    if (d) { try { d.doc.destroy(); } catch { /* ya liberado */ } docs.delete(key); }
    return {};
  },

  closeAll() {
    for (const key of [...docs.keys()]) api.close({ key });
    return {};
  },

  async pageInfo({ key, idx }) {
    const page = loadPage(getDoc(key), idx);
    const [x0, y0, x1, y1] = page.getBounds();
    return { w: x1 - x0, h: y1 - y0 };
  },

  /* Render a RGBA para putImageData (fondo blanco horneado). */
  async render({ key, idx, scale }) {
    const page = loadPage(getDoc(key), idx);
    const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, false);
    const src = pix.getPixels();
    const w = pix.getWidth(), h = pix.getHeight();
    const stride = pix.getStride(), n = pix.getNumberOfComponents();
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      let si = y * stride, di = y * w * 4;
      for (let x = 0; x < w; x++, si += n, di += 4) {
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = 255;
      }
    }
    return { w, h, buf: out.buffer, _transfer: [out.buffer] };
  },

  /* Líneas de texto con métrica para el editor. */
  async textLines({ key, idx }) {
    const page = loadPage(getDoc(key), idx);
    const lines = [];
    let cur = null;
    page.toStructuredText().walk({
      beginLine(bbox) {
        const [x0, y0, x1, y1] = bbox;
        cur = { x0, y0, x1, y1, text: '', size: 0, baseline: 0, color: [0, 0, 0], first: true };
      },
      onChar(c, origin, font, size, quad, color) {
        if (!cur) return;
        cur.text += c;
        if (cur.first) {
          cur.first = false;
          cur.size = size || 12;
          cur.baseline = Array.isArray(origin) ? origin[1] : (origin?.y ?? 0);
          cur.color = decodeColor(color);
        }
      },
      endLine() {
        if (cur && cur.text.trim()) {
          delete cur.first;
          lines.push(cur);
        }
        cur = null;
      },
    });
    return { lines };
  },

  async images({ key, idx }) {
    const page = loadPage(getDoc(key), idx);
    return { images: imageBlocksOf(page).map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })) };
  },

  /* --- operaciones de edición (cada una = 1 paso del journal) --- */

  async opReplaceText({ key, idx, rect, text, size, color, baseline }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('reemplazar texto');
    let dropped = 0;
    try {
      const page = loadPage(rec, idx);
      redactRect(page, { x0: rect.x0 - 0.5, y0: rect.y0 - 0.5, x1: rect.x1 + 0.5, y1: rect.y1 + 0.5 },
        mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      if (text && text.length) {
        dropped = insertTextOps(rec, page, rect.x0,
          baseline ?? (rect.y1 - (rect.y1 - rect.y0) * 0.22), text, size, color);
      }
    } finally { rec.doc.endOperation(); }
    return { dropped };
  },

  async opAddText({ key, idx, x, baseline, text, size, color }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('añadir texto');
    let dropped = 0;
    try {
      dropped = insertTextOps(rec, loadPage(rec, idx), x, baseline, text, size, color);
    } finally { rec.doc.endOperation(); }
    return { dropped };
  },

  async opEraseArea({ key, idx, rect, mode }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('borrar zona');
    try {
      const page = loadPage(rec, idx);
      const img = (mode === 'text') ? mupdf.PDFPage.REDACT_IMAGE_NONE : mupdf.PDFPage.REDACT_IMAGE_REMOVE;
      const txt = (mode === 'image') ? mupdf.PDFPage.REDACT_TEXT_NONE : mupdf.PDFPage.REDACT_TEXT_REMOVE;
      redactRect(page, rect, img, txt);
    } finally { rec.doc.endOperation(); }
    return {};
  },

  async opMoveImage({ key, idx, rect, newRect }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('mover imagen');
    try {
      const page = loadPage(rec, idx);
      const blk = findImageAt(page, rect);
      if (!blk) throw new Error('la imagen ya no está en esa posición');
      const png = blk.image.toPixmap().asPNG();
      redactRect(page, { x0: blk.x0 - 0.5, y0: blk.y0 - 0.5, x1: blk.x1 + 0.5, y1: blk.y1 + 0.5 },
        mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_TEXT_NONE);
      const page2 = loadPage(rec, idx);
      insertImageOps(rec, page2, rec.doc.addImage(new mupdf.Image(png)), newRect);
    } finally { rec.doc.endOperation(); }
    return {};
  },

  async opDeleteImage({ key, idx, rect }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('eliminar imagen');
    try {
      const page = loadPage(rec, idx);
      const blk = findImageAt(page, rect) || rect;
      redactRect(page, { x0: blk.x0 - 0.5, y0: blk.y0 - 0.5, x1: blk.x1 + 0.5, y1: blk.y1 + 0.5 },
        mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_TEXT_NONE);
    } finally { rec.doc.endOperation(); }
    return {};
  },

  async opAddImage({ key, idx, png, rect }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('añadir imagen');
    try {
      const page = loadPage(rec, idx);
      insertImageOps(rec, page, rec.doc.addImage(new mupdf.Image(png)), rect);
    } finally { rec.doc.endOperation(); }
    return {};
  },

  /* --- journal --- */
  undoState({ key }) {
    const rec = getDoc(key);
    return { canUndo: rec.doc.canUndo(), canRedo: rec.doc.canRedo() };
  },
  undo({ key }) { const rec = getDoc(key); if (rec.doc.canUndo()) rec.doc.undo(); return api.undoState({ key }); },
  redo({ key }) { const rec = getDoc(key); if (rec.doc.canRedo()) rec.doc.redo(); return api.undoState({ key }); },

  async save({ key }) {
    const rec = getDoc(key);
    const buf = rec.doc.saveToBuffer('').asUint8Array();
    const bytes = new Uint8Array(buf); // copia propia, fuera de la memoria WASM
    return { bytes: bytes.buffer, _transfer: [bytes.buffer] };
  },
};

/* ---------- envoltorio Web Worker ---------- */
const isWorker = typeof self !== 'undefined'
  && typeof self.postMessage === 'function'
  && typeof self.document === 'undefined';

if (isWorker) {
  self.onmessage = async (ev) => {
    const { id, cmd, args } = ev.data;
    try {
      const fn = api[cmd];
      if (!fn) throw new Error('comando desconocido: ' + cmd);
      const res = (await fn(args || {})) || {};
      const transfer = res._transfer || [];
      delete res._transfer;
      self.postMessage({ id, ok: true, res }, transfer);
    } catch (e) {
      self.postMessage({ id, ok: false, err: e?.message || String(e) });
    }
  };
  self.postMessage({ id: 0, ok: true, res: { hello: true } });
}
