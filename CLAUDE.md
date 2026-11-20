# Caisse Touba Bazar — fiche pour l'agent

Caisse TPE pour le client **Touba Bazar**, réalisée par Matar Diop (Xelkoom Valley).
Même principe que la caisse T.B.T.L (`Joob-ux/tbtb-caisse`) : la caisse marche **sans serveur ni internet** ;
les ventes sont recopiées vers le suivi à distance quand il y a du réseau.
Les demandes arrivent souvent depuis un téléphone : faire la modification complètement
(code, test, déploiement, vérification). Répondre en français, court et structuré.

## Fonctionnement
- Le caissier tape un **montant** (libellé facultatif), choisit **Espèces / Wave / Orange Money** ;
  le ticket 58 mm s'imprime. Chiffre d'affaires du jour en haut, historique jour par jour
  (filtre par mode, réimpression, annulation), clôture, export CSV.
- **TPE Q3Pro** : l'appli Android (`android/`) ouvre la page Vercel en plein écran et donne
  `window.Android.printRaw` (ticket image ESC/POS → imprimante intégrée du Q3Pro via le service
  `IPosPrinterService` (AIDL dans `android/app/src/main/aidl`, ordre des méthodes relevé sur le TPE),
  sinon RawBT, sinon Bluetooth « InnerPrinter »)
  et `window.Android.partager` (export CSV).

- **Suivi à distance** (`suivi/`, voir `suivi/CLAUDE.md`) : la caisse envoie chaque vente
  (`web/suivi-sync.js`) ; le gérant les voit sur ordinateur ou téléphone avec son compte.
  Seul petit serveur du projet : gratuit, base séparée sur le MySQL de GestPro, comme T.B.T.L.

## En production
- https://touba-bazar-caisse.vercel.app — Vercel publie `web/` (`vercel.json`), déploiement
  automatique à chaque push sur `main`. L'URL est écrite dans `android/app/build.gradle` (CAISSE_URL).
- APK : GitHub Actions (`.github/workflows/apk.yml`) le compile à chaque modification de `android/`
  et le publie dans la release **apk** du dépôt.

## Règles
1. Ventes dans le `localStorage` du TPE, clé `tb_ventes_v1` (format `{n,t,m,p,l,r,a}`) :
   ne jamais changer la clé ni le format sans migration, sinon l'historique est perdu.
   Infos du ticket : `tb_boutique_v1`.
2. Numérotation continue, jamais réutilisée ; une vente annulée reste visible (barrée).
3. `web/sw.js` : **augmenter `CACHE` à chaque modification**, sinon le TPE garde l'ancienne version.
4. Tester avant de pousser : `python3 -m http.server` dans `web/` + Playwright, en simulant le TPE
   (`window.Android = { printRaw(){}, partager(){} }`), sans erreur JavaScript.
5. **Compte administrateur** (code 4 à 8 chiffres, PBKDF2 + sel dans `tb_admin_v1`) : historique,
   annulations, export, infos boutique, impression, changement de code ; option « le caissier voit
   le CA du jour et la clôture ». Verrouillage auto après 5 min. Code de secours Xelkoom Valley
   (16 chiffres, connu de Matar seulement, empreinte `SECOURS` dans `web/app.js`) : ne jamais
   l'écrire dans le dépôt. Toute nouvelle action sensible passe par `enAdmin(...)`.
6. Montants en F CFA, séparateur de milliers par espace. Messages de commit en français.
