#!/usr/bin/env bash
# Ставит на сервер оба кабинета: тетради по истории и тренажёр ОГЭ по обществознанию.
# Запуск от root на Ubuntu или Debian:
#   curl -fsSL https://raw.githubusercontent.com/CryingCat11/Istoriya-5-9-klass/main/marker/deploy/setup.sh | bash
# Повторный запуск безопасен: обновляет код и перезапускает кабинеты, коды входа и базы не трогает.
set -euo pipefail

DOMAIN="${DOMAIN:-misharepet.study}"
HIST_HOST="${HIST_HOST:-$DOMAIN}"
OGE_HOST="${OGE_HOST:-oge.$DOMAIN}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Запусти скрипт от root."; exit 1; }
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) echo "Скрипт рассчитан на Ubuntu или Debian, а здесь ${PRETTY_NAME:-неизвестная система}."; exit 1 ;; esac

if ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | grep -vq caddy; then
  echo "Порт 80 или 443 уже занят другой программой:"
  ss -ltnp | grep -E ':(80|443)\s'
  echo "Останови её или напиши, что это за программа, и запусти скрипт ещё раз."
  exit 1
fi

say "1/6 Ставлю нужные программы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg sqlite3 debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  say "2/6 Ставлю Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
else
  say "2/6 Node.js $(node -v) уже стоит"
fi

if ! command -v caddy >/dev/null; then
  say "3/6 Ставлю Caddy: он выдаёт сертификаты HTTPS и передаёт запросы кабинетам"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  say "3/6 Caddy уже стоит"
fi

say "4/6 Скачиваю код кабинетов"
id marker >/dev/null 2>&1 || useradd --system --home-dir /opt/marker --shell /usr/sbin/nologin marker
mkdir -p /opt/marker /var/lib/marker /etc/marker
fetch() {
  if [ -d "$2/.git" ]; then git -C "$2" fetch --depth 1 origin main && git -C "$2" reset --hard origin/main
  else git clone --depth 1 "$1" "$2"; fi
}
fetch https://github.com/CryingCat11/Istoriya-5-9-klass.git /opt/marker/istoriya
fetch https://github.com/CryingCat11/Obshchestvoznanie-OGE-2027.git /opt/marker/oge
(cd /opt/marker/oge/marker && npm ci --omit=dev --no-audit --no-fund)
chown -R marker:marker /opt/marker /var/lib/marker
chmod 700 /var/lib/marker /etc/marker

say "5/6 Настраиваю кабинеты"
newcode() { node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))'; }
envfile() {
  local file="/etc/marker/$1.env"
  if [ ! -f "$file" ]; then
    printf 'MARKER_TUTOR_CODE=%s\n' "$(newcode)" > "$file"
  fi
  sed -i '/^PORT=/d;/^MARKER_DB=/d;/^MARKER_URL=/d' "$file"
  printf 'PORT=%s\nMARKER_DB=/var/lib/marker/%s.sqlite\nMARKER_URL=https://%s/\n' "$2" "$1" "$3" >> "$file"
  chmod 600 "$file"
}
envfile istoriya 4318 "$HIST_HOST"
envfile oge 4317 "$OGE_HOST"

for app in istoriya oge; do
  cat > "/etc/systemd/system/marker-$app.service" <<EOF
[Unit]
Description=Кабинет учителя ($app)
After=network-online.target
Wants=network-online.target

[Service]
User=marker
Group=marker
WorkingDirectory=/opt/marker/$app/marker
EnvironmentFile=/etc/marker/$app.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/marker

[Install]
WantedBy=multi-user.target
EOF
done

# Ночное обновление кода из GitHub и резервная копия баз
cat > /usr/local/bin/marker-update <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
stamp=$(date +%F)
mkdir -p /var/backups/marker
for app in istoriya oge; do
  [ -f /var/lib/marker/$app.sqlite ] && sqlite3 /var/lib/marker/$app.sqlite ".backup '/var/backups/marker/$app-$stamp.sqlite'"
done
find /var/backups/marker -name '*.sqlite' -mtime +30 -delete
for app in istoriya oge; do
  git -C /opt/marker/$app fetch -q --depth 1 origin main
  git -C /opt/marker/$app reset -q --hard origin/main
done
(cd /opt/marker/oge/marker && npm ci --omit=dev --no-audit --no-fund --silent)
chown -R marker:marker /opt/marker
systemctl restart marker-istoriya marker-oge
EOF
chmod 755 /usr/local/bin/marker-update
cat > /etc/systemd/system/marker-update.service <<'EOF'
[Unit]
Description=Обновление кабинетов учителя
[Service]
Type=oneshot
ExecStart=/usr/local/bin/marker-update
EOF
cat > /etc/systemd/system/marker-update.timer <<'EOF'
[Unit]
Description=Обновление кабинетов учителя каждую ночь
[Timer]
OnCalendar=*-*-* 04:10
Persistent=true
[Install]
WantedBy=timers.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$HIST_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4318
}

$OGE_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4317
}
EOF

systemctl daemon-reload
systemctl enable --now marker-update.timer >/dev/null
for app in istoriya oge; do systemctl enable marker-$app >/dev/null; systemctl restart marker-$app; done
systemctl enable caddy >/dev/null
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "6/6 Проверяю"
sleep 3
for app in istoriya oge; do
  if systemctl is-active --quiet marker-$app; then echo "Кабинет $app работает"
  else echo "Кабинет $app не запустился, последние строки журнала:"; journalctl -u marker-$app -n 20 --no-pager; fi
done

code() { grep '^MARKER_TUTOR_CODE=' "/etc/marker/$1.env" | cut -d= -f2-; }
say "Готово"
cat <<EOF
Тетради по истории:   https://$HIST_HOST/tutor
  код входа:          $(code istoriya)
Тренажёр ОГЭ:         https://$OGE_HOST/tutor
  код входа:          $(code oge)

Сохрани коды в надёжном месте. Показать их ещё раз: grep CODE /etc/marker/*.env
Сертификат HTTPS выпускается сам в первые минуты. Для $OGE_HOST нужна запись A в DNS на этот сервер.
Код обновляется из GitHub каждую ночь, копии баз лежат в /var/backups/marker (30 дней).
EOF
