#!/usr/bin/env bash
# ============================================================================
# CARNICEIROS MC - BACKUP CRIPTOGRAFADO DO POSTGRESQL (AES-256-CBC + PBKDF2)
# ============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  source "${PROJECT_ROOT}/.env"
  set +a
fi

BACKUP_DIR="${PROJECT_ROOT}/backups"
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
RAW_DUMP="${BACKUP_DIR}/carniceiros_mc_${TIMESTAMP}.sql.gz"
ENCRYPTED_DUMP="${RAW_DUMP}.enc"

echo "[1/3] Executando pg_dump compactado da base ${DB_NAME:-carniceiros_mc}..."
PGPASSWORD="${DB_PASSWORD}" /usr/lib/postgresql/15/bin/pg_dump \
  -h 127.0.0.1 \
  -p 5432 \
  -U "${DB_USER:-carniceiros_admin}" \
  -d "${DB_NAME:-carniceiros_mc}" \
  --no-owner --no-acl | gzip -9 > "${RAW_DUMP}"

echo "[2/3] Criptografando dump com OpenSSL AES-256-CBC + PBKDF2 (100.000 iterações)..."
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
  -in "${RAW_DUMP}" \
  -out "${ENCRYPTED_DUMP}" \
  -pass pass:"${JWT_ACCESS_SECRET}"

rm -f "${RAW_DUMP}"
chmod 600 "${ENCRYPTED_DUMP}"

CHECKSUM="$(sha256sum "${ENCRYPTED_DUMP}" | awk '{print $1}')"
echo "[3/3] Backup criptografado concluído: ${ENCRYPTED_DUMP}"
echo "      SHA-256: ${CHECKSUM}"
