# Observatoire des risques du Val-d’Oise

Version fusionnée : architecture de l’Observatoire du bâti et données locales
de l’ancien atlas « Crues et risques ».

## Fonctionnement

- Au démarrage, 26 enveloppes PPR locales sont visibles et cliquables à
  l’échelle du département.
- À partir du zoom 13, les zonages réglementaires détaillés Géorisques se
  superposent automatiquement.
- Le clic affiche un repère, résout la commune et ouvre le panneau droit.
- Chaque dossier utilise les liens officiels du catalogue Géorisques
  (règlements, notes, cartes et actes disponibles).
- Aucun PDF lourd n’est embarqué dans le dépôt GitHub.
- Les contours des 183 communes et les cours d’eau fournissent le contexte.

Les documents approuvés et leurs cartes annexées demeurent les références
juridiques opposables.

Application cartographique DDT95 consacrée aux PPRI, PPRN et aléas naturels.

- même architecture graphique que l’Observatoire du bâti ;
- recherche par adresse ou commune ;
- zonages officiels Géorisques cliquables ;
- synthèse dans un panneau latéral ;
- accès direct aux arrêtés, règlements, notes et cartes PDF officiels ;
- périmètres PPRI/PPRN visibles à l’ouverture ;
- bascule automatique vers les zonages réglementaires détaillés à partir du zoom 13.

Le fichier `ppr-documents.js` contient le catalogue des pièces publiées dans les fiches PPR Géorisques.

Les données cartographiques constituent une aide à la lecture. Les documents réglementaires approuvés et annexés aux arrêtés préfectoraux font foi.
