(() => {
  'use strict';

  // Character ramps, ordered from sparse (no ink) to dense (most ink).
  const RAMPS = {
    standard: ' .:-=+*#%@',
    detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    simple: ' .oO@',
    blocks: ' ░▒▓█',
    binary: ' #',
  };

  // Braille cells are 2 dots wide × 4 dots tall; each dot is one bit.
  const BRAILLE_BITS = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
  ];
  const BRAILLE_BLANK = '⠀';

  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  const ART_COLORS = {
    dark: { bg: '#0c0d0f', fg: '#e9e9e6' },
    light: { bg: '#ffffff', fg: '#15171a' },
  };

  const DEFAULTS = {
    cols: 100,
    aspect: 0.5,
    charset: 'standard',
    custom: ' .:-=+*#%@',
    brightness: 0,
    contrast: 0,
    dither: 'none',
    autoLevels: true,
    invert: false,
    bg: 'dark',
    color: false,
    fit: true,
    fontSize: 10,
  };

  // Settings that only affect how the preview is displayed, not the conversion.
  const VIEW_KEYS = new Set(['fit', 'fontSize']);
  const STORE_KEY = 'ascii-converter:settings:v1';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    file: $('#file'),
    drop: $('#drop'),
    dropText: $('#drop-text'),
    thumb: $('#thumb'),
    pasteBtn: $('#paste-btn'),
    sampleBtn: $('#sample-btn'),
    emptySampleBtn: $('#empty-sample-btn'),
    resetBtn: $('#reset-btn'),
    customRow: $('#custom-row'),
    rampPreview: $('#ramp-preview'),
    stage: $('#stage'),
    empty: $('#empty'),
    art: $('#art'),
    stats: $('#stats'),
    toast: $('#toast'),
    copyBtn: $('#copy-btn'),
    copyMdBtn: $('#copy-md-btn'),
    txtBtn: $('#txt-btn'),
    pngBtn: $('#png-btn'),
    htmlBtn: $('#html-btn'),
  };
  const controls = [...document.querySelectorAll('[data-key]')];

  let settings = loadSettings();
  let source = null; // { el, w, h, name, thumbUrl }
  let result = null; // { chars, lines, colors, cols, rows }
  let frame = 0;
  let needsConvert = false;

  const work = document.createElement('canvas');
  const workCtx = work.getContext('2d', { willReadFrequently: true });
  const stepA = document.createElement('canvas');
  const stepB = document.createElement('canvas');
  const measureCtx = document.createElement('canvas').getContext('2d');
  const FONT = getComputedStyle(els.art).fontFamily;

  // ---------- Settings ----------

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && typeof saved === 'object') return { ...DEFAULTS, ...saved };
    } catch { /* storage unavailable */ }
    return { ...DEFAULTS };
  }

  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }

  function readControl(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.type === 'number') return Number(el.value);
    return el.value;
  }

  function syncControls() {
    for (const el of controls) {
      const v = settings[el.dataset.key];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = el.value === v;
      else if (el !== document.activeElement || el.type !== 'text') el.value = v;
    }
    for (const out of document.querySelectorAll('[data-for]')) {
      const key = out.dataset.for;
      const v = settings[key];
      out.textContent = key === 'aspect' ? v.toFixed(2) : (v > 0 ? '+' : '') + v;
    }
    els.customRow.hidden = settings.charset !== 'custom';
    $('#fontSize').disabled = settings.fit;
    els.rampPreview.textContent = settings.charset === 'braille'
      ? '⠁⠃⠇⡇⣇⣧⣷⣿ 2×4 dots per character'
      : getRamp().join('');
    const colors = ART_COLORS[settings.bg];
    els.stage.style.setProperty('--art-bg', colors.bg);
    els.stage.style.setProperty('--art-fg', colors.fg);
  }

  function getRamp() {
    const raw = settings.charset === 'custom' ? settings.custom : RAMPS[settings.charset] || RAMPS.standard;
    const ramp = Array.from(raw || '');
    if (ramp.length === 0) return Array.from(RAMPS.standard);
    if (ramp.length === 1) return [' ', ramp[0]];
    return ramp;
  }

  for (const el of controls) {
    const evt = el.type === 'number' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (el.type === 'radio' && !el.checked) return;
      const key = el.dataset.key;
      let v = readControl(el);
      if (el.type === 'number') {
        if (!Number.isFinite(v)) { syncControls(); return; }
        v = Math.round(clamp(v, Number(el.min), Number(el.max)));
      }
      settings[key] = v;
      // A hard threshold loses nearly all midtones in braille, so start it off dithered.
      if (key === 'charset' && v === 'braille' && settings.dither === 'none') settings.dither = 'floyd';
      saveSettings();
      syncControls();
      schedule(!VIEW_KEYS.has(key));
    });
  }

  els.resetBtn.addEventListener('click', () => {
    settings = { ...DEFAULTS };
    saveSettings();
    syncControls();
    schedule(true);
    toast('Settings reset');
  });

  // ---------- Loading images ----------

  function loadFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) {
      toast("That file isn't an image.");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // SVGs without intrinsic dimensions report 0×0.
      const w = img.naturalWidth || 512;
      const h = img.naturalHeight || 512;
      setSource({ el: img, w, h, name: baseName(file.name), thumbUrl: url, revoke: true });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast("Couldn't read that image. Try a PNG, JPEG, GIF or WebP.");
    };
    img.src = url;
  }

  function loadUrl(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const name = baseName(decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'image'));
      setSource({ el: img, w: img.naturalWidth, h: img.naturalHeight, name, thumbUrl: url });
    };
    img.onerror = () => toast("Couldn't load that image. Save it to your device and upload the file instead.");
    img.src = url;
  }

  function setSource(next) {
    if (source?.revoke) URL.revokeObjectURL(source.thumbUrl);
    source = next;
    els.thumb.src = next.thumbUrl;
    els.thumb.hidden = false;
    els.dropText.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = next.name;
    const sub = document.createElement('span');
    sub.textContent = `${next.w} × ${next.h}px · click or drop to change`;
    els.dropText.append(strong, sub);
    schedule(true);
  }

  function baseName(name) {
    return (name || 'image').replace(/\.[^.]+$/, '') || 'image';
  }

  els.file.addEventListener('change', () => {
    loadFile(els.file.files[0]);
    els.file.value = '';
  });

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = [...e.dataTransfer.files].find((f) => !f.type || f.type.startsWith('image/'));
    if (file) return loadFile(file);
    const url = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
    if (url) return loadUrl(url.trim());
    if (e.dataTransfer.files.length) toast("That file isn't an image.");
  });

  // Paste with Ctrl/Cmd+V.
  document.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    loadFile(file);
  });

  // Explicit "Paste image" button (mainly for touch devices without a keyboard shortcut).
  if (navigator.clipboard?.read) {
    els.pasteBtn.hidden = false;
    els.pasteBtn.addEventListener('click', async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) {
            const blob = await item.getType(type);
            return loadFile(new File([blob], 'pasted-image', { type }));
          }
        }
        toast('No image on the clipboard.');
      } catch {
        toast('Clipboard access was blocked. Try Ctrl/Cmd+V instead.');
      }
    });
  }

  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    for (const k of document.querySelectorAll('kbd.mod')) k.textContent = '⌘';
  }

  function useSample() {
    const c = makeSample();
    setSource({ el: c, w: c.width, h: c.height, name: 'sample', thumbUrl: c.toDataURL() });
  }
  els.sampleBtn.addEventListener('click', useSample);
  els.emptySampleBtn.addEventListener('click', useSample);

  function makeSample() {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const x = c.getContext('2d');

    const sky = x.createLinearGradient(0, 0, 0, 480);
    sky.addColorStop(0, '#0b1340');
    sky.addColorStop(0.6, '#6a3f8f');
    sky.addColorStop(1, '#f7a07a');
    x.fillStyle = sky;
    x.fillRect(0, 0, 640, 480);

    // Stars
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    x.fillStyle = '#fff';
    for (let i = 0; i < 70; i++) {
      const r = rand() * 1.6 + 0.4;
      x.globalAlpha = 0.4 + rand() * 0.6;
      x.beginPath();
      x.arc(rand() * 640, rand() * 260, r, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;

    // Ground with a checkerboard in perspective
    const horizon = 330;
    x.fillStyle = '#1b1030';
    x.fillRect(0, horizon, 640, 480 - horizon);
    x.fillStyle = '#e8508f';
    for (let row = 0; row < 10; row++) {
      const t0 = row / 10, t1 = (row + 1) / 10;
      const y0 = horizon + (480 - horizon) * t0 * t0;
      const y1 = horizon + (480 - horizon) * t1 * t1;
      for (let col = -12; col < 12; col++) {
        if ((row + col) & 1) continue;
        const px = (cx, t) => 320 + cx * 40 * (0.15 + 2.2 * t * t);
        x.beginPath();
        x.moveTo(px(col, t0), y0);
        x.lineTo(px(col + 1, t0), y0);
        x.lineTo(px(col + 1, t1), y1);
        x.lineTo(px(col, t1), y1);
        x.closePath();
        x.globalAlpha = 0.25 + 0.6 * t1;
        x.fill();
      }
    }
    x.globalAlpha = 1;

    // Shadow
    const shadow = x.createRadialGradient(320, 392, 10, 320, 392, 150);
    shadow.addColorStop(0, 'rgba(0,0,0,0.7)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = shadow;
    x.beginPath();
    x.ellipse(320, 392, 150, 26, 0, 0, Math.PI * 2);
    x.fill();

    // Shaded sphere
    const ball = x.createRadialGradient(270, 170, 12, 320, 230, 150);
    ball.addColorStop(0, '#fffbe6');
    ball.addColorStop(0.25, '#ffd166');
    ball.addColorStop(0.7, '#ef476f');
    ball.addColorStop(1, '#3a0b2e');
    x.fillStyle = ball;
    x.beginPath();
    x.arc(320, 230, 140, 0, Math.PI * 2);
    x.fill();

    return c;
  }

  // ---------- Conversion ----------

  function schedule(convert) {
    needsConvert ||= convert;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (needsConvert) {
        needsConvert = false;
        run();
      } else {
        layout();
      }
    });
  }

  function run() {
    if (!source) return;
    try {
      result = convert();
    } catch (err) {
      result = null;
      console.error(err);
      toast(err?.name === 'SecurityError'
        ? "That site doesn't allow its images to be read. Save the image and upload the file instead."
        : 'Something went wrong converting that image.');
    }
    render();
  }

  // Draws the source onto a W×H canvas (composited over the output background) and returns RGBA pixels.
  // Large downscales are done in halving steps so small outputs don't alias.
  function sample(W, H) {
    let cur = source.el;
    let cw = source.w;
    let ch = source.h;
    while (cw >= W * 4 && ch >= H * 4) {
      const next = cur === stepA ? stepB : stepA;
      const nw = Math.ceil(cw / 2);
      const nh = Math.ceil(ch / 2);
      next.width = nw;
      next.height = nh;
      const nctx = next.getContext('2d');
      nctx.imageSmoothingQuality = 'high';
      nctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = next;
      cw = nw;
      ch = nh;
    }
    work.width = W;
    work.height = H;
    workCtx.fillStyle = ART_COLORS[settings.bg].bg;
    workCtx.fillRect(0, 0, W, H);
    workCtx.imageSmoothingEnabled = true;
    workCtx.imageSmoothingQuality = 'high';
    workCtx.drawImage(cur, 0, 0, cw, ch, 0, 0, W, H);
    return workCtx.getImageData(0, 0, W, H).data;
  }

  function convert() {
    const s = settings;
    const braille = s.charset === 'braille';
    const cols = Math.round(clamp(s.cols, 10, 400));
    const rows = Math.max(1, Math.round((source.h / source.w) * cols * s.aspect));
    const W = braille ? cols * 2 : cols;
    const H = braille ? rows * 4 : rows;

    const px = sample(W, H);
    const n = W * H;
    const lum = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      lum[i] = (0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]) / 255;
    }

    // Auto levels: stretch the 1st–99th percentile to the full range.
    let lo = 0, hi = 1;
    if (s.autoLevels) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) hist[Math.min(255, (lum[i] * 255) | 0)]++;
      const cut = n * 0.01;
      let acc = 0, a = 0, b = 255;
      for (; a < 255 && (acc += hist[a]) <= cut; a++);
      acc = 0;
      for (; b > 0 && (acc += hist[b]) <= cut; b--);
      if (b - a > 4) { lo = a / 255; hi = b / 255; }
    }

    const cf = s.contrast >= 0 ? 1 + s.contrast / 25 : 1 + s.contrast / 100;
    const bo = s.brightness / 100;
    // Density = how much "ink" a cell needs. On a dark background ink is light, so bright pixels are dense.
    const flip = (s.bg === 'light') !== s.invert;
    const density = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = (lum[i] - lo) / (hi - lo);
      v = (v - 0.5) * cf + 0.5 + bo;
      v = clamp(v, 0, 1);
      density[i] = flip ? 1 - v : v;
    }

    const ramp = braille ? null : getRamp();
    const levels = braille ? 2 : ramp.length;
    const q = quantize(density, W, H, levels, s.dither);

    const chars = new Array(cols * rows);
    if (braille) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let bits = 0;
          for (let dy = 0; dy < 4; dy++) {
            const rowOff = (r * 4 + dy) * W + c * 2;
            if (q[rowOff]) bits |= BRAILLE_BITS[dy][0];
            if (q[rowOff + 1]) bits |= BRAILLE_BITS[dy][1];
          }
          chars[r * cols + c] = String.fromCharCode(0x2800 + bits);
        }
      }
    } else {
      for (let i = 0; i < n; i++) chars[i] = ramp[q[i]];
    }

    let colors = null;
    if (s.color) {
      const cpx = braille ? sample(cols, rows) : px;
      // Character density already carries brightness, so color only needs to carry hue.
      // Normalize each color to a fixed peak: bright on dark backgrounds, darker on light ones.
      const peak = s.bg === 'light' ? 150 : 255;
      colors = new Uint8Array(cols * rows * 3);
      for (let i = 0, p = 0, k = 0; i < cols * rows; i++, p += 4, k += 3) {
        const max = Math.max(cpx[p], cpx[p + 1], cpx[p + 2]);
        const f = max ? peak / max : 0;
        colors[k] = cpx[p] * f;
        colors[k + 1] = cpx[p + 1] * f;
        colors[k + 2] = cpx[p + 2] * f;
      }
    }

    const lines = [];
    for (let r = 0; r < rows; r++) lines.push(chars.slice(r * cols, (r + 1) * cols).join(''));

    return { chars, lines, colors, cols, rows, braille };
  }

  function quantize(d, W, H, levels, mode) {
    const m = levels - 1;
    const out = new Uint16Array(W * H);
    if (mode === 'floyd') {
      const buf = Float32Array.from(d);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const old = buf[i];
          const lvl = Math.round(clamp(old, 0, 1) * m);
          out[i] = lvl;
          const err = old - lvl / m;
          if (x + 1 < W) buf[i + 1] += err * 7 / 16;
          if (y + 1 < H) {
            if (x > 0) buf[i + W - 1] += err * 3 / 16;
            buf[i + W] += err * 5 / 16;
            if (x + 1 < W) buf[i + W + 1] += err / 16;
          }
        }
      }
    } else if (mode === 'ordered') {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const t = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5;
          out[i] = clamp(Math.round(d[i] * m + t), 0, m);
        }
      }
    } else {
      // Equal-width bins for each character.
      for (let i = 0; i < d.length; i++) out[i] = Math.min(m, (d[i] * levels) | 0);
    }
    return out;
  }

  // ---------- Output ----------

  const isBlank = (ch) => ch === ' ' || ch === BRAILLE_BLANK;
  const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  const colorAt = (colors, i) => {
    const k = i * 3;
    // Drop the lowest 2 bits so neighbouring cells merge into fewer spans.
    return `${colors[k] & 0xfc},${colors[k + 1] & 0xfc},${colors[k + 2] & 0xfc}`;
  };

  function coloredHtml(res) {
    const out = [];
    const { chars, colors, cols, rows } = res;
    for (let r = 0; r < rows; r++) {
      let run = '';
      let cur = '';
      const flush = () => {
        if (!run) return;
        out.push(cur ? `<span style="color:rgb(${cur})">${escapeHtml(run)}</span>` : escapeHtml(run));
        run = '';
      };
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const ch = chars[i];
        if (!isBlank(ch)) {
          const col = colorAt(colors, i);
          if (col !== cur) { flush(); cur = col; }
        }
        run += ch;
      }
      flush();
      if (r < rows - 1) out.push('\n');
    }
    return out.join('');
  }

  function plainText(res) {
    return res.lines.map((l) => l.replace(/ +$/, '')).join('\n');
  }

  function render() {
    const ready = !!result;
    els.empty.hidden = ready;
    els.art.hidden = !ready;
    for (const b of [els.copyBtn, els.copyMdBtn, els.txtBtn, els.pngBtn, els.htmlBtn]) b.disabled = !ready;
    if (!ready) {
      els.stats.textContent = '';
      return;
    }
    if (result.colors) els.art.innerHTML = coloredHtml(result);
    else els.art.textContent = result.lines.join('\n');
    els.stats.textContent = `${result.cols} × ${result.rows}`;
    layout();
  }

  const charWidthCache = new Map();
  function charWidthEm(braille) {
    const key = braille ? 'braille' : 'text';
    if (!charWidthCache.has(key)) {
      measureCtx.font = `100px ${FONT}`;
      charWidthCache.set(key, measureCtx.measureText(braille ? '⣿' : 'M').width / 100 || 0.6);
    }
    return charWidthCache.get(key);
  }

  function layout() {
    if (!result) return;
    const em = charWidthEm(result.braille);
    const lineEm = em / settings.aspect;
    let size = settings.fontSize;
    if (settings.fit) {
      // Fit the whole piece inside the stage, both horizontally and vertically.
      const pad = 32;
      const availW = els.stage.clientWidth - pad;
      const availH = els.stage.clientHeight - pad;
      if (availW > 0 && availH > 0) {
        size = clamp(Math.min(availW / (result.cols * em), availH / (result.rows * lineEm)), 1, 40);
        size = Math.floor(size * 100) / 100;
      }
    }
    els.art.style.fontSize = `${size}px`;
    els.art.style.lineHeight = String(lineEm);
  }

  new ResizeObserver(() => { if (settings.fit) schedule(false); }).observe(els.stage);

  // ---------- Copy & download ----------

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
    } catch {
      // Fallback for browsers/contexts that block the async clipboard API.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? label : 'Copy failed. Select the text and copy it manually.');
    }
  }

  els.copyBtn.addEventListener('click', () => {
    if (result) copyText(plainText(result), `Copied ${result.cols}×${result.rows} characters`);
  });

  els.copyMdBtn.addEventListener('click', () => {
    if (result) copyText('```\n' + plainText(result) + '\n```', 'Copied as a code block');
  });

  els.txtBtn.addEventListener('click', () => {
    if (!result) return;
    download(new Blob([plainText(result) + '\n'], { type: 'text/plain;charset=utf-8' }), `${fileStem()}.txt`);
  });

  els.htmlBtn.addEventListener('click', () => {
    if (!result) return;
    const { bg, fg } = ART_COLORS[settings.bg];
    const body = result.colors ? coloredHtml(result) : escapeHtml(result.lines.join('\n'));
    const lh = (charWidthEm(result.braille) / settings.aspect).toFixed(3);
    const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(source.name)} (ASCII art)</title>
<style>
  html, body { margin: 0; background: ${bg}; color: ${fg}; }
  pre { margin: 0; padding: 24px; font: 10px/${lh} ${FONT}; white-space: pre; letter-spacing: 0; font-variant-ligatures: none; }
</style>
</head>
<body>
<pre>${body}</pre>
</body>
</html>
`;
    download(new Blob([doc], { type: 'text/html;charset=utf-8' }), `${fileStem()}.html`);
  });

  els.pngBtn.addEventListener('click', () => {
    if (!result) return;
    const { bg, fg } = ART_COLORS[settings.bg];
    const fontSize = 14;
    const pad = 24;
    const cw = charWidthEm(result.braille) * fontSize;
    const lh = cw / settings.aspect;
    const w = Math.ceil(result.cols * cw + pad * 2);
    const h = Math.ceil(result.rows * lh + pad * 2);
    // Render at 2× for crispness, scaled down if it would exceed common canvas size limits.
    const scale = Math.max(0.25, Math.min(2, Math.sqrt(16_000_000 / (w * h)), 16_000 / w, 16_000 / h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${fontSize}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fg;
    const { chars, colors, cols, rows } = result;
    for (let r = 0; r < rows; r++) {
      const y = pad + r * lh + lh / 2;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const ch = chars[i];
        if (isBlank(ch)) continue;
        if (colors) ctx.fillStyle = `rgb(${colorAt(colors, i)})`;
        ctx.fillText(ch, pad + c * cw, y);
      }
    }
    canvas.toBlob((blob) => {
      if (blob) download(blob, `${fileStem()}.png`);
      else toast("Couldn't create the PNG. Try a smaller width.");
    }, 'image/png');
  });

  function fileStem() {
    const stem = (source?.name || 'image').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
    return `${stem}-ascii`;
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Saved ${filename}`);
  }

  // ---------- Utilities ----------

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  syncControls();
  render();
})();
