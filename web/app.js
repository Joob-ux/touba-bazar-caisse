/* Caisse Touba Bazar — page hébergée sur Vercel ; tout est enregistré sur le TPE, sans serveur ni base de données.
   Le caissier tape un montant, choisit Espèces / Wave / Orange Money, le ticket s'imprime.
   Chiffre d'affaires du jour en haut, historique jour par jour, clôture, export CSV.

   ⚠ Les ventes sont dans le localStorage de l'appli (clé tb_ventes_v1) : ne jamais changer
   cette clé ni le format sans migration, sinon l'historique du client est perdu. */
(function () {
  'use strict';
  const { venteCanvas, clotureCanvas, testCanvas, imprimer, fmt, MODES } = window.TPE_TICKET;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Stockage ----------
  const K = { ventes: 'tb_ventes_v1', boutique: 'tb_boutique_v1', prefs: 'tb_prefs_v1', seq: 'tb_seq_v1' };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { alert('Mémoire de la caisse pleine. Exportez les ventes (☰ → Exporter) et contactez Xelkoom Valley.'); return false; }
  }

  // Vente : { n: numéro, t: date ISO, m: montant, p: mode (cash|wave|orange), l: libellé, r: reçu, a: annulée }
  let ventes = load(K.ventes, []);
  let boutique = load(K.boutique, {
    company_name: 'TOUBA BAZAR', company_activity: '', company_address: '', company_phone: '',
    ticket_footer: 'Merci de votre visite !', logo_url: ''
  });
  let prefs = load(K.prefs, { print: 'auto' });
  let saisie = '';

  const jourDe = d => { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = () => jourDe(new Date());
  const numTxt = n => String(n).padStart(6, '0');
  const badge = m => `<span class="mp mp-${['cash', 'wave', 'orange'].includes(m) ? m : 'autre'}">${esc(MODES[m] || m)}</span>`;
  const heure = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  let toastT;
  function toast(msg, type) {
    const t = $('toast'); t.textContent = msg; t.className = type || ''; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, type === 'err' ? 5000 : 2500);
  }

  // ---------- Totaux ----------
  function totaux(liste) {
    const r = { nb: 0, total: 0, parMode: {}, annulees: 0 };
    for (const v of liste) {
      if (v.a) { r.annulees++; continue; }
      r.parMode[v.p] = r.parMode[v.p] || { nb: 0, total: 0 };
      r.parMode[v.p].nb++; r.parMode[v.p].total += v.m; r.nb++; r.total += v.m;
    }
    return r;
  }
  const ventesDu = date => ventes.filter(v => jourDe(v.t) === date);
  const modesTxt = b => ['cash', 'wave', 'orange'].map(m => `${m === 'orange' ? 'OM' : MODES[m]} ${fmt((b.parMode[m] || {}).total || 0)}`).join(' · ');

  function majEntete() {
    $('h-shop').textContent = boutique.company_name || 'Caisse';
    $('h-user').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function majCA() {
    const c = totaux(ventesDu(today()));
    $('ca-total').textContent = fmt(c.total) + ' F';
    $('ca-modes').textContent = `${c.nb} vente${c.nb > 1 ? 's' : ''} · ${modesTxt(c)}`;
  }

  // ---------- Saisie ----------
  function majMontant() {
    $('montant').textContent = fmt(Number(saisie) || 0) + ' F';
    document.querySelectorAll('.modes.bas button').forEach(b => { b.disabled = !(Number(saisie) > 0); });
  }
  const taper = k => { const s = (saisie + k).replace(/^0+/, ''); if (s.length <= 9) saisie = s; };
  $('pave').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.k === 'del') saisie = saisie.slice(0, -1); else taper(b.textContent);
    if (navigator.vibrate) navigator.vibrate(10);
    majMontant();
  };
  $('pave').addEventListener('contextmenu', e => e.preventDefault());
  const del = $('pave').querySelector('[data-k=del]'); let appui;
  del.addEventListener('pointerdown', () => { appui = setTimeout(() => { saisie = ''; majMontant(); }, 600); });
  ['pointerup', 'pointerleave'].forEach(ev => del.addEventListener(ev, () => clearTimeout(appui)));
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || [...document.querySelectorAll('.voile')].some(v => !v.hidden)) return;
    if (/^\d$/.test(e.key)) { taper(e.key); majMontant(); }
    else if (e.key === 'Backspace') { saisie = saisie.slice(0, -1); majMontant(); }
  });

  // ---------- Paiement ----------
  document.querySelectorAll('.modes.bas button').forEach(b => b.onclick = () => {
    const montant = Number(saisie); if (!(montant > 0)) return;
    if (b.dataset.mode === 'cash') return ouvrirRendu(montant);
    if (confirm(`Paiement ${MODES[b.dataset.mode]} de ${fmt(montant)} F reçu ?`)) encaisser(montant, b.dataset.mode, 0);
  });
  function ouvrirRendu(total) {
    $('r-total').textContent = fmt(total) + ' F';
    $('r-recu').value = '';
    const props = [total, ...[500, 1000, 2000, 5000, 10000].map(b => Math.ceil(total / b) * b)].filter((v, i, a) => v >= total && a.indexOf(v) === i).sort((a, b) => a - b).slice(0, 4);
    $('r-rapides').innerHTML = props.map(v => `<button data-v="${v}" class="num">${v === total ? 'Compte juste' : fmt(v)}</button>`).join('');
    majRendu(); ouvrir('v-rendu');
  }
  function majRendu() {
    const total = Number(saisie) || 0, recu = Number($('r-recu').value) || 0, m = $('r-monnaie');
    if (!recu) { m.className = 'monnaie'; m.innerHTML = 'Montant reçu du client (facultatif)'; return; }
    if (recu < total) { m.className = 'monnaie manque'; m.innerHTML = `Il manque <b class="num">${fmt(total - recu)} F</b>`; }
    else { m.className = 'monnaie'; m.innerHTML = `Monnaie à rendre : <b class="num">${fmt(recu - total)} F</b>`; }
  }
  $('r-recu').oninput = majRendu;
  $('r-recu').onkeydown = e => { if (e.key === 'Enter') $('r-ok').click(); };
  $('r-rapides').onclick = e => { const b = e.target.closest('button'); if (b) { $('r-recu').value = b.dataset.v; majRendu(); } };
  $('r-ok').onclick = () => {
    const total = Number(saisie) || 0, recu = Number($('r-recu').value) || 0;
    if (recu && recu < total) return toast('Montant reçu insuffisant', 'err');
    encaisser(total, 'cash', recu);
  };

  let occupe = false;
  function encaisser(montant, mode, recu) {
    if (occupe || !(montant > 0)) return;
    occupe = true;
    try {
      // Numéro continu, jamais réutilisé (même après annulation)
      const n = Math.max(Number(localStorage.getItem(K.seq)) || 0, ventes.reduce((m, v) => Math.max(m, v.n), 0)) + 1;
      const v = { n, t: new Date().toISOString(), m: montant, p: mode, l: $('note').value.trim() };
      if (recu) v.r = recu;
      ventes.push(v);
      if (!save(K.ventes, ventes)) { ventes.pop(); return; }
      localStorage.setItem(K.seq, String(n));
      saisie = ''; $('note').value = ''; majMontant(); majCA(); fermer('v-rendu');
      toast(`${fmt(montant)} F encaissés`, 'ok');
      imprimerVente(v, false);
    } finally { occupe = false; }
  }

  const venteTicket = v => ({ num: numTxt(v.n), date: v.t, items: [], note: v.l, total: v.m, mode: v.p, recu: v.r || 0, rendu: v.r ? v.r - v.m : 0 });
  async function imprimerVente(v, duplicata) {
    try { await imprimer(await venteCanvas(boutique, venteTicket(v), duplicata), prefs.print); }
    catch (e) { toast('Impression impossible : ' + e.message, 'err'); }
  }
  const modeImpr = () => prefs.print === 'aucun' ? 'auto' : prefs.print;

  // ---------- Panneaux ----------
  function ouvrir(id) { $(id).hidden = false; }
  function fermer(id) { $(id).hidden = true; }
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => fermer(b.dataset.close));
  document.querySelectorAll('.voile').forEach(v => v.addEventListener('click', e => { if (e.target === v) v.hidden = true; }));

  $('btn-menu').onclick = () => {
    $('m-print').value = prefs.print;
    const taille = (localStorage.getItem(K.ventes) || '').length;
    $('m-info').textContent = `${ventes.length} ventes enregistrées sur ce TPE · mémoire utilisée ${Math.round(taille / 1024)} Ko sur ~5 000 Ko`;
    ouvrir('v-menu');
  };
  $('m-print').onchange = () => { prefs.print = $('m-print').value; save(K.prefs, prefs); toast('Mode d\'impression enregistré', 'ok'); };
  $('m-test').onclick = async () => { fermer('v-menu'); try { await imprimer(await testCanvas(boutique), modeImpr()); } catch (e) { toast('Impression impossible : ' + e.message, 'err'); } };

  // ---------- Infos boutique ----------
  let logoTmp = null;
  function ouvrirBoutique() {
    $('b-nom').value = boutique.company_name || ''; $('b-act').value = boutique.company_activity || '';
    $('b-adr').value = boutique.company_address || ''; $('b-tel').value = boutique.company_phone || '';
    $('b-pied').value = boutique.ticket_footer || ''; $('b-logo').value = '';
    logoTmp = boutique.logo_url || '';
    apercuLogo(); ouvrir('v-boutique');
  }
  function apercuLogo() {
    $('b-logo-apercu').innerHTML = logoTmp ? `<img src="${logoTmp}" alt="Logo"><button type="button" class="btn-second" id="b-logo-suppr" style="width:auto;padding:8px 12px">Retirer le logo</button>` : '';
    const s = $('b-logo-suppr'); if (s) s.onclick = () => { logoTmp = ''; apercuLogo(); };
  }
  $('m-boutique').onclick = () => { fermer('v-menu'); ouvrirBoutique(); };
  $('b-logo').onchange = () => {
    const f = $('b-logo').files[0]; if (!f) return;
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => {
      const r = Math.min(384 / img.width, 150 / img.height, 1);
      const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
      logoTmp = c.toDataURL('image/png'); URL.revokeObjectURL(url); apercuLogo();
    };
    img.onerror = () => toast('Image illisible', 'err');
    img.src = url;
  };
  $('b-ok').onclick = () => {
    const nom = $('b-nom').value.trim();
    if (!nom) return toast('Le nom de la boutique est obligatoire', 'err');
    boutique = { company_name: nom, company_activity: $('b-act').value.trim(), company_address: $('b-adr').value.trim(),
      company_phone: $('b-tel').value.trim(), ticket_footer: $('b-pied').value.trim(), logo_url: logoTmp || '' };
    if (save(K.boutique, boutique)) { fermer('v-boutique'); majEntete(); toast('Infos enregistrées', 'ok'); }
  };

  // ---------- Historique ----------
  const iso = d => jourDe(d);
  const dateLongue = s => new Date(s + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  let histo = null, jourOuvert = null;
  function periode(p) {
    const n = new Date(); let du, au = iso(n);
    if (p === 'mois') du = iso(new Date(n.getFullYear(), n.getMonth(), 1));
    else if (p === 'moisp') { du = iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)); au = iso(new Date(n.getFullYear(), n.getMonth(), 0)); }
    else du = iso(new Date(n.getTime() - (Number(p) - 1) * 864e5));
    return { du, au };
  }
  function chargerHisto(du, au) {
    $('h-du').value = du; $('h-au').value = au;
    const liste = ventes.filter(v => { const j = jourDe(v.t); return j >= du && j <= au; });
    const parJour = new Map();
    for (const v of liste) { const j = jourDe(v.t); if (!parJour.has(j)) parJour.set(j, []); parJour.get(j).push(v); }
    const jours = [...parJour.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, l]) => Object.assign({ date }, totaux(l)));
    histo = Object.assign({ du, au, jours }, totaux(liste));
    const max = Math.max(1, ...jours.map(j => j.total));
    const nbJ = jours.filter(j => j.nb).length;
    $('h-resultat').innerHTML = `<div class="h-total"><div class="d">Du ${new Date(du + 'T12:00').toLocaleDateString('fr-FR')} au ${new Date(au + 'T12:00').toLocaleDateString('fr-FR')}</div>
        <div class="t num">${fmt(histo.total)} F</div>
        <div class="d num">${histo.nb} ventes · ${modesTxt(histo)}${nbJ ? ` · moyenne ${fmt(histo.total / nbJ)} F/jour de vente` : ''}</div></div>` +
      (jours.length ? jours.map(j => `<button class="jour" data-j="${j.date}"><div class="info"><b>${dateLongue(j.date)}</b>
          <small class="num">${j.nb} vente${j.nb > 1 ? 's' : ''} · ${modesTxt(j)}${j.annulees ? ` · ${j.annulees} annulée${j.annulees > 1 ? 's' : ''}` : ''}</small><div class="barre-j" style="width:${Math.max(3, j.total / max * 100)}%"></div></div>
          <span class="m num">${fmt(j.total)} F</span><span class="fl">›</span></button>`).join('')
        : '<div class="vide">Aucune vente sur cette période</div>');
  }
  function ouvrirHisto() {
    ouvrir('v-histo');
    document.querySelectorAll('#h-periodes button').forEach(b => b.classList.toggle('on', b.dataset.p === '30'));
    const p = periode('30'); chargerHisto(p.du, p.au);
  }
  $('m-histo').onclick = () => { fermer('v-menu'); ouvrirHisto(); };
  $('ca').onclick = () => ouvrirHisto();
  $('h-periodes').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#h-periodes button').forEach(x => x.classList.toggle('on', x === b));
    const p = periode(b.dataset.p); chargerHisto(p.du, p.au);
  };
  $('h-ok').onclick = () => {
    const du = $('h-du').value, au = $('h-au').value;
    if (!du || !au || du > au) return toast('Choisissez une période valide', 'err');
    document.querySelectorAll('#h-periodes button').forEach(x => x.classList.remove('on'));
    chargerHisto(du, au);
  };
  $('h-resultat').onclick = e => { const b = e.target.closest('[data-j]'); if (b) ouvrirJour(b.dataset.j); };

  function ouvrirJour(date) {
    $('j-titre').textContent = dateLongue(date);
    jourOuvert = { date, filtre: (jourOuvert && jourOuvert.date === date) ? jourOuvert.filtre : '' };
    rendreJour(); ouvrir('v-jour');
  }
  function rendreJour() {
    const { date, filtre } = jourOuvert;
    const l = ventesDu(date).slice().reverse();
    const actives = l.filter(v => !v.a);
    $('j-filtres').innerHTML = ['', 'cash', 'wave', 'orange'].map(m => {
      const t = actives.filter(v => !m || v.p === m).reduce((s, v) => s + v.m, 0);
      return `<button data-f="${m}" class="${m === filtre ? 'on' : ''}">${m ? MODES[m] : 'Tous'} <span class="n num">${fmt(t)}</span></button>`;
    }).join('');
    const vis = l.filter(v => !filtre || v.p === filtre);
    $('j-liste').innerHTML = vis.length ? vis.map(v => `<div class="vente"><div class="info"><b class="num ${v.a ? 'annulee' : ''}">${fmt(v.m)} F</b> ${badge(v.p)}${v.a ? ' <span class="etat err">Annulée</span>' : ''}
        <small>${heure(v.t)} · N° ${numTxt(v.n)}${v.l ? ' · ' + esc(v.l) : ''}</small></div>
        ${v.a ? '' : `<button data-n="${v.n}" data-a="print">Ticket</button><button data-n="${v.n}" data-a="annul" style="color:var(--rouge)">Annuler</button>`}</div>`).join('')
      : '<div class="vide">Aucune vente</div>';
  }
  $('j-filtres').onclick = e => { const b = e.target.closest('button'); if (b && jourOuvert) { jourOuvert.filtre = b.dataset.f; rendreJour(); } };
  $('j-liste').onclick = e => {
    const b = e.target.closest('button[data-n]'); if (!b) return;
    const v = ventes.find(x => x.n == b.dataset.n); if (!v) return;
    if (b.dataset.a === 'print') return imprimerVente(v, true);
    if (b.dataset.a === 'annul' && confirm(`Annuler la vente N° ${numTxt(v.n)} de ${fmt(v.m)} F (${MODES[v.p]}) ? Elle ne comptera plus dans le chiffre d'affaires.`)) {
      v.a = new Date().toISOString(); save(K.ventes, ventes);
      rendreJour(); majCA(); if (histo) chargerHisto(histo.du, histo.au);
      toast('Vente annulée', 'ok');
    }
  };
  $('j-print').onclick = async () => {
    if (!jourOuvert) return;
    const r = Object.assign({ date: jourOuvert.date }, totaux(ventesDu(jourOuvert.date)));
    try { await imprimer(await clotureCanvas(boutique, { date: r.date, boutique: r, appareil: null, attente: 0, titre: "CHIFFRE D'AFFAIRES" }), modeImpr()); }
    catch (e) { toast('Impression impossible : ' + e.message, 'err'); }
  };

  // ---------- Clôture ----------
  let derniereCloture = null;
  $('m-cloture').onclick = () => {
    fermer('v-menu');
    const date = today(), b = totaux(ventesDu(date));
    derniereCloture = { date, boutique: b, appareil: null, attente: 0 };
    $('cloture-corps').innerHTML = `<h3 style="font-size:15px;margin:12px 0 4px">${dateLongue(date)}</h3><table class="bilan">
      ${['cash', 'wave', 'orange'].map(m => { const x = b.parMode[m] || { nb: 0, total: 0 }; return `<tr><td>${MODES[m]} (${x.nb})</td><td class="num">${fmt(x.total)} F</td></tr>`; }).join('')}
      <tr class="tot"><td>Total (${b.nb} ventes)</td><td class="num">${fmt(b.total)} F</td></tr></table>
      ${b.annulees ? `<p style="color:var(--gris);font-size:14px">${b.annulees} vente(s) annulée(s), non comptée(s).</p>` : ''}`;
    ouvrir('v-cloture');
  };
  $('c-print').onclick = async () => {
    if (!derniereCloture) return;
    try { await imprimer(await clotureCanvas(boutique, derniereCloture), modeImpr()); }
    catch (e) { toast('Impression impossible : ' + e.message, 'err'); }
  };

  // ---------- Export CSV (sauvegarde / envoi au patron) ----------
  $('m-export').onclick = () => {
    fermer('v-menu');
    if (!ventes.length) return toast('Aucune vente à exporter', 'err');
    const lignes = [['N°', 'Date', 'Heure', 'Montant (F CFA)', 'Mode de paiement', 'Libellé', 'Statut']];
    for (const v of ventes) lignes.push([numTxt(v.n), new Date(v.t).toLocaleDateString('fr-FR'), heure(v.t), v.m, MODES[v.p] || v.p, v.l || '', v.a ? 'Annulée' : 'Validée']);
    const csv = '﻿' + lignes.map(l => l.map(c => /[;"\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(';')).join('\r\n');
    const nom = `ventes-${(boutique.company_name || 'caisse').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${today()}.csv`;
    if (window.Android && typeof window.Android.partager === 'function') { window.Android.partager(nom, csv); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = nom; a.click();
  };

  // ---------- Démarrage ----------
  $('app').hidden = false;
  majEntete(); majMontant(); majCA();
  setInterval(() => { majEntete(); majCA(); }, 60000);   // passage à minuit
  if (!localStorage.getItem(K.boutique)) setTimeout(ouvrirBoutique, 300);   // premier lancement : infos du ticket

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  window.TPE_DEBUG = { get ventes() { return ventes; } };
})();
