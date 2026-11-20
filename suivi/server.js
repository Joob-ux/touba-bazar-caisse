/* Suivi Touba Bazar : reçoit les ventes envoyées par la caisse TPE et les affiche sur la page web
   (ordinateur ou téléphone) avec un compte. Même principe que le suivi T.B.T.L.
   - POST /api/setup      : premier mot de passe du compte ADMIN_EMAIL (une seule fois)
   - POST /api/login      : email + mot de passe → jeton (gardé sur l'appareil)
   - POST /api/ventes     : la caisse envoie ses ventes (ajout, ou annulation d'une vente déjà envoyée)
   - POST /api/caisses/demande : une caisse demande à envoyer ses ventes SANS mot de passe ;
     le gérant l'autorise une fois depuis la page (GET /api/caisses, POST /api/caisses/autoriser|retirer)
   - GET  /api/version    : change dès qu'une vente arrive (la page se met à jour toute seule)
   - GET  /api/ventes     : ventes d'une période (filtre par mode de paiement)
   - GET  /api/resume     : totaux par jour et par mode
   - GET  /api/moi, POST /api/logout, POST /api/mdp, GET/POST /api/comptes, POST /api/comptes/supprimer
   Rôles : « gerant » (tout) et « proprietaire » (lecture seule).
   Heure de Dakar = UTC : les dates des ventes sont gardées en UTC. */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const mysql = require('mysql2/promise');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://touba-bazar-caisse.vercel.app').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const TOKEN_DAYS = 365;

