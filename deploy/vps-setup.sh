#!/usr/bin/env bash
# One-time hardening + Docker install for Ubuntu 22.04/24.04 LTS (Hostinger KVM-2 class VPS).
# Run as root:  ADMIN_USER=deploy ADMIN_SSH_PUBKEY="ssh-ed25519 AAAA..." bash vps-setup.sh
# SAFETY: it disables SSH password login and root login. It refuses to proceed unless an SSH key
# for ADMIN_USER is installed, so you cannot lock yourself out. Keep your current session open and
# test a second login before closing it.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
ADMIN_USER="${ADMIN_USER:-deploy}"
ADMIN_SSH_PUBKEY="${ADMIN_SSH_PUBKEY:-}"
SSH_PORT="${SSH_PORT:-22}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades apt-listchanges age rclone jq

# --- admin user with key-only login ---
id "$ADMIN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$ADMIN_USER"
usermod -aG sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
if [ -n "$ADMIN_SSH_PUBKEY" ]; then
  echo "$ADMIN_SSH_PUBKEY" >> "/home/$ADMIN_USER/.ssh/authorized_keys"
fi
chmod 600 "/home/$ADMIN_USER/.ssh/authorized_keys" 2>/dev/null || true
chown -R "$ADMIN_USER:$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
if ! grep -qE '^(ssh-|ecdsa-|sk-)' "/home/$ADMIN_USER/.ssh/authorized_keys" 2>/dev/null; then
  echo "No SSH key installed for $ADMIN_USER; set ADMIN_SSH_PUBKEY. Aborting before locking SSH down." >&2
  exit 1
fi
# sudo without password is needed for key-only accounts; restrict if you prefer to set a password.
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"

# --- SSH hardening (drop-in; 00- prefix wins over cloud-init's 50-*.conf) ---
cat > /etc/ssh/sshd_config.d/00-meetflow-hardening.conf <<EOF
Port $SSH_PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowUsers $ADMIN_USER
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

# --- firewall: only SSH, HTTP, HTTPS (docker bypasses ufw for published ports, hence only caddy publishes) ---
ufw default deny incoming
ufw default allow outgoing
ufw allow "$SSH_PORT"/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# --- fail2ban ---
cat > /etc/fail2ban/jail.d/meetflow.local <<EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
[sshd]
enabled = true
port = $SSH_PORT
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# --- unattended security upgrades ---
cat > /etc/apt/apt.conf.d/20auto-upgrades <<EOF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades

# --- swap (8 GB RAM box: small safety net) ---
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf && sysctl --system >/dev/null
fi

# --- docker (official repo) ---
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" }, "live-restore": true }
EOF
systemctl enable --now docker
systemctl restart docker
usermod -aG docker "$ADMIN_USER"

install -d -m 750 -o "$ADMIN_USER" -g "$ADMIN_USER" /opt/meetflow
install -d -m 700 /var/backups/meetflow

cat <<EOF

Setup complete.
 1. In a NEW terminal verify:  ssh -p $SSH_PORT $ADMIN_USER@<server-ip>   (keep this session open until it works)
 2. Copy the repo to /opt/meetflow and create /opt/meetflow/.env.production (chmod 600).
 3. Install crons: see docs/DEPLOYMENT.md (backup, restore-verify, monitor).
EOF
