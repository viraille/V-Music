# ytmc-dashboard-server

Petit serveur qui reçoit, de chaque instance de `ytmusic-custom`, ce qu'elle
écoute (titre, artiste, play/pause) et affiche un dashboard en temps réel.
Zéro dépendance — juste Node.js.

## Déploiement sur Proxmox

Le plus simple : un conteneur LXC léger (Debian/Ubuntu) avec Node.js dedans.

```bash
# dans le conteneur LXC
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

mkdir -p /opt/ytmc-dashboard
# copie server.js et package.json dedans (scp, ou colle le contenu)
```

### Test rapide

```bash
cd /opt/ytmc-dashboard
PORT=3939 REPORT_API_KEY=une-cle-secrete DASHBOARD_USER=admin DASHBOARD_PASS=motdepasse node server.js
```

Ouvre `http://IP-DU-CONTENEUR:3939` dans un navigateur → ça te demande les
identifiants (Basic Auth), puis affiche le dashboard (vide pour l'instant,
tant qu'aucun client n'a envoyé de rapport).

### Lancer en permanence (systemd)

```bash
cp server.js package.json /opt/ytmc-dashboard/
cp ytmc-dashboard.service /etc/systemd/system/
nano /etc/systemd/system/ytmc-dashboard.service   # change REPORT_API_KEY et DASHBOARD_PASS
systemctl daemon-reload
systemctl enable --now ytmc-dashboard
systemctl status ytmc-dashboard
```

## Variables d'environnement

| Variable | Rôle | Par défaut |
|---|---|---|
| `PORT` | Port d'écoute | `3939` |
| `REPORT_API_KEY` | Clé que les clients doivent fournir pour poster leur état. **Mets-la** si le serveur sort de ton réseau local. | vide (ouvert) |
| `DASHBOARD_USER` / `DASHBOARD_PASS` | Protège la page du dashboard par mot de passe (Basic Auth) | vide (ouvert) |

Si tu restes strictement sur ton LAN, tu peux laisser les deux vides pour
simplifier — mais garde en tête que n'importe qui sur le réseau peut alors
voir/poster. Si tu exposes le port sur Internet (reverse proxy, port
forwarding...), mets impérativement `REPORT_API_KEY` et
`DASHBOARD_USER`/`DASHBOARD_PASS`.

## Routes

- `POST /api/report` — un client y poste `{ clientId, username, trackTitle, trackArtist, isPlaying }` (header `x-api-key` si configuré)
- `GET /` — le dashboard HTML
- `GET /api/events` — flux SSE utilisé par le dashboard pour se mettre à jour en direct

## Vie privée

Seuls titre, artiste, statut play/pause, nom affiché et un ID de poste
transitent. Pas d'historique conservé sur disque : tout est en mémoire, reset
au redémarrage du serveur. Un client considéré "hors ligne" après 20s sans
rapport (app fermée, PC éteint, etc.).