let pool;
async function initDb() {
  const base = { host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
  const name = process.env.DB_NAME || 'toubabazar_db';
  if (!/^\w+$/.test(name)) throw new Error('DB_NAME invalide');
  const c = await mysql.createConnection(base);
  await c.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await c.end();
  pool = mysql.createPool({ ...base, database: name, connectionLimit: 5, dateStrings: true, charset: 'utf8mb4' });
  await pool.query(`CREATE TABLE IF NOT EXISTS utilisateurs (
    id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE, mdp VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'gerant', cree_le DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  /* Migration : la table existait sans « role ». Les comptes déjà présents deviennent « gerant » (valeur par défaut). */
  const [col] = await pool.query(`SELECT COUNT(*) n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'utilisateurs' AND COLUMN_NAME = 'role'`);
  if (!+col[0].n) await pool.query(`ALTER TABLE utilisateurs ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'gerant' AFTER mdp`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jetons (
    hash CHAR(64) PRIMARY KEY, utilisateur_id INT NOT NULL, appareil VARCHAR(80), expire DATETIME NOT NULL,
    cree_le DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX (utilisateur_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ventes (
    id INT AUTO_INCREMENT PRIMARY KEY, appareil VARCHAR(80) NOT NULL, num INT NOT NULL,
    date_vente DATETIME NOT NULL, montant BIGINT NOT NULL DEFAULT 0, mode VARCHAR(12) NOT NULL,
    libelle VARCHAR(200), annulee_le DATETIME NULL, recu_le DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY appareil_num (appareil, num), INDEX (date_vente))`);
  /* Caisses autorisées à envoyer sans mot de passe : la caisse crée sa propre clé secrète,
     seule son empreinte est gardée ici ; le gérant autorise la caisse une fois. */
  await pool.query(`CREATE TABLE IF NOT EXISTS caisses (
    appareil VARCHAR(80) PRIMARY KEY, hash CHAR(64) NOT NULL, nom VARCHAR(80),
    statut VARCHAR(12) NOT NULL DEFAULT 'attente', cree_le DATETIME DEFAULT CURRENT_TIMESTAMP, vu_le DATETIME NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS echecs (
    cle VARCHAR(190) PRIMARY KEY, nb INT NOT NULL, jusqu_a DATETIME NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reglages (cle VARCHAR(60) PRIMARY KEY, valeur VARCHAR(255))`);
  /* Mot de passe oublié : mettre une NOUVELLE valeur dans la variable RESET_MDP_ADMIN (tableau de bord Render).
     Au démarrage, le mot de passe du gérant (ADMIN_EMAIL) est effacé une seule fois pour cette valeur ;
     la page de suivi propose alors de le recréer. Les caisses restent connectées (leurs jetons sont gardés). */
  const code = String(process.env.RESET_MDP_ADMIN || '').trim();
  if (code && ADMIN_EMAIL) {
    const [r] = await pool.query("SELECT valeur FROM reglages WHERE cle = 'reset_mdp'");
    if (!r.length || r[0].valeur !== code) {
      await pool.query("UPDATE utilisateurs SET mdp = '' WHERE email = ?", [ADMIN_EMAIL]);
      await pool.query("REPLACE INTO reglages (cle, valeur) VALUES ('reset_mdp', ?)", [code]);
      await pool.query('DELETE FROM echecs');
      console.log('Mot de passe du gérant effacé : à recréer depuis la page de suivi.');
    }
  }
}
/* Faut-il créer (ou recréer) le mot de passe du gérant ? */
async function doitCreerMdp() {
  const [r] = await pool.query("SELECT COUNT(*) n, SUM(email = ? AND mdp = '') vide FROM utilisateurs", [ADMIN_EMAIL]);
  return +r[0].n === 0 || +r[0].vide > 0;
}

/* Mots de passe : scrypt (intégré à Node) */
function hashMdp(mdp) {
  const sel = crypto.randomBytes(16);
  return 'scrypt$' + sel.toString('hex') + '$' + crypto.scryptSync(mdp, sel, 64).toString('hex');
}
function verifMdp(mdp, stocke) {
  const [, sel, h] = String(stocke).split('$');
  if (!sel || !h) return false;
  const calc = crypto.scryptSync(mdp, Buffer.from(sel, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const mdpValide = m => m.length >= 8 && /\d/.test(m) && /[a-z]/i.test(m);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* La caisse (autre adresse) a le droit d'appeler l'API */
app.use('/api', (req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  res.set('Cache-Control', 'no-store');
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ erreur: 'Erreur du serveur, réessayez.' }); });

async function auth(req, res, next) {
  try {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (t.length < 40) return res.status(401).json({ erreur: 'Connexion nécessaire.' });
    const [r] = await pool.query('SELECT j.utilisateur_id, u.email, u.role FROM jetons j JOIN utilisateurs u ON u.id = j.utilisateur_id WHERE j.hash = ? AND j.expire > NOW()', [sha(t)]);
    if (!r.length) return res.status(401).json({ erreur: 'Connexion expirée, reconnectez-vous.' });
    req.user = r[0]; next();
  } catch (e) { console.error(e); res.status(500).json({ erreur: 'Erreur du serveur.' }); }
}

/* Réservé au gérant (vérifié ici, côté serveur, pas seulement dans la page) */
function gerant(req, res, next) {
  if (req.user && req.user.role === 'gerant') return next();
  res.status(403).json({ erreur: 'Réservé au gérant : ce compte est en lecture seule.' });
}

/* Blocage 15 min après 5 échecs (par email et par adresse IP) */
async function bloque(cle) {
  const [r] = await pool.query('SELECT jusqu_a FROM echecs WHERE cle = ? AND jusqu_a > NOW()', [cle]);
  return r.length > 0;
}
async function echec(cle) {
  await pool.query(`INSERT INTO echecs (cle, nb) VALUES (?, 1) ON DUPLICATE KEY UPDATE nb = IF(jusqu_a IS NOT NULL AND jusqu_a <= NOW(), 1, nb + 1),
    jusqu_a = IF(nb >= 5, NOW() + INTERVAL 15 MINUTE, IF(jusqu_a <= NOW(), NULL, jusqu_a))`, [cle]);
}

/* Envoi des ventes : soit une caisse autorisée (en-tête « Authorization: Caisse <appareil>:<clé> »),
   soit un compte gérant (ancienne méthode email + mot de passe, toujours acceptée). */
async function envoi(req, res, next) {
  const h = String(req.headers.authorization || '');
  if (!/^Caisse\s+/i.test(h)) return auth(req, res, () => gerant(req, res, next));
  try {
    const [app_, cle] = h.replace(/^Caisse\s+/i, '').split(':');
    if (!app_ || !cle || cle.length < 40) return res.status(401).json({ erreur: 'Caisse non reconnue.' });
    const [r] = await pool.query('SELECT statut FROM caisses WHERE appareil = ? AND hash = ?', [app_, sha(cle)]);
    if (!r.length) return res.status(401).json({ erreur: 'Caisse non reconnue.' });
    if (r[0].statut !== 'autorisee') return res.status(403).json({ erreur: r[0].statut === 'refusee' ? 'Caisse retirée par le gérant.' : 'Caisse en attente d\'autorisation du gérant.', statut: r[0].statut });
    if (txt(req.body.appareil, 80) !== app_) return res.status(403).json({ erreur: 'Appareil différent de la caisse autorisée.' });
    pool.query('UPDATE caisses SET vu_le = NOW() WHERE appareil = ?', [app_]).catch(() => {});
    req.caisse = app_; next();
  } catch (e) { console.error(e); res.status(500).json({ erreur: 'Erreur du serveur.' }); }
}

/* Numéro de version des données : la page du gérant le consulte toutes les quelques secondes
   et ne recharge la liste que s'il a changé. */
let version = Date.now();
const changement = () => { version++; };

async function nouveauJeton(uid, appareil) {
  const t = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO jetons (hash, utilisateur_id, appareil, expire) VALUES (?, ?, ?, NOW() + INTERVAL ? DAY)', [sha(t), uid, String(appareil || '').slice(0, 80), TOKEN_DAYS]);
  return t;
}

app.get('/api/etat', wrap(async (req, res) => {
  res.json({ ok: true, configure: !(await doitCreerMdp()) });
}));

/* Premier mot de passe (ou nouveau après RESET_MDP_ADMIN) : seulement pour ADMIN_EMAIL */
app.post('/api/setup', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), mdp = String(req.body.mdp || '');
  if (!ADMIN_EMAIL) return res.status(403).json({ erreur: 'ADMIN_EMAIL non défini sur le serveur.' });
  if (email !== ADMIN_EMAIL) return res.status(403).json({ erreur: 'Cet email n\'est pas celui du gérant.' });
  if (!mdpValide(mdp)) return res.status(400).json({ erreur: 'Mot de passe : au moins 8 caractères, avec des lettres et un chiffre.' });
  if (!(await doitCreerMdp())) return res.status(409).json({ erreur: 'Le compte existe déjà : connectez-vous.' });
  const [ex] = await pool.query('SELECT id FROM utilisateurs WHERE email = ?', [email]);
  let id;
  if (ex.length) { id = ex[0].id; await pool.query("UPDATE utilisateurs SET mdp = ?, role = 'gerant' WHERE id = ?", [hashMdp(mdp), id]); }
  else { const [ins] = await pool.query('INSERT INTO utilisateurs (email, mdp, role) VALUES (?, ?, \'gerant\')', [email, hashMdp(mdp)]); id = ins.insertId; }
  res.json({ jeton: await nouveauJeton(id, req.body.appareil), email, role: 'gerant' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), mdp = String(req.body.mdp || '');
  const kE = 'e:' + email, kI = 'i:' + req.ip;
  if (await bloque(kE) || await bloque(kI)) return res.status(429).json({ erreur: 'Trop d\'essais. Réessayez dans 15 minutes.' });
  const [r] = await pool.query('SELECT id, mdp, role FROM utilisateurs WHERE email = ?', [email]);
  if (!r.length || !verifMdp(mdp, r[0].mdp)) { await echec(kE); await echec(kI); return res.status(401).json({ erreur: 'Email ou mot de passe incorrect.' }); }
  await pool.query('DELETE FROM echecs WHERE cle IN (?, ?)', [kE, kI]);
  res.json({ jeton: await nouveauJeton(r[0].id, req.body.appareil), email, role: r[0].role });
}));

