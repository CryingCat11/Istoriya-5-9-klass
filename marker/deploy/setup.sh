#!/usr/bin/env bash
# Ставит на сервер кабинет учителя для тетрадей по истории.
# Запуск от root на Ubuntu или Debian:
#   curl -fsSL https://raw.githubusercontent.com/CryingCat11/Istoriya-5-9-klass/main/marker/deploy/setup.sh | bash
# Повторный запуск безопасен: обновляет код и перезапускает кабинет, код входа и базу не трогает.
# После установки код из GitHub подтягивается сам каждые 5 минут.
set -euo pipefail

DOMAIN="${DOMAIN:-misharepet.study}"
HIST_HOST="${HIST_HOST:-$DOMAIN}"

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
  say "3/6 Ставлю Caddy: он выдаёт сертификат HTTPS и передаёт запросы кабинету"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  say "3/6 Caddy уже стоит"
fi

# Прежние версии ставили рядом тренажёр ОГЭ по обществознанию. Это отдельный проект, убираем его,
# а его базу не удаляем, а переносим в резервные копии
if [ -f /etc/systemd/system/marker-oge.service ] || [ -d /opt/marker/oge ]; then
  say "Убираю тренажёр ОГЭ по обществознанию: это отдельный проект"
  systemctl disable --now marker-oge >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/marker-oge.service /etc/marker/oge.env
  rm -rf /opt/marker/oge
  if [ -f /var/lib/marker/oge.sqlite ]; then
    mkdir -p /var/backups/marker
    sqlite3 /var/lib/marker/oge.sqlite ".backup '/var/backups/marker/oge-removed-$(date +%F).sqlite'"
    rm -f /var/lib/marker/oge.sqlite /var/lib/marker/oge.sqlite-wal /var/lib/marker/oge.sqlite-shm
    echo "База тренажёра сохранена в /var/backups/marker/oge-removed-$(date +%F).sqlite"
  fi
  git config --system --unset-all safe.directory '^/opt/marker/oge$' 2>/dev/null || true
  systemctl daemon-reload
fi

say "4/6 Скачиваю код кабинета"
id marker >/dev/null 2>&1 || useradd --system --home-dir /opt/marker --shell /usr/sbin/nologin marker
mkdir -p /opt/marker /var/lib/marker /etc/marker
# Код принадлежит пользователю marker, а обновляет его root: разрешаем git работать с этой папкой
git config --system --get-all safe.directory 2>/dev/null | grep -qxF /opt/marker/istoriya || git config --system --add safe.directory /opt/marker/istoriya
if [ -d /opt/marker/istoriya/.git ]; then
  git -C /opt/marker/istoriya fetch --depth 1 origin main
  git -C /opt/marker/istoriya reset --hard origin/main
else
  git clone --depth 1 https://github.com/CryingCat11/Istoriya-5-9-klass.git /opt/marker/istoriya
fi
chown -R marker:marker /opt/marker /var/lib/marker
chmod 700 /var/lib/marker /etc/marker

say "5/6 Настраиваю кабинет"
file=/etc/marker/istoriya.env
if [ ! -f "$file" ]; then
  printf 'MARKER_TUTOR_CODE=%s\n' "$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')" > "$file"
fi
sed -i '/^PORT=/d;/^MARKER_DB=/d;/^MARKER_URL=/d' "$file"
printf 'PORT=4318\nMARKER_DB=/var/lib/marker/istoriya.sqlite\nMARKER_URL=https://%s/\n' "$HIST_HOST" >> "$file"
chmod 600 "$file"

cat > /etc/systemd/system/marker-istoriya.service <<'EOF'
[Unit]
Description=Кабинет учителя: тетради по истории
After=network-online.target
Wants=network-online.target

[Service]
User=marker
Group=marker
WorkingDirectory=/opt/marker/istoriya/marker
EnvironmentFile=/etc/marker/istoriya.env
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

# Обновление кода из GitHub каждые 5 минут и резервная копия базы раз в день
cat > /usr/local/bin/marker-update <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
stamp=$(date +%F)
mkdir -p /var/backups/marker
if [ -f /var/lib/marker/istoriya.sqlite ] && [ ! -f /var/backups/marker/istoriya-$stamp.sqlite ]; then
  sqlite3 /var/lib/marker/istoriya.sqlite ".backup '/var/backups/marker/istoriya-$stamp.sqlite'"
fi
find /var/backups/marker -name 'istoriya-*.sqlite' -mtime +30 -delete
before=$(git -C /opt/marker/istoriya rev-parse HEAD)
git -C /opt/marker/istoriya fetch -q --depth 1 origin main
git -C /opt/marker/istoriya reset -q --hard origin/main
if [ "$before" != "$(git -C /opt/marker/istoriya rev-parse HEAD)" ] || [ "${1:-}" = "--force" ]; then
  chown -R marker:marker /opt/marker/istoriya
  systemctl restart marker-istoriya
  echo "Кабинет обновлён до $(git -C /opt/marker/istoriya log -1 --format='%h %s')"
fi
EOF
chmod 755 /usr/local/bin/marker-update
cat > /etc/systemd/system/marker-update.service <<'EOF'
[Unit]
Description=Обновление кабинета учителя
[Service]
Type=oneshot
ExecStart=/usr/local/bin/marker-update
EOF
cat > /etc/systemd/system/marker-update.timer <<'EOF'
[Unit]
Description=Обновление кабинета учителя каждые 5 минут
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$HIST_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4318
}
EOF

systemctl daemon-reload
systemctl enable marker-update.timer >/dev/null
systemctl restart marker-update.timer
systemctl enable marker-istoriya >/dev/null
systemctl restart marker-istoriya
systemctl enable caddy >/dev/null
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "6/6 Проверяю"
sleep 3
if systemctl is-active --quiet marker-istoriya; then echo "Кабинет работает"
else echo "Кабинет не запустился, последние строки журнала:"; journalctl -u marker-istoriya -n 20 --no-pager; fi

say "Готово"
cat <<EOF
Сайт:            https://$HIST_HOST
Кабинет учителя: https://$HIST_HOST/tutor
Показать код входа: grep CODE /etc/marker/istoriya.env

Новые версии из GitHub приходят сами в течение 5 минут. Копии базы раз в день лежат в /var/backups/marker (30 дней).
EOF
