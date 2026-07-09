/* ============================================================
   GUILLOTINA · motor de edición (worker) · v3.1
   ------------------------------------------------------------
   Edición REAL del PDF con MuPDF WebAssembly, optimizada:

   - DisplayList por página en caché → el contenido se interpreta
     UNA vez por estado y sirve tanto al render como a la
     extracción de texto/imágenes (una sola pasada, no tres).
   - Render PARCIAL recortado (DrawDevice + Pixmap con bbox):
     el coste es proporcional a la zona visible o a la zona
     tocada por la operación, no a la página entera.
   - Mover/redimensionar imágenes REUTILIZA el objeto de imagen
     comprimido del PDF (sin descodificar píxeles ni recodificar
     PNG): coste casi nulo aunque la imagen sea enorme.
   - Los streams de contenido se encadenan por REFERENCIA en el
     array /Contents (sin reconstruir el contenido antiguo), con
     aislamiento q/Q del estado gráfico original.
   - Cada operación devuelve el estado del journal para ahorrar
     viajes de ida y vuelta.

   Módulo doble: Web Worker en el navegador, `api` importable en
   Node para las pruebas. Coordenadas de la interfaz en espacio
   fitz; el contenido se escribe en espacio PDF vía la inversa de
   page.getTransform().
   ============================================================ */

let mupdf = null;
async function ensureEngine() {
  if (!mupdf) mupdf = await import(new URL('../vendor/mupdf/mupdf.js', import.meta.url).href);
  return mupdf;
}

/* ---------- estado ---------- */
const docs = new Map(); // key → {doc, resSeq, pages:Map<idx,{page,dl}>, wrapped:Set<idx>}

function getDoc(key) {
  const d = docs.get(key);
  if (!d) throw new Error('documento no abierto en el motor: ' + key);
  return d;
}

function pageOf(rec, idx) {
  let e = rec.pages.get(idx);
  if (!e) {
    const page = rec.doc.loadPage(idx);
    e = { page, dl: page.toDisplayList() };
    rec.pages.set(idx, e);
  }
  return e;
}

/* El contenido cambió: la próxima consulta reconstruye página y lista. */
function invalidate(rec) { rec.pages.clear(); }

/* ---------- geometría ---------- */
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

/* Encadena un stream nuevo de operadores por referencia, sin copiar
   el contenido antiguo. El original queda aislado entre q/Q. */
function appendContent(rec, idx, page, ops) {
  const doc = rec.doc;
  const pageObj = page.getObject();
  const newRef = doc.addStream(ops, null);
  const cont = pageObj.get('Contents');

  if (!cont || cont.isNull()) {
    pageObj.put('Contents', newRef);
    rec.wrapped.add(idx);
    return;
  }
  if (cont.isArray() && rec.wrapped.has(idx)) {
    cont.push(newRef);
    return;
  }
  const arr = doc.newArray();
  arr.push(doc.addStream('q\n', null));
  if (cont.isArray()) {
    for (let i = 0; i < cont.length; i++) arr.push(cont.get(i));
  } else if (cont.isIndirect()) {
    arr.push(cont);
  } else {
    // caso raro: stream directo → se materializa una única vez
    arr.push(doc.addStream(cont.readStream().asString(), null));
  }
  arr.push(doc.addStream('\nQ\n', null));
  arr.push(newRef);
  pageObj.put('Contents', arr);
  rec.wrapped.add(idx);
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

function insertTextOps(rec, idx, page, x, baselineY, text, size, color) {
  const { out, dropped } = escWinAnsi(text);
  const inv = invAffine(page.getTransform());
  const [px, py] = applyM(inv, x, baselineY);
  const fontRef = rec.doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  const fonts = ensureRes(rec, page, 'Font');
  const fname = freshName(rec, fonts, 'GLF');
  fonts.put(fname, fontRef);
  const [r, g, b] = color;
  appendContent(rec, idx, page,
    `q BT /${fname} ${size.toFixed(2)} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ` +
    `1 0 0 1 ${px.toFixed(2)} ${py.toFixed(2)} Tm (${out}) Tj ET Q`);
  return dropped;
}

function insertImageOps(rec, idx, page, imgRef, rect) {
  const inv = invAffine(page.getTransform());
  const [ax, ay] = applyM(inv, rect.x0, rect.y1);
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const xob = ensureRes(rec, page, 'XObject');
  const name = freshName(rec, xob, 'GLI');
  xob.put(name, imgRef);
  appendContent(rec, idx, page,
    `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${ax.toFixed(2)} ${ay.toFixed(2)} cm /${name} Do Q`);
}

function contentOf(rec, idx) {
  const { dl } = pageOf(rec, idx);
  const lines = [];
  const images = [];
  let cur = null;
  dl.toStructuredText('preserve-images').walk({
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
      if (cur && cur.text.trim()) { delete cur.first; lines.push(cur); }
      cur = null;
    },
    onImageBlock(bbox, transform, image) {
      const [x0, y0, x1, y1] = bbox;
      images.push({ x0, y0, x1, y1, _img: image });
    },
  });
  return { lines, images };
}

function undoInfo(rec) {
  return { canUndo: rec.doc.canUndo(), canRedo: rec.doc.canRedo() };
}

const stripImg = (images) => images.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));

