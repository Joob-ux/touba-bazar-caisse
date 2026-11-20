/* Suivi à distance : envoie les ventes de cette caisse au serveur de suivi (suivi/ sur Render),
   où elles sont visibles avec un compte sur ordinateur ou téléphone. Même principe que T.B.T.L :
   aucun mot de passe sur la caisse ; au premier lancement elle crée sa propre clé secrète et demande
   l'autorisation ; le gérant touche « Autoriser » une seule fois sur la page de suivi (Compte → Caisses).
   Chaque vente part quelques secondes après l'encaissement ; sans internet elle attend et part dès que
   la connexion revient. Une annulation faite plus tard est envoyée aussi. Les ventes restent sur le TPE. */
(function () {
  const K_VENTES = 'tb_ventes_v1', K_CLOT = 'tb_clotures_v1', K_ZOK = 'tb_suivi_clotures_v1', K_OK = 'tb_suivi_envoyes_v1', K_APP = 'tb_appareil_v1', K_CLE = 'tb_caisse_cle_v1', K_STATUT = 'tb_caisse_statut_v1';
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const SUIVI_URL = get('tb_suivi_url') || window.SUIVI_URL;   // tb_suivi_url : seulement pour les essais

  const alea = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };
  let appareil = get(K_APP);
  if (!appareil) { appareil = 'caisse-' + alea(4); set(K_APP, appareil); }
  let cle = get(K_CLE);
  if (!cle) { cle = alea(32); set(K_CLE, cle); }
  const modele = (navigator.userAgent.match(/;\s*([^;()]+?)\s+Build\//) || [])[1];
  const nomAppareil = (modele ? modele + ' ' : 'Caisse ') + appareil.slice(-4);

  const statut = () => get(K_STATUT) || '';                 // '', 'attente', 'autorisee', 'refusee'
  const ventes = () => { try { const v = JSON.parse(get(K_VENTES)); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  /* Envoyées : { numéro: 0 (vente envoyée) | 1 (vente + annulation envoyées) } */
  const envoyes = () => { try { return JSON.parse(get(K_OK)) || {}; } catch (e) { return {}; } };
  const attente = () => { const ok = envoyes(); return ventes().filter(v => v && v.n && (!(v.n in ok) || (v.a && ok[v.n] !== 1))); };

  const clotures = () => { try { const v = JSON.parse(get(K_CLOT)); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const zEnvoyees = () => { try { return new Set(JSON.parse(get(K_ZOK)) || []); } catch (e) { return new Set(); } };
  const zAttente = () => { const ok = zEnvoyees(); return clotures().filter(c => c && c.z && !ok.has(c.z)); };
  let busy = false, lastErr = '', lastOk = null, lastTry = 0;

  async function call(path, body) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 70000);  // le serveur gratuit peut mettre ~1 min à se réveiller
    try {
      const h = { 'Content-Type': 'application/json' };
      if (statut() === 'autorisee') h.Authorization = 'Caisse ' + appareil + ':' + cle;
      const r = await fetch(SUIVI_URL + path, { method: 'POST', signal: ctl.signal, headers: h, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (path !== '/api/caisses/demande') {
        if (r.status === 401) set(K_STATUT, null);
        if (r.status === 403 && d.statut) set(K_STATUT, d.statut);
      }
      if (!r.ok) throw new Error(d.erreur || 'Erreur ' + r.status);
      return d;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('le serveur ne répond pas');
      if (e instanceof TypeError) throw new Error('pas de connexion internet');
      throw e;
    } finally { clearTimeout(tm); }
  }

  async function push() {
    if (busy || !SUIVI_URL) return;
    busy = true; lastTry = Date.now();
    try {
      if (statut() !== 'autorisee') {
        const d = await call('/api/caisses/demande', { appareil, cle, nom: nomAppareil });
        set(K_STATUT, d.statut);
      }
      if (statut() === 'autorisee') {
        const list = attente();
        for (let i = 0; i < list.length; i += 100) {
          const part = list.slice(i, i + 100);
          const d = await call('/api/ventes', { appareil, ventes: part });
          const ok = envoyes(), recues = new Set(d.ok || []);
          part.forEach(v => { if (recues.has(v.n)) ok[v.n] = v.a ? 1 : 0; });
          set(K_OK, JSON.stringify(ok));
        }
        const zs = zAttente();
        if (zs.length) {
          const d = await call('/api/clotures', { appareil, clotures: zs });
          const ok = zEnvoyees(); (d.ok || []).forEach(z => ok.add(z)); set(K_ZOK, JSON.stringify([...ok]));
        }
        if (list.length || zs.length) lastOk = new Date();
      }
      lastErr = '';
    } catch (e) { lastErr = e.message; }
    busy = false;
  }

  /* Toutes les 10 s : envoie ce qui attend ; en attente d'autorisation, vérifie si le gérant a autorisé.
     Après une erreur (pas d'internet…), nouvel essai au bout d'une minute. */
  function tick() {
    if (lastErr && Date.now() - lastTry < 60000) return;
    if (statut() !== 'autorisee' || attente().length || zAttente().length) push();
  }

  /* Phrase d'état pour le menu de la caisse */
  function etat() {
    const n = attente().length, st = statut();
    if (st === 'refusee') return 'Suivi à distance : caisse retirée par le gérant.';
    if (st !== 'autorisee') return lastErr ? `Suivi à distance : connexion impossible (${lastErr}).`
      : `Suivi à distance : caisse « ${nomAppareil} » en attente d'autorisation sur la page de suivi (Compte → Caisses).`;
    if (n) return `Suivi à distance : ${n} vente${n > 1 ? 's' : ''} en attente d'envoi${lastErr ? ' (' + lastErr + ')' : ''}.`;
    return 'Suivi à distance actif : chaque vente est envoyée automatiquement' + (lastOk ? ' (dernier envoi à ' + lastOk.toTimeString().slice(0, 5) + ').' : '.');
  }

  window.TB_SUIVI = { push: () => setTimeout(push, 800), etat };
  window.addEventListener('online', () => { lastErr = ''; push(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) push(); });
  setInterval(tick, 10000);
  setTimeout(push, 1500);
})();
