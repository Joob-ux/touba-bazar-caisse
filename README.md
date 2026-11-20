# Caisse Touba Bazar

Caisse simple pour TPE Android : montant + mode de paiement (Espèces / Wave / Orange Money),
ticket imprimé, chiffre d'affaires du jour, historique. Tout reste sur le TPE : pas de base de données.

| Dossier | Contenu |
|---|---|
| `web/` | La caisse (HTML/JS), publiée sur Vercel, fonctionne hors ligne |
| `android/` | Appli Android du TPE (ouvre la page, imprime via RawBT) |

## Installation sur le TPE
1. Installer **RawBT** (Play Store) et choisir l'imprimante intégrée.
2. Installer l'APK (release **apk** du dépôt), autoriser les « sources inconnues ».
3. Ouvrir l'appli avec internet la première fois, remplir les infos de la boutique, imprimer un ticket test.

Sauvegarde : ☰ → Exporter les ventes (CSV envoyé par WhatsApp / e-mail).
