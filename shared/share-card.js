// LitShareCard: draws a 1200x627 PNG progress card people can paste into
// LinkedIn or a group chat.
//
//   LitShareCard.render({ template, theme, accent, bigNumber, bigLabel, streak,
//                         weekDots, goingFor, milestoneTitle }) -> Promise<Blob>
//   LitShareCard.copy(blob)               -> Promise<boolean>
//   LitShareCard.download(blob, filename) -> boolean
//
// The card only ever shows the numbers and words passed in here. It is never
// given company names and has no way to draw them.
const LitShareCard = (() => {
  const WIDTH = 1200;
  const HEIGHT = 627;
  const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif';

  const ACCENTS = {
    coral: ['#E0674B', '#F07A5E'],
    sage: ['#5E9270', '#7FB291'],
    ocean: ['#3B7EA1', '#5FA3C7'],
    plum: ['#8A5A9E', '#B285C6'],
    amber: ['#C9821F', '#E3A54A'],
    slate: ['#3D4A5C', '#A9B6C8']
  };

  const THEMES = {
    light: { bg: '#FBF8F3', surface: '#FFFFFF', surface2: '#F4EFE7', ink: '#2A2622', muted: '#6F665E', line: '#ECE5DA', success: '#6B9E7A', rest: '#8C9BB5' },
    dark: { bg: '#1C1916', surface: '#26221E', surface2: '#2F2A25', ink: '#F3EDE4', muted: '#A89E92', line: '#3A342D', success: '#82B592', rest: '#9FB0CC' }
  };

  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const TEMPLATES = ['minimal', 'bold', 'stats'];

  function resolveAccent(accent, theme) {
    const idx = theme === 'dark' ? 1 : 0;
    if (typeof accent === 'string' && ACCENTS[accent]) return ACCENTS[accent][idx];
    if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) return accent;
    return ACCENTS.coral[idx];
  }

  function cleanText(v, max) {
    if (v === undefined || v === null) return '';
    return String(v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
  }

  function makeCanvas() {
    if (typeof OffscreenCanvas !== 'undefined') {
      try { return new OffscreenCanvas(WIDTH, HEIGHT); } catch (e) { /* fall through */ }
    }
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = WIDTH;
      c.height = HEIGHT;
      return c;
    }
    throw new Error('Drawing the share card needs a browser canvas.');
  }

  function toBlob(canvas) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not create the image.'))), 'image/png');
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  function font(weight, size) {
    return weight + ' ' + Math.round(size) + 'px ' + FONT;
  }

  // Shrinks the font until text fits maxWidth; returns the size used.
  function fitText(ctx, text, weight, size, maxWidth, minSize) {
    let s = size;
    ctx.font = font(weight, s);
    while (s > (minSize || 12) && ctx.measureText(text).width > maxWidth) {
      s -= 2;
      ctx.font = font(weight, s);
    }
    return s;
  }

  // The locked padlock: a closed shackle over a rounded body with a keyhole.
  // (x, y) is the top-left of a box `size` wide and size * 1.2 tall.
  function drawPadlock(ctx, x, y, size, bodyColor, holeColor) {
    const bodyW = size;
    const bodyH = size * 0.78;
    const bodyY = y + size * 0.42;
    const shackleR = size * 0.3;
    const cx = x + bodyW / 2;
    ctx.save();
    ctx.strokeStyle = bodyColor;
    ctx.lineWidth = size * 0.13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - shackleR, bodyY + size * 0.02);
    ctx.lineTo(cx - shackleR, y + shackleR + size * 0.06);
    ctx.arc(cx, y + shackleR + size * 0.06, shackleR, Math.PI, 0, false);
    ctx.lineTo(cx + shackleR, bodyY + size * 0.02);
    ctx.stroke();
    ctx.fillStyle = bodyColor;
    roundRect(ctx, x, bodyY, bodyW, bodyH, size * 0.18);
    ctx.fill();
    ctx.fillStyle = holeColor;
    ctx.beginPath();
    ctx.arc(cx, bodyY + bodyH * 0.42, size * 0.09, 0, Math.PI * 2);
    ctx.fill();
    roundRect(ctx, cx - size * 0.04, bodyY + bodyH * 0.42, size * 0.08, bodyH * 0.3, size * 0.04);
    ctx.fill();
    ctx.restore();
  }

  function drawBrand(ctx, x, y, colors) {
    drawPadlock(ctx, x, y, 34, colors.lock, colors.lockHole);
    ctx.fillStyle = colors.brand;
    ctx.font = font(600, 24);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Tracked with LIT', x + 50, y + 26);
  }

  function dotState(d) {
    if (d === true) return 'met';
    if (d === false || d === null || d === undefined) return 'none';
    if (typeof d === 'string') return d;
    return typeof d.state === 'string' ? d.state : 'none';
  }

  // Seven dots, Monday to Sunday, with day letters under them.
  function drawWeekDots(ctx, dots, x, y, opts) {
    const list = Array.isArray(dots) ? dots.slice(0, 7) : [];
    while (list.length < 7) list.push({ state: 'future' });
    const r = opts.radius || 18;
    const gap = opts.gap || 22;
    ctx.save();
    list.forEach((d, i) => {
      const cx = x + r + i * (r * 2 + gap);
      const cy = y + r;
      const state = dotState(d);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (state === 'met') {
        ctx.fillStyle = opts.met;
        ctx.fill();
      } else if (state === 'some') {
        ctx.fillStyle = opts.someFill;
        ctx.fill();
        ctx.strokeStyle = opts.met;
        ctx.stroke();
      } else if (state === 'rest') {
        ctx.fillStyle = opts.restFill;
        ctx.fill();
        ctx.strokeStyle = opts.rest;
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.4, cy);
        ctx.lineTo(cx + r * 0.4, cy);
        ctx.stroke();
      } else if (state === 'frozen') {
        ctx.strokeStyle = opts.rest;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.5);
        ctx.lineTo(cx, cy + r * 0.5);
        ctx.moveTo(cx - r * 0.43, cy - r * 0.25);
        ctx.lineTo(cx + r * 0.43, cy + r * 0.25);
        ctx.moveTo(cx - r * 0.43, cy + r * 0.25);
        ctx.lineTo(cx + r * 0.43, cy - r * 0.25);
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (state === 'future') {
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = opts.line;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = opts.line;
        ctx.stroke();
      }
      ctx.fillStyle = opts.label;
      ctx.font = font(600, Math.round(r * 0.9));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(DAY_LETTERS[i], cx, cy + r + 10);
    });
    ctx.restore();
    return 7 * (r * 2) + 6 * gap;
  }

  function streakText(n) {
    const days = Math.max(0, parseInt(n, 10) || 0);
    if (days === 0) return '';
    return days === 1 ? '1 day streak' : days + ' day streak';
  }

  function drawMinimal(ctx, d, t, accent) {
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, 14, HEIGHT);
    drawBrand(ctx, 80, 64, { lock: accent, lockHole: t.bg, brand: t.muted });

    let y = 150;
    if (d.milestoneTitle) {
      ctx.fillStyle = accent;
      fitText(ctx, d.milestoneTitle, 700, 34, 1040, 20);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(d.milestoneTitle, 80, y);
      y += 52;
    }
    ctx.fillStyle = t.ink;
    const numSize = fitText(ctx, d.bigNumber, 800, 190, 560, 80);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(d.bigNumber, 74, y);
    const numW = ctx.measureText(d.bigNumber).width;
    ctx.fillStyle = t.muted;
    fitText(ctx, d.bigLabel, 600, 40, 1080 - numW - 40, 20);
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(d.bigLabel, 74 + numW + 28, y + numSize * 0.82);

    const rowY = HEIGHT - 150;
    drawWeekDots(ctx, d.weekDots, 80, rowY, {
      radius: 20, gap: 22, met: accent, someFill: t.surface2, rest: t.rest, restFill: t.surface2, line: t.line, label: t.muted
    });
    const s = streakText(d.streak);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    if (s) {
      ctx.fillStyle = t.ink;
      ctx.font = font(700, 34);
      ctx.fillText(s, WIDTH - 80, rowY);
    }
    if (d.goingFor) {
      ctx.fillStyle = t.muted;
      fitText(ctx, 'Going for: ' + d.goingFor, 500, 24, 520, 14);
      ctx.fillText('Going for: ' + d.goingFor, WIDTH - 80, rowY + (s ? 48 : 6));
    }
  }

  function drawBold(ctx, d, t, accent, theme) {
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const ink = theme === 'dark' ? '#1C1916' : '#FFFFFF';
    const soft = theme === 'dark' ? 'rgba(28,25,22,0.72)' : 'rgba(255,255,255,0.82)';
    const faint = theme === 'dark' ? 'rgba(28,25,22,0.18)' : 'rgba(255,255,255,0.22)';
    drawBrand(ctx, 80, 64, { lock: ink, lockHole: accent, brand: soft });

    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const numSize = fitText(ctx, d.bigNumber, 800, 250, 900, 90);
    const numBase = 150 + numSize * 0.8;
    ctx.fillText(d.bigNumber, WIDTH / 2, numBase);
    ctx.fillStyle = soft;
    fitText(ctx, d.bigLabel, 700, 46, 1000, 20);
    ctx.fillText(d.bigLabel, WIDTH / 2, numBase + 62);

    const lineBits = [];
    if (d.milestoneTitle) lineBits.push(d.milestoneTitle);
    const s = streakText(d.streak);
    if (s) lineBits.push(s);
    if (lineBits.length) {
      ctx.fillStyle = ink;
      const line = lineBits.join('  |  ');
      fitText(ctx, line, 600, 30, 1000, 16);
      ctx.fillText(line, WIDTH / 2, numBase + 116);
    }

    const r = 16;
    const gap = 20;
    const rowW = 7 * r * 2 + 6 * gap;
    drawWeekDots(ctx, d.weekDots, (WIDTH - rowW) / 2, HEIGHT - 110, {
      radius: r, gap, met: ink, someFill: faint, rest: soft, restFill: faint, line: soft, label: soft
    });
    if (d.goingFor) {
      ctx.fillStyle = soft;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      fitText(ctx, 'Going for: ' + d.goingFor, 500, 22, 460, 14);
      ctx.fillText('Going for: ' + d.goingFor, WIDTH - 80, 76);
    }
  }

  function drawStats(ctx, d, t, accent) {
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawBrand(ctx, 64, 52, { lock: accent, lockHole: t.bg, brand: t.muted });
    if (d.goingFor) {
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      fitText(ctx, 'Going for: ' + d.goingFor, 500, 24, 600, 14);
      ctx.fillText('Going for: ' + d.goingFor, WIDTH - 64, 62);
    }

    // Left panel: the big number.
    const top = 130;
    const panelH = HEIGHT - top - 64;
    ctx.fillStyle = t.surface;
    roundRect(ctx, 64, top, 600, panelH, 28);
    ctx.fill();
    ctx.strokeStyle = t.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(64, top + 40, 8, panelH - 80);
    ctx.fillStyle = t.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const numSize = fitText(ctx, d.bigNumber, 800, 200, 500, 80);
    ctx.fillText(d.bigNumber, 110, top + 60 + numSize * 0.8);
    ctx.fillStyle = t.muted;
    fitText(ctx, d.bigLabel, 600, 38, 510, 18);
    ctx.fillText(d.bigLabel, 112, top + 60 + numSize * 0.8 + 58);

    // Right column: streak and milestone tiles, then the week.
    const rx = 696;
    const rw = WIDTH - 64 - rx;
    const tileH = 120;
    const tiles = [];
    const s = streakText(d.streak);
    tiles.push({ k: 'Streak', v: s || 'Starting fresh' });
    if (d.milestoneTitle) tiles.push({ k: 'Milestone', v: d.milestoneTitle });
    tiles.forEach((tile, i) => {
      const ty = top + i * (tileH + 20);
      ctx.fillStyle = t.surface2;
      roundRect(ctx, rx, ty, rw, tileH, 22);
      ctx.fill();
      ctx.fillStyle = t.muted;
      ctx.font = font(600, 22);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(tile.k, rx + 28, ty + 22);
      ctx.fillStyle = t.ink;
      fitText(ctx, tile.v, 700, 38, rw - 56, 18);
      ctx.fillText(tile.v, rx + 28, ty + 58);
    });
    const weekY = top + panelH - 92;
    ctx.fillStyle = t.muted;
    ctx.font = font(600, 22);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('This week', rx + 4, weekY - 14);
    const r = 17;
    const gap = Math.floor((rw - 7 * r * 2) / 6);
    drawWeekDots(ctx, d.weekDots, rx, weekY, {
      radius: r, gap, met: accent, someFill: t.surface2, rest: t.rest, restFill: t.surface2, line: t.line, label: t.muted
    });
  }

  function normalize(opts) {
    const o = opts || {};
    const template = TEMPLATES.includes(o.template) ? o.template : 'minimal';
    const theme = o.theme === 'dark' ? 'dark' : 'light';
    const n = o.bigNumber;
    const bigNumber = typeof n === 'number' && Number.isFinite(n)
      ? Math.max(0, Math.round(n)).toLocaleString('en-US')
      : (cleanText(n, 12) || '0');
    return {
      template,
      theme,
      accent: resolveAccent(o.accent, theme),
      bigNumber,
      bigLabel: cleanText(o.bigLabel, 60) || 'applications sent',
      streak: Math.max(0, parseInt(o.streak, 10) || 0),
      weekDots: Array.isArray(o.weekDots) ? o.weekDots : [],
      goingFor: cleanText(o.goingFor, 80),
      milestoneTitle: cleanText(o.milestoneTitle, 60)
    };
  }

  // Draws onto any 2D context. Exposed so tests can drive a fake context.
  function draw(ctx, opts) {
    const d = normalize(opts);
    const t = THEMES[d.theme];
    if (d.template === 'bold') drawBold(ctx, d, t, d.accent, d.theme);
    else if (d.template === 'stats') drawStats(ctx, d, t, d.accent);
    else drawMinimal(ctx, d, t, d.accent);
    return d;
  }

  async function render(opts) {
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Drawing the share card needs a browser canvas.');
    draw(ctx, opts);
    return toBlob(canvas);
  }

  async function copy(blob) {
    try {
      if (!blob || typeof ClipboardItem === 'undefined' || typeof navigator === 'undefined' ||
        !navigator.clipboard || typeof navigator.clipboard.write !== 'function') return false;
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      return true;
    } catch (e) {
      return false;
    }
  }

  function download(blob, filename) {
    try {
      if (!blob || typeof document === 'undefined' || typeof URL === 'undefined') return false;
      const name = cleanText(filename, 80).replace(/[\\/:*?"<>|]/g, '-') || 'lit-progress.png';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = /\.png$/i.test(name) ? name : name + '.png';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      return true;
    } catch (e) {
      return false;
    }
  }

  return { WIDTH, HEIGHT, TEMPLATES, ACCENTS, render, copy, download, draw, normalize };
})();

if (typeof self !== 'undefined' && self && !self.LitShareCard) self.LitShareCard = LitShareCard;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LitShareCard;
}