app.get('/api/moi', auth, (req, res) => res.json({ email: req.user.email, role: req.user.role }));

app.post('/api/logout', auth, wrap(async (req, res) => {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  await pool.query('DELETE FROM jetons WHERE hash = ?', [sha(t)]);
  res.json({ ok: true });
}));

app.post('/api/mdp', auth, wrap(async (req, res) => {
  const ancien = String(req.body.ancien || ''), nouveau = String(req.body.nouveau || '');
  const [r] = await pool.query('SELECT mdp FROM utilisateurs WHERE id = ?', [req.user.utilisateur_id]);
  if (!r.length || !verifMdp(ancien, r[0].mdp)) return res.status(401).json({ erreur: 'Ancien mot de passe incorrect.' });
  if (!mdpValide(nouveau)) return res.status(400).json({ erreur: 'Nouveau mot de passe : au moins 8 caractères, avec des lettres et un chiffre.' });
  await pool.query('UPDATE utilisateurs SET mdp = ? WHERE id = ?', [hashMdp(nouveau), req.user.utilisateur_id]);
  res.json({ ok: true });
}));

/* Comptes : le gérant liste, ajoute un propriétaire (lecture seule), supprime un compte */
app.get('/api/comptes', auth, gerant, wrap(async (req, res) => {
  const [rows] = await pool.query(`SELECT u.id, u.email, u.role, u.cree_le,
      (SELECT MAX(j.cree_le) FROM jetons j WHERE j.utilisateur_id = u.id) AS derniere_connexion
    FROM utilisateurs u ORDER BY u.role = 'gerant' DESC, u.email`);
  res.json({ comptes: rows.map(r => ({ ...r, moi: r.id === req.user.utilisateur_id })) });
}));

