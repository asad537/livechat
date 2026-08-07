# Deploy — 10 minute mein live

## Chahiye
- Ubuntu 22.04/24.04 VPS (Hostinger VPS KVM 1, Hetzner, DigitalOcean, Contabo…)
- Ek (sub)domain jiska **A-record VPS ke IP par** point karta ho, e.g. `chat.aapkabrand.com`

> ⚠️ Hostinger **shared hosting par nahi chalega** — VPS chahiye (Node.js + WebSockets).

## Steps

```bash
# 1. VPS par SSH karein
ssh root@VPS_IP

# 2. Project le aayein (git ya apne Mac se scp)
git clone <aapka-repo-url> livechat && cd livechat
#    ya Mac se:  scp -r livechat root@VPS_IP:/root/

# 3. Ek command — sab kuch
sudo bash deploy/setup.sh chat.aapkabrand.com
```

Bas. Script Node 22, MariaDB, Caddy (free HTTPS), PM2 install kar ke
sab build + start kar deta hai. Aakhir mein saare URLs print hote hain.

## Baad mein

| Kaam | Command |
|---|---|
| Logs dekhna | `pm2 logs livechat` |
| Restart | `pm2 restart livechat` |
| Code update | `git pull && npm install && npm run build -w apps/widget && npm run build -w apps/dashboard && pm2 restart livechat` |
| AI greeter on | `.env` mein `ANTHROPIC_API_KEY=` daal kar restart |
| Email transcripts on | `.env` mein `SMTP_*` daal kar restart |

## Pehla kaam live hone ke baad
1. `https://chat.aapkabrand.com/app/` par admin login karein
2. **Demo passwords badlein** (Admin → Users)
3. Apni asli website Admin → Websites mein add karein — embed snippet wahan milega
