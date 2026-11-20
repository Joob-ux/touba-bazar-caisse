# Suivi Touba Bazar (dossier suivi/)

Serveur Express + mysql2 copié du suivi T.B.T.L (`Joob-ux/tbtb-suivi`), adapté aux ventes.
- La caisse (`web/suivi-sync.js`, adresse dans `web/config.js`) envoie ses ventes à `POST /api/ventes`
  ({ n, t, m, p, l, a }) après autorisation de la caisse par le gérant (Compte → Caisses).
- Base `toubabazar_db` sur le MySQL privé de GestPro (`gestpro-mysql`), service Render gratuit
  défini dans `render.yaml` à la racine (Blueprint). Compte gérant : `ADMIN_EMAIL`.
- Clôtures de caisse : `POST /api/clotures` ({ z, t, du, deN, aN, nb, total, parMode }), table `clotures`, jamais modifiées.
- Remise à zéro (ventes de test) : `POST /api/reinitialiser` (la caisse, ses propres ventes) et
  `POST /api/tout-effacer` (gérant, confirmation « EFFACER »). Rien d'autre n'efface.
- Une vente reçue n'est jamais effacée ; seule l'annulation (`annulee_le`) peut s'ajouter.
- Heure de Dakar = UTC : dates gardées en UTC.
- Tester en local avec MariaDB : `DB_USER=… DB_PASSWORD=… DB_NAME=… ADMIN_EMAIL=… ALLOWED_ORIGINS=http://localhost:8769 PORT=3100 node server.js`
  et la caisse avec `localStorage.tb_suivi_url = 'http://localhost:3100'`.