function findImageAt(rec, idx, rect, tol = 3) {
  const { images } = contentOf(rec, idx);
  for (const b of images) {
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
    docs.set(key, { doc, resSeq: 0, pages: new Map(), wrapped: new Set() });
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
    const { page } = pageOf(getDoc(key), idx);
    const [x0, y0, x1, y1] = page.getBounds();
    return { w: x1 - x0, h: y1 - y0 };
  },

  /* Render parcial: rect en píxeles de dispositivo (enteros), a la
     escala dada. Devuelve RGBA listo para putImageData. */
  async renderRect({ key, idx, dx0, dy0, dx1, dy1, scale }) {
    const rec = getDoc(key);
    const { dl } = pageOf(rec, idx);
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [dx0, dy0, dx1, dy1], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice([scale, 0, 0, scale, 0, 0], pix);
    dl.run(dev, [1, 0, 0, 1, 0, 0]);
    dev.close();
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
    return { x: dx0, y: dy0, w, h, buf: out.buffer, _transfer: [out.buffer] };
  },

  /* Texto + imágenes + journal en UNA pasada y UN viaje. */
  async pageContent({ key, idx }) {
    const rec = getDoc(key);
    const { lines, images } = contentOf(rec, idx);
    return { lines, images: stripImg(images), undo: undoInfo(rec) };
  },

  /* --- operaciones (cada una = 1 paso del journal) --- */

  async opReplaceText({ key, idx, rect, text, size, color, baseline }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('reemplazar texto');
    let dropped = 0;
    try {
      const page = rec.doc.loadPage(idx);
      redactRect(page, { x0: rect.x0 - 0.5, y0: rect.y0 - 0.5, x1: rect.x1 + 0.5, y1: rect.y1 + 0.5 },
        mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      if (text && text.length) {
        dropped = insertTextOps(rec, idx, page, rect.x0,
          baseline ?? (rect.y1 - (rect.y1 - rect.y0) * 0.22), text, size, color);
      }
    } finally { rec.doc.endOperation(); invalidate(rec); }
    return { dropped, undo: undoInfo(rec) };
  },

  async opAddText({ key, idx, x, baseline, text, size, color }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('añadir texto');
    let dropped = 0;
    try {
      dropped = insertTextOps(rec, idx, rec.doc.loadPage(idx), x, baseline, text, size, color);
    } finally { rec.doc.endOperation(); invalidate(rec); }
    return { dropped, undo: undoInfo(rec) };
  },

  async opEraseArea({ key, idx, rect, mode }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('borrar zona');
    try {
      const img = (mode === 'text') ? mupdf.PDFPage.REDACT_IMAGE_NONE : mupdf.PDFPage.REDACT_IMAGE_REMOVE;
      const txt = (mode === 'image') ? mupdf.PDFPage.REDACT_TEXT_NONE : mupdf.PDFPage.REDACT_TEXT_REMOVE;
      redactRect(rec.doc.loadPage(idx), rect, img, txt);
    } finally { rec.doc.endOperation(); invalidate(rec); }
    return { undo: undoInfo(rec) };
  },

  /* Mover/redimensionar: REUTILIZA el objeto comprimido de la imagen
     (sin descodificar píxeles). Si el motor no puede, cae al camino
     PNG clásico. */
  async opMoveImage({ key, idx, rect, newRect }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('mover imagen');
    try {
      const blk = findImageAt(rec, idx, rect);
      if (!blk) throw new Error('la imagen ya no está en esa posición');
      let imgRef;
      try {
        imgRef = rec.doc.addImage(blk._img);
      } catch {
        imgRef = rec.doc.addImage(new mupdf.Image(blk._img.toPixmap().asPNG()));
      }
      const page = rec.doc.loadPage(idx);
      redactRect(page, { x0: blk.x0 - 0.5, y0: blk.y0 - 0.5, x1: blk.x1 + 0.5, y1: blk.y1 + 0.5 },
        mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_TEXT_NONE);
      insertImageOps(rec, idx, rec.doc.loadPage(idx), imgRef, newRect);
    } finally { rec.doc.endOperation(); invalidate(rec); }
    return { undo: undoInfo(rec) };
  },

  async opDeleteImage({ key, idx, rect }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('eliminar imagen');
    try {
      const blk = findImageAt(rec, idx, rect) || rect;
      redactRect(rec.doc.loadPage(idx),
        { x0: blk.x0 - 0.5, y0: blk.y0 - 0.5, x1: blk.x1 + 0.5, y1: blk.y1 + 0.5 },
        mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_TEXT_NONE);
    } finally { rec.doc.endOperation(); invalidate(rec); }
    return { undo: undoInfo(rec) };
  },

  async opAddImage({ key, idx, png, rect }) {
    const rec = getDoc(key);
    rec.doc.beginOperation('añadir imagen');
    try {
      insertImageOps(rec, idx, rec.doc.loadPage(idx), rec.doc.addImage(new mupdf.Image(png)), rect);
    } finally { rec.doc.endOperation(); invalidate(rec); }
    return { undo: undoInfo(rec) };
  },

  /* --- journal --- */
  undoState({ key }) { return { undo: undoInfo(getDoc(key)) }; },
  undo({ key }) {
    const rec = getDoc(key);
    if (rec.doc.canUndo()) { rec.doc.undo(); invalidate(rec); rec.wrapped.clear(); }
    return { undo: undoInfo(rec) };
  },
  redo({ key }) {
    const rec = getDoc(key);
    if (rec.doc.canRedo()) { rec.doc.redo(); invalidate(rec); rec.wrapped.clear(); }
    return { undo: undoInfo(rec) };
  },

  async save({ key }) {
    const rec = getDoc(key);
    const buf = rec.doc.saveToBuffer('').asUint8Array();
    const bytes = new Uint8Array(buf);
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
