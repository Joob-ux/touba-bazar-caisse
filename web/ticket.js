/* Tickets de caisse 58 mm (384 points) dessinés sur un canvas, puis :
   - TPE Android : commandes ESC/POS raster envoyées à RawBT (pont window.Android ou lien intent:)
   - ailleurs : image imprimée par le navigateur.
   Les infos de la boutique viennent des paramètres GestPro (nom, adresse, téléphones, logo). */
(function () {
  const W = 384, M = 6, CW = W - 2 * M;
  const FONT = 'ui-monospace, "DejaVu Sans Mono", "Roboto Mono", Menlo, monospace';
  const SANS = 'system-ui, Roboto, "Segoe UI", sans-serif';

  const fmt = n => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const MODES = { cash: 'Espèces', wave: 'Wave', orange: 'Orange Money', card: 'Carte', transfer: 'Virement' };

  function loadImg(src) {
    return new Promise(res => {
      if (!src) return res(null);
      const i = new Image();
      if (!src.startsWith('data:')) i.crossOrigin = 'anonymous';
      const t = setTimeout(() => res(null), 3000);
      i.onload = () => { clearTimeout(t); res(i); };
      i.onerror = () => { clearTimeout(t); res(null); };
      i.src = src;
    });
  }

  function wrap(ctx, text, maxW) {
    const out = []; let line = '';
    for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (ctx.measureText(t).width <= maxW) { line = t; continue; }
      if (line) out.push(line);
      let w = word;
      while (ctx.measureText(w).width > maxW && w.length > 1) {
        let n = w.length; while (n > 1 && ctx.measureText(w.slice(0, n)).width > maxW) n--;
        out.push(w.slice(0, n)); w = w.slice(n);
      }
      line = w;
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  function dither(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const a = d[i * 4 + 3] / 255;   // transparent = blanc
      g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (1 - a);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, o = g[i], n = o < 128 ? 0 : 255, e = o - n; g[i] = n;
      if (x + 1 < w) g[i + 1] += e * 7 / 16;
      if (y + 1 < h) { if (x > 0) g[i + w - 1] += e * 3 / 16; g[i + w] += e * 5 / 16; if (x + 1 < w) g[i + w + 1] += e / 16; }
    }
    for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i]; d[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }

  /* Dessine en-tête boutique + corps + pied. withLogo=false si le logo bloque le canvas. */
  async function draw(shop, title, body, footer, withLogo) {
    const logo = withLogo ? await loadImg(shop.logo_url) : null;
    const c = document.createElement('canvas'); c.width = W; c.height = 8000;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, c.height); ctx.fillStyle = '#000';
    const t = { y: 6 };
    const font = (size, weight, fam) => { ctx.font = `${weight || 400} ${size}px ${fam || FONT}`; };
    t.center = (text, size, weight, fam) => {
      if (!text) return;
      font(size, weight, fam); ctx.textAlign = 'center';
      for (const l of wrap(ctx, text, CW)) { t.y += Math.round(size * 1.3); ctx.fillText(l, W / 2, t.y - Math.round(size * 0.25)); }
    };
    t.left = (text, size, weight) => {
      font(size, weight); ctx.textAlign = 'left';
      for (const l of wrap(ctx, text, CW)) { t.y += Math.round(size * 1.3); ctx.fillText(l, M, t.y - Math.round(size * 0.25)); }
    };
    t.pair = (label, value, size, weight) => {
      const s = size || 20, h = Math.round(s * 1.3);
      font(s, weight || 400); ctx.textAlign = 'left';
      const lw = ctx.measureText(label).width;
      const lines = wrap(ctx, value, CW - lw - 10);
      ctx.fillText(label, M, t.y + h - Math.round(s * 0.25));
      ctx.textAlign = 'right';
      lines.forEach((l, i) => ctx.fillText(l, W - M, t.y + h * (i + 1) - Math.round(s * 0.25)));
      t.y += h * lines.length;
    };
    t.hr = (plein) => { t.y += 7; if (plein) ctx.fillRect(M, t.y, CW, 2); else for (let x = M; x < W - M; x += 10) ctx.fillRect(x, t.y, 6, 2); t.y += 9; };
    t.gap = v => { t.y += v; };

    if (logo) {
      const maxH = 110, r = Math.min(CW / logo.width, maxH / logo.height, 1.5);
      const w = Math.round(logo.width * r), h = Math.round(logo.height * r);
      const lc = document.createElement('canvas'); lc.width = w; lc.height = h;
      const l = lc.getContext('2d'); l.fillStyle = '#fff'; l.fillRect(0, 0, w, h); l.drawImage(logo, 0, 0, w, h);
      dither(l, w, h);   // lève une erreur si l'image vient d'un autre site sans autorisation
      ctx.drawImage(lc, Math.round((W - w) / 2), t.y); t.y += h + 4;
    }
    t.center(shop.company_name || 'Boutique', 30, 800, SANS);
    t.center(shop.company_subtitle, 18, 400);
    t.center(shop.company_activity, 18, 400);
    t.center(shop.company_address, 18, 400);
    t.center([shop.company_phone, shop.company_phone2].filter(Boolean).join(' / '), 18, 400);
    t.hr(true);
    if (title) t.center(title, 24, 800, SANS);

    body(t);

    if (footer && footer.length) { t.gap(8); footer.forEach(f => t.center(f, 18, 400)); }
    t.gap(14);
    const out = document.createElement('canvas'); out.width = W; out.height = Math.ceil(t.y);
    out.getContext('2d').drawImage(c, 0, 0);
    return out;
  }

  async function canvas(shop, title, body, footer) {
    try { return await draw(shop, title, body, footer, !!shop.logo_url); }
    catch (e) { return draw(shop, title, body, footer, false); }
  }

  // Heure de Dakar (= UTC), quel que soit le fuseau réglé sur le TPE
  const dateTxt = d => { const x = new Date(d); return x.toLocaleDateString('fr-FR', { timeZone: 'UTC' }) + ' ' + x.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); };

  /* v = vente du journal : { num, saleId, date, items:[{name,qty,price}], sous, taxe, total, mode, recu, rendu, caissier } */
  function venteCanvas(shop, v, duplicata) {
    return canvas(shop, duplicata ? 'DUPLICATA' : 'TICKET DE CAISSE', t => {
      t.gap(4);
      t.pair('Ticket N°', v.num);
      if (v.saleId) t.pair('Vente GestPro', '#' + v.saleId);
      t.pair('Date', dateTxt(v.date));
      if (v.caissier) t.pair('Caissier', v.caissier);
      t.hr();
      const items = v.items || [];
      items.forEach(it => {
        t.left(it.name, 20, 600);
        t.pair(`  ${it.qty} x ${fmt(it.price)}`, fmt(it.qty * it.price) + ' F', 20);
      });
      if (v.note) t.left(v.note, 20, 600);
      if (items.length || v.note) t.hr();
      if (v.taxe) { t.pair('Sous-total', fmt(v.sous) + ' F'); t.pair('TVA', fmt(v.taxe) + ' F'); }
      t.gap(4); t.pair('TOTAL', fmt(v.total) + ' F', 30, 800);
      t.gap(4);
      t.pair('Paiement', MODES[v.mode] || v.mode);
      if (v.mode === 'cash' && v.recu) { t.pair('Reçu', fmt(v.recu) + ' F'); t.pair('Rendu', fmt(v.rendu) + ' F', 20, 700); }
      if (items.length) t.pair('Articles', String(items.reduce((a, i) => a + i.qty, 0)));
    }, shop.ticket_footer !== undefined ? (shop.ticket_footer ? [shop.ticket_footer] : []) : ['Merci de votre visite !', 'Les marchandises vendues ne sont ni reprises ni échangées.']);
  }

  /* c = { date, caissier, appareil:{nb,total,parMode}, boutique:{nb,total,parMode,annulees}|null, attente } */
  function clotureCanvas(shop, c) {
    return canvas(shop, c.titre || 'CLÔTURE DE CAISSE', t => {
      t.gap(4);
      t.pair('Journée', new Date(c.date + 'T12:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC' }));
      t.pair('Imprimé le', dateTxt(new Date()));
      if (c.caissier) t.pair('Caissier', c.caissier);
      const bloc = (titre, b) => {
        t.hr(); t.center(titre, 20, 700, SANS); t.gap(4);
        for (const m of ['cash', 'wave', 'orange']) {
          const x = (b.parMode || {})[m] || { nb: 0, total: 0 };
          t.pair(`${MODES[m]} (${x.nb})`, fmt(x.total) + ' F');
        }
        for (const [m, x] of Object.entries(b.parMode || {})) if (!['cash', 'wave', 'orange'].includes(m)) t.pair(`${MODES[m] || m} (${x.nb})`, fmt(x.total) + ' F');
        t.gap(4); t.pair(`TOTAL (${b.nb} ventes)`, fmt(b.total) + ' F', 24, 800);
        if (b.annulees) t.pair('Ventes annulées', String(b.annulees));
      };
      if (c.boutique) bloc(c.appareil ? 'Toute la boutique (GestPro)' : 'Récapitulatif de la journée', c.boutique);
      if (c.appareil) bloc('Ce TPE', c.appareil);
      if (c.attente) { t.hr(); t.left(`Attention : ${c.attente} vente(s) pas encore envoyée(s) à GestPro.`, 18, 700); }
      t.hr();
      t.gap(10); t.left('Espèces comptées : ..................', 20);
      t.gap(16); t.left('Signature : ..........................', 20);
    }, []);
  }

  function testCanvas(shop) {
    return canvas(shop, 'TICKET TEST', t => {
      t.gap(4); t.pair('Date', dateTxt(new Date()));
      t.pair('Article exemple', '1 000 F');
      t.hr(); t.pair('TOTAL', '1 000 F', 30, 800);
    }, ['L\'imprimante fonctionne.']);
  }

  /* Canvas → ESC/POS raster (GS v 0) par bandes de 128 lignes, en base64. */
  /* Canvas → octets pour l'imprimante, en base64.
     Q3Pro (service IPosPrinter, printRawData) : le service NE LIT PAS les commandes ESC/POS, il imprime
     tous les octets reçus comme des points (48 octets = 1 ligne de 384 points). Relevé le 20/11/2026 avec
     le ticket de réglage : chaque octet de commande en tête décalait l'image de 8 points vers la droite.
     → Variante 4 « image seule » : uniquement les lignes, sans aucune commande (défaut sur le TPE).
     Variantes 0 à 3 (ESC/POS) : pour RawBT ou une imprimante classique.
     Le réglage choisi est gardé dans localStorage « tb_impression_v2 ». */
  const VARIANTE_DEFAUT = 4;
  const variante = () => { const r = localStorage.getItem('tb_impression_v2'), v = Number(r); return r !== null && [0, 1, 2, 3, 4].includes(v) ? v : VARIANTE_DEFAUT; };
  function lignes(cv) {
    const w = cv.width, h = cv.height, bpr = w >> 3;
    const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    const noir = (x, y) => { const i = (y * w + x) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 150; };
    return { w, h, bpr, noir };
  }
  function octets(cv, v) {
    const { w, h, bpr, noir } = lignes(cv);
    if (v === 4) {   // image seule : lignes de points, puis quelques lignes blanches pour sortir le papier
      const bytes = [];
      for (let y = 0; y < h; y++) for (let i = 0; i < bpr; i++) {
        let b = 0; for (let k = 0; k < 8; k++) if (noir(i * 8 + k, y)) b |= 0x80 >> k;
        bytes.push(b);
      }
      for (let i = 0; i < bpr * 24; i++) bytes.push(0);
      return bytes;
    }
    const bytes = [0x1B, 0x40];
    if (v === 1) bytes.push(0x1D, 0x4C, 0x00, 0x00, 0x1D, 0x57, w & 255, w >> 8);   // marge gauche 0, largeur 384 points
    bytes.push(0x1B, 0x61, 0x00);
    if (v === 2) {
      bytes.push(0x1B, 0x33, 24);                                   // interligne = 24 points
      for (let y0 = 0; y0 < h; y0 += 24) {
        bytes.push(0x1B, 0x2A, 33, w & 255, w >> 8);
        for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) {
          let b = 0;
          for (let j = 0; j < 8; j++) { const y = y0 + k * 8 + j; if (y < h && noir(x, y)) b |= 0x80 >> j; }
          bytes.push(b);
        }
        bytes.push(0x0A);
      }
      bytes.push(0x1B, 0x32);
    } else {
      const decal = v === 3 ? 12 : 0;                               // 96 points = décalage observé sur le Q3Pro
      for (let y0 = 0; y0 < h; y0 += 128) {
        const bh = Math.min(128, h - y0);
        bytes.push(0x1D, 0x76, 0x30, 0x00, bpr & 255, bpr >> 8, bh & 255, bh >> 8);
        for (let y = y0; y < y0 + bh; y++) for (let i = 0; i < bpr; i++) {
          const xb = (i + decal) % bpr; let b = 0;
          for (let k = 0; k < 8; k++) if (noir(xb * 8 + k, y)) b |= 0x80 >> k;
          bytes.push(b);
        }
      }
    }
    bytes.push(0x1B, 0x64, 0x04);
    return bytes;
  }
  const b64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000)); return btoa(bin); };
  function escpos(cv, v) { return b64(octets(cv, v == null ? variante() : v)); }

  /* Ticket de réglage : les 4 variantes l'une sous l'autre, chacune avec une règle 0→9.
     La bonne variante est celle où la règle est droite et entière (0 à gauche, 9 à droite). */
  function regleCanvas(n) {
    const c = document.createElement('canvas'); c.width = W; c.height = 112;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, 112); x.fillStyle = '#000';
    x.font = `800 30px ${SANS}`; x.textAlign = 'left'; x.fillText('VARIANTE ' + n, 4, 32);
    x.fillRect(0, 44, W, 3); x.fillRect(0, 44, 3, 60); x.fillRect(W - 3, 44, 3, 60);
    x.font = `700 28px ${FONT}`; x.textAlign = 'center';
    for (let i = 0; i < 10; i++) x.fillText(String(i), 19 + i * 38.4, 86);
    x.fillRect(0, 104, W, 3);
    return c;
  }
  /* Ticket de réglage : la variante 4 (image seule) puis la variante 0, chacune envoyée à part. */
  function reglage() { return [4, 0].map(v => b64(octets(regleCanvas(v), v))); }

  const isAndroid = /Android/i.test(navigator.userAgent);
  const hasBridge = () => !!(window.Android && typeof window.Android.printRaw === 'function');

  /* Imprime un canvas selon le mode choisi. Renvoie le moyen utilisé. */
  async function imprimer(cv, mode) {
    if (mode === 'aucun') return 'aucun';
    if ((mode === 'auto' || mode === 'rawbt') && hasBridge()) { window.Android.printRaw('base64,' + escpos(cv)); return 'pont'; }   // TPE : variante réglée (4 par défaut)
    if (mode === 'rawbt' || (mode === 'auto' && isAndroid)) {
      // RawBT installé sur le TPE : Chrome lui passe le ticket directement
      window.location.href = 'intent:base64,' + escpos(cv, 0) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;';
      return 'rawbt';
    }
    const zone = document.getElementById('print-area');
    zone.innerHTML = '';
    const img = new Image(); img.src = cv.toDataURL('image/png'); zone.appendChild(img);
    await new Promise(ok => { img.onload = ok; setTimeout(ok, 500); });
    window.print();
    return 'navigateur';
  }

  function imprimerReglage() {
    if (!hasBridge()) return false;
    for (const r of reglage()) window.Android.printRaw('base64,' + r);
    return true;
  }
  window.TPE_TICKET = { venteCanvas, clotureCanvas, testCanvas, imprimer, escpos, imprimerReglage, variante, fmt, MODES };
})();
