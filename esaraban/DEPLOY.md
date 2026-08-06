# Deploying e-Saraban to a cloud VPS

This app is a single Node.js process + local SQLite file — it needs a real VPS (not GitHub
Pages, which only serves static files, and not most "static site" free hosts). A small VPS is
enough: it matches the "โรงเรียนขนาดเล็ก" spec from the SRS (4 core / 8GB is generous for this
MVP; even a 1 vCPU / 1–2GB instance works fine for one school).

Any provider works (DigitalOcean, Vultr, Linode, Hetzner, AWS Lightsail...) — steps below use
DigitalOcean/Vultr naming but are the same everywhere. Budget: cheapest Ubuntu droplet is
usually $4–6/month.

## 1. Create the server

- Create a droplet/instance: **Ubuntu 24.04 LTS**, smallest size, any region near the school
- Note its public IP address
- (Optional but recommended) point a domain/subdomain at that IP via an A record, e.g.
  `esaraban.yourschool.ac.th` — needed for HTTPS in step 5

## 2. Initial server setup

SSH in as root, then:

```bash
adduser esaraban --disabled-password --gecos ""
usermod -aG sudo esaraban
# copy your SSH key so you can log in as this user, then disable root SSH login (Part 3/10 hardening):
rsync --archive --chown=esaraban:esaraban ~/.ssh /home/esaraban
# edit /etc/ssh/sshd_config: PermitRootLogin no, then: systemctl restart ssh

# firewall — only 80/443/22, per the spec's Production Checklist
apt update && apt install -y ufw fail2ban nginx certbot python3-certbot-nginx sqlite3
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable

# Node.js 22 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version   # confirm v22.x — required for node:sqlite
```

## 3. Deploy the app

```bash
su - esaraban
git clone https://github.com/Phanuwat-Suraphan/Phanuwat-Suraphan.git /tmp/repo
sudo mkdir -p /opt/esaraban
sudo cp -r /tmp/repo/esaraban/. /opt/esaraban/
sudo chown -R esaraban:esaraban /opt/esaraban
mkdir -p /opt/esaraban/data /opt/esaraban/uploads
```

No `npm install` needed — the app has zero external dependencies by design (see README.md).

## 4. Run it as a service (systemd)

```bash
# generate a real session secret — do not use the dev default in production
openssl rand -hex 32

sudo cp /opt/esaraban/deploy/esaraban.service /etc/systemd/system/esaraban.service
sudo nano /etc/systemd/system/esaraban.service   # paste the generated secret into SESSION_SECRET=

sudo systemctl daemon-reload
sudo systemctl enable --now esaraban
sudo systemctl status esaraban       # should show "active (running)"
curl http://127.0.0.1:3000/login     # should return HTML
```

## 5. Nginx reverse proxy + HTTPS

```bash
sudo cp /opt/esaraban/deploy/nginx.conf /etc/nginx/sites-available/esaraban
sudo nano /etc/nginx/sites-available/esaraban   # replace esaraban.example.com with your real domain
sudo ln -s /etc/nginx/sites-available/esaraban /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# only works once your domain's DNS A record points at this server's IP:
sudo certbot --nginx -d esaraban.yourschool.ac.th
```

Your site is now live at `https://esaraban.yourschool.ac.th`.

## 6. Backups

```bash
sudo cp /opt/esaraban/deploy/backup.sh /opt/esaraban/deploy/backup.sh
chmod +x /opt/esaraban/deploy/backup.sh
crontab -e
# add: 0 0 * * * /opt/esaraban/deploy/backup.sh >> /var/log/esaraban-backup.log 2>&1
```

Also copy `/opt/esaraban-backups` off the server periodically (e.g. `rsync` to another
machine, or sync to object storage) — a backup that only lives on the same disk doesn't
survive a disk failure.

## 7. Before real documents go into it

This is still the MVP described in `README.md` — do these before treating it as production:

- [ ] Change every seeded demo account's password and PIN (or delete the seed accounts and
      create real ones via `/admin/users`)
- [ ] Set a real `SESSION_SECRET` (step 4) — never ship the code's dev default
- [ ] Confirm firewall only exposes 80/443/22 (`sudo ufw status`)
- [ ] Add login rate-limiting (Part 3 of the spec calls for 5 attempts / 15 min lockout — not
      yet implemented; fail2ban on the Nginx access log is a stopgap, but an app-level limiter
      is the real fix)
- [ ] Add a virus scanner (ClamAV) in front of the upload path — not yet implemented
- [ ] Test the restore path once (`sqlite3 data/esaraban.db ".restore backup.db"`) before you
      need it for real

## Updating after a git push

```bash
su - esaraban
cd /tmp/repo && git pull
sudo rsync -a --exclude=data --exclude=uploads /tmp/repo/esaraban/ /opt/esaraban/
sudo systemctl restart esaraban
```
