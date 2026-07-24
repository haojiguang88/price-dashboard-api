#!/bin/bash
set -euo pipefail

BRANCH="${BRANCH:-codex/finance-flow-wip-checkpoint}"
API="${API:-/www/wwwroot/price-dashboard-api}"
DB="${DB:-$API/db/price_dashboard_prod.db}"
BACKUP_DIR="${BACKUP_DIR:-$API/backups}"
PY="${PY:-$API/.venv/bin/python}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
PUBLIC_API="${PUBLIC_API:-${PUBLIC_BASE_URL:+$PUBLIC_BASE_URL/api}}"
CORS_ORIGINS="${CORS_ORIGINS:-$PUBLIC_BASE_URL}"
SERVER_AUTH_MODE="${SERVER_AUTH_MODE:-session}"
AUTH_IDENTITY_HEADER="${AUTH_IDENTITY_HEADER:-X-Authenticated-User}"
SECRETS_FILE="${SECRETS_FILE:-$API/.env.secrets}"

CURRENT_STEP="初始化"

log_section() {
  CURRENT_STEP="$1"
  echo
  echo "=== $1 ==="
}

log_info() {
  echo "[$(date '+%F %T')] $*"
}

on_error() {
  local exit_code=$?
  echo
  echo "=== 后端部署失败 ==="
  echo "失败步骤：${CURRENT_STEP:-未知}"
  echo "退出码：$exit_code"
  exit "$exit_code"
}

git_fetch_retry() {
  local n=1
  until git -c http.version=HTTP/1.1 \
    -c http.lowSpeedLimit=1000 \
    -c http.lowSpeedTime=60 \
    fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; do
    if [ "$n" -ge 3 ]; then
      echo "git fetch failed after $n attempts"
      exit 1
    fi
    echo "git fetch failed, retrying in 10s: attempt $((n + 1))"
    n=$((n + 1))
    sleep 10
  done
}

append_env_file_entries() {
  local file="$1"
  [ -f "$file" ] || return 0

  local appended=0
  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    local line key
    line="$(printf '%s' "$raw_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$line" in
      ""|\#*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    key="$(printf '%s' "$key" | sed 's/[[:space:]]*$//')"
    [ -n "$key" ] || continue
    if ! grep -qE "^${key}=" "$API/.env"; then
      printf '%s\n' "$line" >> "$API/.env"
      appended=$((appended + 1))
    fi
  done < "$file"

  if [ "$appended" -gt 0 ]; then
    log_info "已追加 $appended 条环境变量：$file"
  fi
}

append_known_secrets_from_old_env() {
  local old_env="$1"
  [ -f "$old_env" ] || return 0

  local key line
  for key in TWELVE_DATA_API_KEY TUSHARE_TOKEN AIRMB_USER_ID AIRMB_ACCESS_TOKEN AIRMB_OUT_SOURCE AIRMB_COOKIE AUTH_USERNAME AUTH_PASSWORD_HASH AUTH_SESSION_SECRET AUTH_SESSION_TTL_HOURS; do
    line="$(grep -E "^${key}=" "$old_env" | tail -n 1 || true)"
    if [ -n "$line" ] && ! grep -qE "^${key}=" "$API/.env"; then
      printf '%s\n' "$line" >> "$API/.env"
      log_info "已从旧 .env 保留：$key"
    fi
  done
}

curl_retry() {
  local url="$1"
  local label="$2"
  local attempts="${3:-15}"
  local delay_seconds="${4:-2}"
  local n=1

  until curl -fsS "$url"; do
    if [ "$n" -ge "$attempts" ]; then
      echo
      echo "=== ${label}验证失败 ==="
      echo "地址：$url"
      echo "已重试：$attempts 次"
      echo "PM2 状态："
      pm2 status price-dashboard-api || true
      echo
      echo "PM2 最近日志："
      pm2 logs price-dashboard-api --lines 80 --nostream || true
      return 1
    fi
    echo
    log_info "${label}暂未就绪，${delay_seconds}s 后重试：第 $((n + 1))/$attempts 次"
    n=$((n + 1))
    sleep "$delay_seconds"
  done
}

verify_public_auth_boundary() {
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_API/categories")"
  case "$status" in
    301|302|303|307|308|401|403)
      log_info "公网 API 未认证访问已被拦截：HTTP $status"
      ;;
    200)
      echo "公网 API 在未认证状态返回 HTTP 200，拒绝继续：$PUBLIC_API/categories"
      return 1
      ;;
    *)
      echo "公网 API 安全边界状态异常：HTTP $status"
      return 1
      ;;
  esac
}

trap on_error ERR