app.post('/api/comptes', auth, gerant, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), mdp = String(req.body.mdp || '');
  if (email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erreur: 'Email invalide.' });
  if (!mdpValide(mdp)) return res.status(400).json({ erreur: 'Mot de passe : au moins 8 caractères, avec des lettres et un chiffre.' });
  try {
    const [ins] = await pool.query('INSERT INTO utilisateurs (email, mdp, role) VALUES (?, ?, \'proprietaire\')', [email, hashMdp(mdp)]);
    res.json({ ok: true, id: ins.insertId, email, role: 'proprietaire' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ erreur: 'Un compte existe déjà avec cet email.' });
    throw e;
  }
}));

app.post('/api/comptes/supprimer', auth, gerant, wrap(async (req, res) => {
  const id = Number(req.body.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erreur: 'Compte manquant.' });
  if (id === req.user.utilisateur_id) return res.status(400).json({ erreur: 'Vous ne pouvez pas supprimer votre propre compte.' });
  /* Jetons d'abord : l'accès est coupé tout de suite, sur tous les appareils */
  await pool.query('DELETE FROM jetons WHERE utilisateur_id = ?', [id]);
  const [del] = await pool.query('DELETE FROM utilisateurs WHERE id = ?', [id]);
  if (!del.affectedRows) return res.status(404).json({ erreur: 'Compte introuvable.' });
  res.json({ ok: true });
}));

