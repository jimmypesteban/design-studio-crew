// Runs inside Chrome. Plain JavaScript on purpose: it is serialised into the
// page, so it must not be touched by the TypeScript toolchain.
// Returns raw measurements only. Judgement and fix advice live in checks.ts.
(function (params) {
  var PAL = new Set(params.palette);
  var TYPE_PX = new Set(params.typePx);
  var RADII = params.radii;
  var ALLOWED = params.allowedClasses ? new Set(params.allowedClasses) : null;
  var MODE = params.mode || 'screen';
  var vh = window.innerHeight;
  var inv = { colors: {}, fontSizes: {}, radii: {}, fonts: {} };
  var vw = window.innerWidth;
  var out = {
    vw: vw, docScrollWidth: document.documentElement.scrollWidth, elements: 0, textElements: 0,
    overflow: [], clipped: [], textOverflow: [], hit: [], collisions: [], contrast: [], unverified: [],
    palette: [], type: [], family: [], radius: [], grid: [], classes: [], a11y: [],
    vh: vh, overflowY: [], vOverflow: [], unsafe: [], tooSmall: [], images: [], grids: [], inventory: inv, rects: {}, smallText: [], page: null,
  };

  function sel(el) {
    var s = selPath(el);
    if (params.collectRects && !out.rects[s]) {
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.rects[s] = [Math.round(r.left + window.scrollX), Math.round(r.top + window.scrollY), Math.round(r.width), Math.round(r.height)];
    }
    return s;
  }
  function selPath(el) {
    var parts = [];
    var n = el;
    for (var i = 0; n && n.nodeType === 1 && n !== document.body && i < 3; i++) {
      var s = n.tagName.toLowerCase();
      if (n.id) s += '#' + n.id;
      var cl = Array.prototype.slice.call(n.classList, 0, 2);
      if (cl.length) s += '.' + cl.join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function parse(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function hex(rgb) {
    return '#' + rgb.slice(0, 3).map(function (v) { return Math.round(v).toString(16).padStart(2, '0'); }).join('').toUpperCase();
  }
  function lin(c) { var s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  function lum(r) { return 0.2126 * lin(r[0]) + 0.7152 * lin(r[1]) + 0.0722 * lin(r[2]); }
  function ratio(a, b) { var x = lum(a), y = lum(b); var hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); }
  function visible(el) {
    // The visually-hidden idiom (1px, clipped, absolute) is deliberate, so it is not part of the layout.
    var r0 = el.getBoundingClientRect();
    if (r0.width <= 1 && r0.height <= 1 && getComputedStyle(el).position === 'absolute' && getComputedStyle(el).overflow === 'hidden') return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return r0.width > 0 && r0.height > 0;
  }
  function bgOf(el) {
    var layers = [];
    var image = false;
    var n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') image = true;
      var c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
      n = n.parentElement;
    }
    var base = [255, 255, 255];
    for (var i = layers.length - 1; i >= 0; i--) {
      var l = layers[i];
      base = [l[0] * l[3] + base[0] * (1 - l[3]), l[1] * l[3] + base[1] * (1 - l[3]), l[2] * l[3] + base[2] * (1 - l[3])];
    }
    return { rgb: base, image: image };
  }
  function hasText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  }
  function clipAncestor(el, vwLimit) {
    var n = el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      var cs = getComputedStyle(n);
      if (cs.overflowX !== 'visible' && n.getBoundingClientRect().right <= vwLimit + 1) return true;
      n = n.parentElement;
    }
    return false;
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, NOSCRIPT: 1, BR: 1 };
  var all = Array.prototype.slice.call(document.body.querySelectorAll('*')).filter(function (e) { return !SKIP[e.tagName] && !(e instanceof SVGElement); });
  var CAP = params.maxElements || 1e9;
  out.truncated = all.length > CAP ? all.length : 0;
  if (all.length > CAP) all = all.slice(0, CAP);
  var seenOffPalette = {};

  all.forEach(function (el) {
    if (!visible(el)) return;
    out.elements++;
    var cs = getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    var s = sel(el);

    // Unknown classes
    if (ALLOWED) {
      Array.prototype.forEach.call(el.classList, function (c) {
        if (!ALLOWED.has(c)) out.classes.push({ sel: s, cls: c });
      });
    }
    if (cs.display === 'grid') {
      var cols = cs.gridTemplateColumns === 'none' ? 0 : cs.gridTemplateColumns.split(' ').filter(Boolean).length;
      out.grids.push({ sel: s, cols: cols });
    }
    if (MODE === 'asset') {
      if (rect.bottom > vh + 1) out.overflowY.push({ sel: s, over: Math.round(rect.bottom - vh), edge: 'bottom' });
      if (rect.top < -1) out.overflowY.push({ sel: s, over: Math.round(-rect.top), edge: 'top' });
      // A child that actually spills out of its parent's box. Glyph height inside a tight line box does not count.
      if (cs.overflowY === 'visible' && el.children.length) {
        var maxBottom = -1e9;
        Array.prototype.forEach.call(el.children, function (ch) {
          var pos = getComputedStyle(ch).position;
          if (pos === 'absolute' || pos === 'fixed') return;
          var b = ch.getBoundingClientRect().bottom;
          if (b > maxBottom) maxBottom = b;
        });
        if (maxBottom > rect.bottom + 2) out.vOverflow.push({ sel: s, scroll: Math.round(maxBottom - rect.top), client: Math.round(rect.height) });
      }
    }

    // Horizontal overflow past the viewport
    if (cs.position !== 'fixed' && rect.right > vw + 1 && !clipAncestor(el, vw)) {
      out.overflow.push({ sel: s, right: Math.round(rect.right), over: Math.round(rect.right - vw), width: Math.round(rect.width) });
    }
    // Clipped or spilling content
    // Decorative content marked aria-hidden (a marquee, a shape) cannot hide anything from anyone, so clipping it is not a defect.
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !el.closest('[aria-hidden="true"]')) {
      out.clipped.push({ sel: s, scroll: el.scrollWidth, client: el.clientWidth });
    }
    var text = hasText(el);
    if (text && cs.display !== 'inline' && cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      out.textOverflow.push({ sel: s, scroll: el.scrollWidth, client: el.clientWidth });
    }

    // Colours against the palette
    var sides = [
      ['color', text ? cs.color : null], ['background', cs.backgroundColor],
      ['border', parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' ? cs.borderTopColor : null],
      ['border', parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none' ? cs.borderBottomColor : null],
    ];
    sides.forEach(function (p) {
      if (!p[1]) return;
      var c = parse(p[1]);
      if (!c || c[3] === 0) return;
      var key = c[0] + ',' + c[1] + ',' + c[2];
      var hx = hex(c);
      inv.colors[hx] = (inv.colors[hx] || 0) + 1;
      if (!PAL.has(key)) {
        var k2 = p[0] + key;
        if (!seenOffPalette[k2]) { seenOffPalette[k2] = 1; out.palette.push({ sel: s, prop: p[0], value: hex(c) }); }
      }
    });

    // Radius
    var r0 = parseFloat(cs.borderTopLeftRadius);
    if (r0 > 0) inv.radii[r0 >= 1000 ? 'full' : r0] = (inv.radii[r0 >= 1000 ? 'full' : r0] || 0) + 1;
    if (r0 > 0 && !/%$/.test(cs.borderTopLeftRadius) && r0 < 1000 && RADII.indexOf(r0) === -1) out.radius.push({ sel: s, value: r0 });

    // 4px grid (Tailwind half steps are allowed, odd pixel values are not)
    var gridProps = [['padding-top', cs.paddingTop], ['padding-right', cs.paddingRight], ['padding-bottom', cs.paddingBottom], ['padding-left', cs.paddingLeft], ['margin-top', cs.marginTop], ['margin-bottom', cs.marginBottom]];
    if (cs.display.indexOf('flex') !== -1 || cs.display.indexOf('grid') !== -1) {
      if (cs.rowGap !== 'normal') gridProps.push(['row-gap', cs.rowGap]);
      if (cs.columnGap !== 'normal') gridProps.push(['column-gap', cs.columnGap]);
    }
    gridProps.forEach(function (g) {
      var v = parseFloat(g[1]);
      if (!isFinite(v) || v === 0) return;
      if (Math.abs(v - Math.round(v)) > 0.01 || Math.round(v) % 2 !== 0) out.grid.push({ sel: s, prop: g[0], value: v });
    });

    if (text && !el.closest('script,style')) {
      out.textElements++;
      var px = parseFloat(cs.fontSize);
      inv.fontSizes[px] = (inv.fontSizes[px] || 0) + 1;
      if (MODE === 'audit' && px < 12) out.smallText.push({ sel: s, px: px });
      if (MODE === 'asset' && px / Math.min(vw, vh) < 0.02) out.tooSmall.push({ sel: s, px: px, min: Math.round(Math.min(vw, vh) * 0.02 * 10) / 10 });
      inv.fonts[cs.fontFamily.split(',')[0].replace(/"/g, '')] = 1;
      if (!TYPE_PX.has(Math.round(px * 10) / 10)) out.type.push({ sel: s, value: px });
      var fam = cs.fontFamily;
      if (fam.indexOf('Source Serif 4') !== 0 && fam.indexOf('"Source Serif 4"') !== 0 && fam.indexOf('Source Sans 3') !== 0 && fam.indexOf('"Source Sans 3"') !== 0) {
        out.family.push({ sel: s, value: fam.split(',')[0] });
      }
      // Contrast
      if (!el.closest('[disabled]')) {
        var bg = bgOf(el);
        var fgc = parse(cs.color);
        if (fgc) {
          if (bg.image) {
            out.unverified.push({ sel: s, reason: 'text sits on a background image or gradient' });
          } else {
            var a = fgc[3];
            var fg = [fgc[0] * a + bg.rgb[0] * (1 - a), fgc[1] * a + bg.rgb[1] * (1 - a), fgc[2] * a + bg.rgb[2] * (1 - a)];
            var weight = parseInt(cs.fontWeight, 10) || 400;
            var large = px >= 24 || (px >= 18.66 && weight >= 700);
            out.contrast.push({
              sel: s, sample: el.textContent.trim().slice(0, 28), fg: hex(fg), bg: hex(bg.rgb),
              ratio: Math.round(ratio(fg, bg.rgb) * 100) / 100, need: large ? 3 : 4.5, px: px,
            });
          }
        }
      }
    }
  });

  // Tap targets
  var interactive = document.body.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])');
  Array.prototype.forEach.call(interactive, function (el) {
    if (!visible(el)) return;
    var cs = getComputedStyle(el);
    if (el.tagName === 'A' && cs.display === 'inline') return; // inline links inside text are exempt
    var target = el;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      var lab = el.closest('label');
      if (lab) target = lab;
    }
    var r = target.getBoundingClientRect();
    if (Math.min(r.width, r.height) < 24) out.hit.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
  });

  // Text landing on text
  var rects = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node;
  var count = 0;
  while ((node = walker.nextNode()) && count < 500) {
    if (!node.textContent.trim()) continue;
    var parent = node.parentElement;
    if (!parent || SKIP[parent.tagName] || !visible(parent)) continue;
    count++;
    var range = document.createRange();
    range.selectNodeContents(node);
    Array.prototype.forEach.call(range.getClientRects(), function (rc) {
      if (rc.width > 1 && rc.height > 1) rects.push({ n: node, p: parent, l: rc.left, t: rc.top, r: rc.right, b: rc.bottom });
    });
  }
  for (var i = 0; i < rects.length && out.collisions.length < 10; i++) {
    for (var j = i + 1; j < rects.length; j++) {
      var A = rects[i], B = rects[j];
      if (A.n === B.n) continue;
      var w = Math.min(A.r, B.r) - Math.max(A.l, B.l);
      var h = Math.min(A.b, B.b) - Math.max(A.t, B.t);
      if (w <= 1 || h <= 1) continue;
      var small = Math.min((A.r - A.l) * (A.b - A.t), (B.r - B.l) * (B.b - B.t));
      if ((w * h) / small > 0.3) { out.collisions.push({ a: sel(A.p), b: sel(B.p), area: Math.round(w * h) }); break; }
    }
  }

  // Brand assets: text must keep clear of the edges
  if (MODE === 'asset' && params.safe) {
    var seenUnsafe = {};
    rects.forEach(function (R) {
      var sx = params.safe.x, sy = params.safe.y;
      if (R.l < sx - 1 || R.t < sy - 1 || R.r > vw - sx + 1 || R.b > vh - sy + 1) {
        var k = sel(R.p);
        if (!seenUnsafe[k]) { seenUnsafe[k] = 1; out.unsafe.push({ sel: k, x: sx, y: sy }); }
      }
    });
  }
  // Brand assets: how far the artwork strays from the Moon palette (average distance, 0 to 441)
  if (MODE === 'asset') {
    var pal = params.palette.map(function (k) { return k.split(',').map(Number); });
    Array.prototype.forEach.call(document.querySelectorAll('img'), function (img) {
      if (!img.complete || !img.naturalWidth) return;
      try {
        var c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        var g = c.getContext('2d');
        g.drawImage(img, 0, 0, 32, 32);
        var d = g.getImageData(0, 0, 32, 32).data;
        var total = 0, n = 0;
        for (var i = 0; i < d.length; i += 4) {
          var best = 1e9;
          for (var j = 0; j < pal.length; j++) {
            var dr = d[i] - pal[j][0], dg = d[i + 1] - pal[j][1], db = d[i + 2] - pal[j][2];
            var dist = Math.sqrt(dr * dr + dg * dg + db * db);
            if (dist < best) best = dist;
          }
          total += best; n++;
        }
        out.images.push({ sel: sel(img), drift: Math.round(total / n), w: img.naturalWidth, h: img.naturalHeight });
      } catch (e) { /* a tainted canvas means the image could not be read, so it is simply not measured */ }
    });
  }

  // Basic accessibility the standard cares about
  Array.prototype.forEach.call(document.body.querySelectorAll('img'), function (img) {
    if (!img.hasAttribute('alt')) out.a11y.push({ rule: 'missing-alt', sel: sel(img) });
  });
  Array.prototype.forEach.call(document.body.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea'), function (f) {
    var named = f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.closest('label') || (f.id && document.querySelector('label[for="' + f.id + '"]'));
    if (!named) out.a11y.push({ rule: 'missing-label', sel: sel(f) });
  });
  Array.prototype.forEach.call(document.body.querySelectorAll('button, a[href]'), function (b) {
    if (!visible(b)) return;
    if (!b.textContent.trim() && !b.getAttribute('aria-label') && !b.querySelector('img[alt]')) out.a11y.push({ rule: 'empty-control', sel: sel(b) });
  });
  if (MODE === 'audit') {
    var meta = document.querySelector('meta[name=viewport]');
    var short = function (t, n) { return (t || '').replace(/\s+/g, ' ').trim().slice(0, n); };
    var pg = {
      title: short(document.title, 120),
      lang: document.documentElement.lang || '',
      viewportMeta: meta ? meta.getAttribute('content') : null,
      bodyFontPx: parseFloat(getComputedStyle(document.body).fontSize),
      headings: [], links: [], brokenImages: [], longLines: [], noAutocomplete: [],
    };
    Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6'), 0, 200).forEach(function (h) {
      if (visible(h)) pg.headings.push({ level: Number(h.tagName[1]), text: short(h.textContent, 60), sel: sel(h) });
    });
    Array.prototype.slice.call(document.querySelectorAll('a[href]'), 0, 600).forEach(function (a) {
      if (!visible(a)) return;
      var t = short(a.getAttribute('aria-label') || a.textContent, 60);
      pg.links.push({ text: t, sel: sel(a) });
    });
    Array.prototype.slice.call(document.querySelectorAll('img'), 0, 400).forEach(function (im) {
      if (visible(im) && im.complete && im.naturalWidth === 0) pg.brokenImages.push({ sel: sel(im), src: short(im.currentSrc || im.src, 100) });
    });
    Array.prototype.slice.call(document.querySelectorAll('p, li'), 0, 400).forEach(function (el) {
      if (!visible(el)) return;
      var px = parseFloat(getComputedStyle(el).fontSize);
      var len = (el.textContent || '').length;
      var perLine = el.clientWidth / (px * 0.5);
      if (len > 200 && perLine > 95) pg.longLines.push({ sel: sel(el), chars: Math.round(perLine) });
    });
    Array.prototype.slice.call(document.querySelectorAll('input[type=email], input[type=password], input[type=tel], input[name*=name i], input[name*=email i]'), 0, 100).forEach(function (f) {
      if (visible(f) && !f.getAttribute('autocomplete')) pg.noAutocomplete.push({ sel: sel(f), type: f.type });
    });
    out.page = pg;
  }
  if (!document.documentElement.lang) out.a11y.push({ rule: 'missing-lang', sel: 'html' });
  if (document.querySelectorAll('h1').length !== 1) out.a11y.push({ rule: 'h1-count', sel: 'h1 count is ' + document.querySelectorAll('h1').length });
  return out;
})
