# Deploying to Oracle Cloud "Always Free"

Oracle Cloud Infrastructure (OCI) gives a genuinely permanent free tier VPS — not a time-limited
trial. This is the recommended free option for running e-Saraban for real (unlike Render/Railway
free tiers, which don't give persistent disk). It has two Oracle-specific gotchas that trip
almost everyone up on first setup, covered in step 3 below — everything after that is identical
to the generic [`DEPLOY.md`](../DEPLOY.md).

## 1. Sign up

Go to <https://www.oracle.com/cloud/free/> and create an account. You'll need a phone number and
a credit card for identity verification — Oracle does not charge it as long as you stay within
Always Free limits (the resources below all qualify). Signup sometimes gets capacity errors in
popular regions ("out of host capacity") — if that happens, either retry later or pick a
different home region during signup.

## 2. Create the instance

In the OCI Console: **Compute → Instances → Create Instance**

- **Name**: `esaraban`
- **Image**: switch it to **Canonical Ubuntu 24.04**
- **Shape**: click "Change shape" →  **Ampere (Arm-based processor) → VM.Standard.A1.Flex**
  This is the better Always Free option: up to 4 OCPU / 24GB RAM total, shared across however
  many A1 instances you run. Set this one instance to **2 OCPU / 12GB** — plenty for one school,
  and leaves headroom to run something else free later if you want.
  (The older `VM.Standard.E2.1.Micro` x2 AMD shape also stays free, but only 1GB RAM each — the
  A1 shape above is the more practical choice.)
- **SSH key**: let OCI generate a key pair and **download the private key** — you'll need it to
  log in. On your own machine: `chmod 600 the-downloaded-key.pem`
- Leave networking on the default VCN/subnet it offers to create, then **Create**

Once it's running, note its **Public IP** from the instance details page.

## 3. Oracle-specific networking (do this before anything else)

Unlike most VPS providers, OCI blocks all inbound traffic except SSH **twice over** — once at
the cloud network layer, once again inside the VM itself. Both need opening, or Nginx/HTTPS will
be unreachable even after you set them up correctly:

**a) Cloud-side: open 80/443 in the Security List**

Console → your instance → click the subnet link → click the **Security List** → **Add Ingress
Rules** → add two rules (source CIDR `0.0.0.0/0`, IP Protocol TCP, destination ports `80` and
`443` — one rule each).

**b) VM-side: Oracle's Ubuntu image ships with iptables blocking everything but SSH**

SSH in first (`ssh -i the-downloaded-key.pem ubuntu@<public-ip>`), then:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

(If step 5 of `DEPLOY.md` has you also install and enable `ufw`, that's fine — `ufw` runs on top
of the same iptables and won't conflict as long as you `ufw allow 'Nginx Full'` there too. Both
layers — Security List and host firewall — must allow the traffic.)

## 4. Continue with the generic guide

From here on it's identical to a regular VPS — follow **`DEPLOY.md` from step 2 onward**
(Node.js install, cloning the app, systemd service, Nginx + Certbot, backups), using:

- SSH user: `ubuntu` (not `root` — Oracle's Ubuntu image disables root SSH login by default,
  so you can skip the "disable root login" part of `DEPLOY.md` step 2, it's already done)
- `sudo` works out of the box for the `ubuntu` user

## No domain name yet?

Certbot (for HTTPS) needs a real domain pointing at your server. If the school doesn't have one
yet, you can get free HTTPS immediately using a "magic" wildcard DNS service that just encodes
your IP — no signup needed:

```
<your-public-ip-with-dashes>.nip.io
# e.g. IP 132.145.20.10 -> 132-145-20-10.nip.io
```

Use that as the `server_name` in `nginx.conf` and the `-d` value for `certbot --nginx`. It
resolves to your server automatically, so Let's Encrypt's validation works normally. Swap in a
real subdomain later without changing anything else.
