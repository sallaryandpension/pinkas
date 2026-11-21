#!/usr/bin/env bash
# Install or update Pinkas on an Ubuntu server (24.04+). Safe to run again for updates.
#   git clone https://github.com/sallaryandpension/pinkas.git /tmp/pinkas-setup
#   sudo bash /tmp/pinkas-setup/deploy/install-server.sh
# Result: systemd service "pinkas" on 127.0.0.1:5174 only (reach it via SSH tunnel / Tailscale),
# data in /var/lib/pinkas (mode 700, owner "pinkas"), code in /opt/pinkas (root-owned, read-only),
# only src/, public/ and package.json are checked out (no tests / Windows tools on the server).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }

REPO=https://github.com/sallaryandpension/pinkas.git
APP=/opt/pinkas
NODE_DIR=/opt/node
NODE_MAJOR=26
DATA=/var/lib/pinkas
SVC_USER=pinkas
PORT=5174
SVC_HOME=/home/$SVC_USER
PDF_TMP=$DATA/pdf-tmp
CHS=/opt/chrome-headless-shell          # PDF engine: Chrome for Testing "headless shell" (Google, official)
BROWSER=$CHS/chrome-headless-shell
# Ubuntu blocks unprivileged user namespaces, so Chrome's sandbox can't start under a service user.
# Pinkas only prints HTML it rendered itself (local file, no web content), so the sandbox is disabled for it.
BROWSER_ARGS=--no-sandbox

echo "== 1/7 System packages (git, Hebrew fonts, libraries for headless Chrome)"
apt-get update -qq
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq git curl ca-certificates xz-utils unzip fonts-culmus fonts-noto-core fonts-dejavu-core >/dev/null
for p in libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libxkbcommon0 \
         libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libasound2 libexpat1 libglib2.0-0; do
  apt-get install -y -qq "$p" >/dev/null 2>&1 || apt-get install -y -qq "${p}t64" >/dev/null 2>&1 || echo "   (package $p not found)"
done
# Chromium from snap can't run under a system service user ("cannot track application process") – not used.
if snap list chromium >/dev/null 2>&1; then snap remove --purge chromium >/dev/null && echo "   removed snap chromium (not usable by the service)"; fi

echo "== 1b/7 Headless Chrome for PDF (Chrome for Testing, Stable)"
ver=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json \
      | tr -d ' \n\r' | sed -n 's/.*"Stable":{[^}]*"version":"\([0-9.]*\)".*/\1/p')
[ -n "$ver" ] || { echo "!! could not read the Chrome for Testing version list"; exit 1; }
if [ -x "$BROWSER" ] && [ "$(cat "$CHS/VERSION" 2>/dev/null)" = "$ver" ]; then
  echo "   already installed ($ver)"
else
  tmp=$(mktemp -d)
  curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/$ver/linux64/chrome-headless-shell-linux64.zip" -o "$tmp/chs.zip"
  unzip -q "$tmp/chs.zip" -d "$tmp"
  rm -rf "$CHS" && mv "$tmp/chrome-headless-shell-linux64" "$CHS"
  echo "$ver" > "$CHS/VERSION"
  chown -R root:root "$CHS" && chmod -R go-w "$CHS"
  rm -rf "$tmp"
  echo "   installed $ver"
fi
missing=$(ldd "$BROWSER" | grep "not found" || true)
[ -z "$missing" ] || { echo "!! missing libraries for headless Chrome:"; echo "$missing"; }

echo "== 2/7 Node.js $NODE_MAJOR (official build from nodejs.org, checksum verified)"
if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" -v | grep -q "^v$NODE_MAJOR\."; then
  echo "   already installed"
else
  tmp=$(mktemp -d)
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v[0-9.]*-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
echo "   node $("$NODE_DIR/bin/node" -v)"

echo "== 3/7 Service user and data folder"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$SVC_HOME" --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA" "$PDF_TMP"
rm -rf "$SVC_HOME/snap"   # left over from the snap attempt

echo "== 4/7 Pinkas code"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin
  git -C "$APP" reset -q --hard origin/main
else
  rm -rf "$APP"
  git clone -q --no-checkout "$REPO" "$APP"
  git -C "$APP" sparse-checkout set --no-cone '/src/' '/public/' '/package.json'
  git -C "$APP" checkout -q main
fi
chown -R root:root "$APP" && chmod -R go-w "$APP"
echo "   version $(git -C "$APP" log -1 --format='%h %ad' --date=short)"

echo "== 5/7 systemd service"
touch /etc/pinkas.env && chmod 644 /etc/pinkas.env   # extra settings, e.g. PINKAS_HOSTS=... for Tailscale
cat > /etc/systemd/system/pinkas.service <<EOF
[Unit]
Description=Pinkas bookkeeping server
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$DATA
Environment=HOME=$SVC_HOME
Environment=PINKAS_DATA=$DATA
Environment=PINKAS_PORT=$PORT
Environment=PINKAS_BROWSER=$BROWSER
Environment=PINKAS_BROWSER_ARGS=$BROWSER_ARGS
Environment=PINKAS_PDF_TMP=$PDF_TMP
EnvironmentFile=-/etc/pinkas.env
ExecStart=$NODE_DIR/bin/node $APP/src/server.ts
Restart=on-failure
RestartSec=5
UMask=0077
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q pinkas
systemctl restart pinkas
sleep 3
if ! systemctl is-active --quiet pinkas; then
  echo "!! Service failed to start:"; journalctl -u pinkas -n 30 --no-pager; exit 1
fi
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login.html" -H "Host: localhost:$PORT" && echo "   service is running on 127.0.0.1:$PORT"

echo "== 6/7 PDF test (headless Chrome, as the service user)"
if (cd "$DATA" && sudo -u "$SVC_USER" env HOME="$SVC_HOME" PINKAS_BROWSER="$BROWSER" PINKAS_BROWSER_ARGS="$BROWSER_ARGS" PINKAS_PDF_TMP="$PDF_TMP" \
     "$NODE_DIR/bin/node" -e "import('$APP/src/render/pdf.ts').then(m => m.htmlToPdf('<meta charset=utf-8><p dir=rtl>בדיקה 123</p>')).then(b => console.log('   PDF OK, bytes:', b.length))"); then :
else echo "!! PDF test FAILED - send this output"; fi

echo "== 7/7 Login"
if [ -f "$DATA/auth.json" ]; then
  echo "   Login is already set up."
else
  echo "   Login is NOT set up yet. Setup code: $(cat "$DATA/setup-token.txt")"
fi
echo
echo "DONE. On your computer run:   ssh -L $PORT:127.0.0.1:$PORT $(logname 2>/dev/null || echo user)@$(hostname -I | awk '{print $1}')"
echo "then open in the browser:     http://localhost:$PORT"