/* La caisse envoie ses reçus. « appareil » distingue les caisses (chaque appareil a sa numérotation). */
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function dateSql(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}` : null;
}
const MODES = ['cash', 'wave', 'orange'];
/* Ventes de la caisse : { n, t (ISO), m, p (cash|wave|orange), l, a (date d'annulation ou absent) }.
   Une vente déjà reçue n'est jamais effacée ; seule l'annulation peut s'ajouter. */
app.post('/api/ventes', envoi, wrap(async (req, res) => {
  const appareil = txt(req.body.appareil, 80), list = Array.isArray(req.body.ventes) ? req.body.ventes.slice(0, 500) : [];
  if (!appareil) return res.status(400).json({ erreur: 'Appareil manquant.' });
  const ok = [];
  for (const v of list) {
    const n = Math.floor(Number(v.n)), d = dateSql(v.t), m = Math.floor(Number(v.m)), p = String(v.p || '');
    if (!(n > 0) || !d || !(m > 0) || m > 1e12 || !MODES.includes(p)) continue;
    const annul = v.a ? (dateSql(v.a) || d) : null;
    await pool.query(`INSERT INTO ventes (appareil, num, date_vente, montant, mode, libelle, annulee_le) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE annulee_le = COALESCE(annulee_le, VALUES(annulee_le))`,
      [appareil, n, d, m, p, txt(v.l, 200) || null, annul]);
    ok.push(n);
  }
  if (ok.length) changement();
  res.json({ ok });
}));

/* Une caisse demande l'autorisation d'envoyer ses ventes (aucun mot de passe sur la caisse).
   Réponse : statut « attente », « autorisee » ou « refusee ». */
app.post('/api/caisses/demande', wrap(async (req, res) => {
  const appareil = txt(req.body.appareil, 80), cle = String(req.body.cle || ''), nom = txt(req.body.nom, 80) || null;
  if (!/^[\w-]{4,80}$/.test(appareil) || cle.length < 40 || cle.length > 200) return res.status(400).json({ erreur: 'Demande invalide.' });
  const [r] = await pool.query('SELECT hash, statut FROM caisses WHERE appareil = ?', [appareil]);
  if (r.length) {
    if (r[0].hash !== sha(cle)) {
      if (r[0].statut !== 'attente') return res.status(403).json({ erreur: 'Cet appareil est déjà enregistré avec une autre clé.' });
      await pool.query('UPDATE caisses SET hash = ?, nom = COALESCE(?, nom), vu_le = NOW() WHERE appareil = ?', [sha(cle), nom, appareil]);
    } else await pool.query('UPDATE caisses SET vu_le = NOW() WHERE appareil = ?', [appareil]);
    return res.json({ statut: r[0].statut });
  }
  const ip = 'demande:' + req.ip;
  if (await bloque(ip)) return res.status(429).json({ erreur: 'Trop de demandes, réessayez plus tard.' });
  const [n] = await pool.query("SELECT COUNT(*) n FROM caisses WHERE statut = 'attente'");
  if (+n[0].n >= 10) return res.status(429).json({ erreur: 'Trop de caisses en attente : le gérant doit d\'abord répondre.' });
  await echec(ip);   // compte les demandes par adresse (5 nouvelles caisses max, puis pause de 15 min)
  await pool.query('INSERT INTO caisses (appareil, hash, nom, vu_le) VALUES (?, ?, ?, NOW())', [appareil, sha(cle), nom]);
  changement();
  res.json({ statut: 'attente' });
}));

app.get('/api/caisses', auth, gerant, wrap(async (req, res) => {
  const [rows] = await pool.query(`SELECT c.appareil, c.nom, c.statut, c.cree_le, c.vu_le,
      (SELECT COUNT(*) FROM ventes v WHERE v.appareil = c.appareil) AS nb
    FROM caisses c ORDER BY FIELD(c.statut, 'attente', 'autorisee', 'refusee'), c.cree_le DESC`);
  res.json({ caisses: rows.map(r => ({ ...r, nb: +r.nb })) });
}));
async function statutCaisse(req, res, statut) {
  const appareil = txt(req.body.appareil, 80);
  const [u] = await pool.query('UPDATE caisses SET statut = ?, nom = COALESCE(?, nom) WHERE appareil = ?', [statut, txt(req.body.nom, 80) || null, appareil]);
  if (!u.affectedRows) return res.status(404).json({ erreur: 'Caisse introuvable.' });
  changement(); res.json({ ok: true });
}
app.post('/api/caisses/autoriser', auth, gerant, wrap((req, res) => statutCaisse(req, res, 'autorisee')));
app.post('/api/caisses/retirer', auth, gerant, wrap((req, res) => statutCaisse(req, res, 'refusee')));

/* Version des données + caisses en attente (pour la page du gérant) */
app.get('/api/version', auth, wrap(async (req, res) => {
  let attente = 0;
  if (req.user.role === 'gerant') { const [n] = await pool.query("SELECT COUNT(*) n FROM caisses WHERE statut = 'attente'"); attente = +n[0].n; }
  res.json({ v: version, attente });
}));

const jour = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
app.get('/api/ventes', auth, wrap(async (req, res) => {
  const du = jour(req.query.du), au = jour(req.query.au) || du;
  if (!du) return res.status(400).json({ erreur: 'Date manquante.' });
  const params = [du + ' 00:00:00', au + ' 23:59:59'];
  let sql = `SELECT appareil, num, DATE_FORMAT(date_vente, '%Y-%m-%dT%H:%i:%sZ') AS date, montant, mode, libelle,
      DATE_FORMAT(annulee_le, '%Y-%m-%dT%H:%i:%sZ') AS annulee FROM ventes WHERE date_vente BETWEEN ? AND ?`;
  if (MODES.includes(req.query.mode)) { sql += ' AND mode = ?'; params.push(req.query.mode); }
  const q = txt(req.query.q, 100);
  if (q) { sql += ' AND (libelle LIKE ? OR num = ?)'; params.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%', Number(q) || -1); }
  sql += ' ORDER BY date_vente DESC, id DESC LIMIT 3000';
  const [rows] = await pool.query(sql, params);
  res.json({ ventes: rows.map(r => ({ ...r, montant: +r.montant })) });
}));

/* Totaux par jour et par mode de paiement (ventes annulées non comptées) */
app.get('/api/resume', auth, wrap(async (req, res) => {
  const du = jour(req.query.du), au = jour(req.query.au) || du;
  if (!du) return res.status(400).json({ erreur: 'Date manquante.' });
  const [rows] = await pool.query(`SELECT DATE_FORMAT(date_vente, '%Y-%m-%d') AS jour, mode, COUNT(*) AS nb, SUM(montant) AS total
    FROM ventes WHERE annulee_le IS NULL AND date_vente BETWEEN ? AND ? GROUP BY jour, mode ORDER BY jour DESC`, [du + ' 00:00:00', au + ' 23:59:59']);
  const [ann] = await pool.query('SELECT COUNT(*) n FROM ventes WHERE annulee_le IS NOT NULL AND date_vente BETWEEN ? AND ?', [du + ' 00:00:00', au + ' 23:59:59']);
  const jours = new Map();
  for (const r of rows) {
    if (!jours.has(r.jour)) jours.set(r.jour, { jour: r.jour, nb: 0, total: 0, parMode: {} });
    const j = jours.get(r.jour); j.parMode[r.mode] = { nb: +r.nb, total: +r.total }; j.nb += +r.nb; j.total += +r.total;
  }
  const [last] = await pool.query("SELECT DATE_FORMAT(MAX(recu_le), '%Y-%m-%dT%H:%i:%sZ') AS dernier FROM ventes");
  res.json({ jours: [...jours.values()], annulees: +ann[0].n, dernier: last[0].dernier });
}));

/* Page de suivi (ordinateur ou téléphone) */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, setHeaders: r => r.set('X-Content-Type-Options', 'nosniff') }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => app.listen(PORT, () => console.log('Suivi Touba Bazar prêt sur le port ' + PORT)))
  .catch(e => { console.error('Base de données injoignable :', e.message); process.exit(1); });