log_section "远程安全配置检查"
if [[ "$PUBLIC_BASE_URL" != https://* ]]; then
  echo "必须显式设置 HTTPS PUBLIC_BASE_URL，当前值无效。"
  exit 1
fi
if [ -z "$PUBLIC_API" ]; then
  echo "PUBLIC_API 不能为空。"
  exit 1
fi
if [ -z "$CORS_ORIGINS" ] || printf '%s' "$CORS_ORIGINS" | tr ',' '\n' | grep -Ev '^https://' >/dev/null; then
  echo "远程 CORS_ORIGINS 必须全部使用 HTTPS。"
  exit 1
fi
if [ "$SERVER_AUTH_MODE" != "session" ] && [ "$SERVER_AUTH_MODE" != "trusted_reverse_proxy" ]; then
  echo "SERVER_AUTH_MODE 只能是 session 或 trusted_reverse_proxy。"
  exit 1
fi
if [ ! -f "$DB" ]; then
  echo "生产数据库不存在，部署脚本不会自动创建：$DB"
  exit 1
fi

log_section "后端更新"
cd "$API"
git remote set-url origin "${REPO_URL:-https://github.com/haojiguang88/price-dashboard-api.git}"
git_fetch_retry
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  git checkout -b "$BRANCH" "origin/$BRANCH"
fi
git merge --ff-only "origin/$BRANCH"
COMMIT="$(git rev-parse --short HEAD)"
log_info "当前后端提交：$COMMIT"

log_section "数据库备份"
mkdir -p "$API/db" "$BACKUP_DIR"
if [ -f "$DB" ]; then
  BACKUP="$BACKUP_DIR/price_dashboard_prod_$(date +%Y%m%d_%H%M%S).db"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$BACKUP'"
  else
    cp "$DB" "$BACKUP"
  fi
  log_info "DB backup: $BACKUP"
fi

log_section "Node 依赖和构建"
npm ci
rm -rf node_modules/sqlite3/build
npm rebuild sqlite3 --build-from-source
npm run build

log_section "Python 任务依赖"
python3 -m venv "$API/.venv"
"$PY" -m pip install -U pip
"$PY" -m pip install -r requirements-business-tasks.txt

log_section "写入后端环境"
OLD_ENV_BACKUP=""
if [ -f "$API/.env" ]; then
  OLD_ENV_BACKUP="$API/.env.before_deploy_$(date +%Y%m%d_%H%M%S)"
  cp "$API/.env" "$OLD_ENV_BACKUP"
  log_info "旧 .env 备份：$OLD_ENV_BACKUP"
fi

cat > "$API/.env" <<EOF
NODE_ENV=production
DEPLOYMENT_MODE=remote
HOST=127.0.0.1
PORT=3001
APP_WORKSPACE=business
BUSINESS_DB_PATH=$DB
ALLOW_DB_CREATE=false
TASK_CENTER_PYTHON=$PY
CORS_ORIGINS=$CORS_ORIGINS
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
TRUST_PROXY=loopback
SERVER_AUTH_MODE=$SERVER_AUTH_MODE
AUTH_IDENTITY_HEADER=$AUTH_IDENTITY_HEADER
EOF

append_env_file_entries "$SECRETS_FILE"
if [ -n "$OLD_ENV_BACKUP" ]; then
  append_known_secrets_from_old_env "$OLD_ENV_BACKUP"
fi
if [ "$SERVER_AUTH_MODE" = "session" ]; then
  for key in AUTH_USERNAME AUTH_PASSWORD_HASH AUTH_SESSION_SECRET; do
    if ! grep -qE "^${key}=.+" "$API/.env"; then
      echo "会话认证缺少 ${key}，请先写入 $SECRETS_FILE。"
      exit 1
    fi
  done
  if ! grep -q '^AUTH_SESSION_TTL_HOURS=' "$API/.env"; then
    echo "AUTH_SESSION_TTL_HOURS=12" >> "$API/.env"
  fi
fi
chmod 600 "$API/.env"

if ! grep -q '^TWELVE_DATA_API_KEY=' "$API/.env"; then
  echo "提醒：TWELVE_DATA_API_KEY 未配置，贵金属黄金大盘任务会失败。"
fi
if ! grep -q '^TUSHARE_TOKEN=' "$API/.env"; then
  echo "提醒：TUSHARE_TOKEN 未配置，贵金属白银大盘任务会失败。"
fi

log_section "重启后端"
pm2 restart price-dashboard-api --update-env || pm2 start dist/index.js --name price-dashboard-api --update-env
pm2 save

log_section "验证"
curl_retry "http://127.0.0.1:3001/health" "本机 health"
echo
npm run verify:business-db
verify_public_auth_boundary
echo
echo "=== 后端部署成功 ==="
echo "后端提交：$COMMIT"
