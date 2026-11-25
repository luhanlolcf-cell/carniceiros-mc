#!/usr/bin/env python3
"""Cria as contas de integrante no Supabase Auth antes do corte de RLS.

A service key e a senha inicial sao lidas SOMENTE de variaveis de ambiente:
  SUPABASE_SERVICE_ROLE_KEY  obrigatoria (nunca colocar no codigo ou no CSV)
  CMC_INITIAL_PASSWORD       necessaria apenas em --password

Uso:
  python database/invite_members.py --dry-run
  python database/invite_members.py                 # envia convite por e-mail
  python database/invite_members.py --password      # cria com senha inicial
"""

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request

URL_DEFAULT = "https://uehaphdmtbmonlojoaic.supabase.co"
CSV_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "member_invites.csv")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def call(url, key, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "apikey": key,
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"message": raw[:200]}
    except urllib.error.URLError as err:
        return 0, {"message": str(err.reason)}


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as handle:
        rows = [r for r in csv.DictReader(handle)]
    for r in rows:
        for field in ("member_id", "email", "road_name", "role"):
            r[field] = (r.get(field) or "").strip()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=CSV_DEFAULT)
    ap.add_argument("--url", default=os.environ.get("SUPABASE_URL", URL_DEFAULT))
    ap.add_argument("--password", action="store_true", help="cria conta com senha inicial em vez de convite")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = read_rows(args.csv)
    if args.dry_run:
        for r in rows:
            print("%-6s %-12s %s" % (r["member_id"], r["role"], r["email"] or "(sem e-mail)"))
        print("total de linhas:", len(rows))
        return 0

    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        print("Defina SUPABASE_SERVICE_ROLE_KEY no ambiente. Ela nao deve aparecer em arquivo ou conversa.")
        return 2

    initial_password = os.environ.get("CMC_INITIAL_PASSWORD", "") if args.password else ""
    if args.password and len(initial_password) < 12:
        print("Defina CMC_INITIAL_PASSWORD no ambiente com pelo menos 12 caracteres.")
        return 2

    status, existing = call(args.url + "/auth/v1/admin/users?per_page=1000", key)
    if status != 200:
        print("Falha ao listar usuarios do Auth:", (existing or {}).get("message", status))
        return 1
    by_email = {u["email"].lower(): u for u in existing.get("users", []) if u.get("email")}

    created, skipped, failed = 0, 0, 0
    for r in rows:
        if not EMAIL_RE.match(r["email"]):
            print("%-6s pulado: e-mail invalido ou de exemplo (%s)" % (r["member_id"], r["email"] or "-"))
            skipped += 1
            continue
        user_id = None
        if r["email"].lower() in by_email:
            user_id = by_email[r["email"].lower()]["id"]
            print("%-6s ja existe no Auth" % r["member_id"])
            skipped += 1
        else:
            meta = {
                "legacy_member_id": r["member_id"],
                "display_name": r["road_name"],
                "role": r["role"],
            }
            if args.password:
                body = {"email": r["email"], "password": initial_password, "email_confirm": True, "data": meta}
                endpoint = "/auth/v1/admin/users"
            else:
                body = {"email": r["email"], "data": meta}
                endpoint = "/auth/v1/admin/invitations"
            status, out = call(args.url + endpoint, key, "POST", body)
            if status in (200, 201):
                created += 1
                user_id = (out or {}).get("id") or ((out or {}).get("user") or {}).get("id")
                print("%-6s %s criado" % (r["member_id"], "senha inicial" if args.password else "convite"))
            else:
                failed += 1
                print("%-6s ERRO %s: %s" % (r["member_id"], status, (out or {}).get("message", "?")))
                continue

        if user_id:
            status, out = call(
                args.url + "/rest/v1/profiles?id=eq." + user_id,
                key,
                "PATCH",
                {"active": True, "display_name": r["road_name"], "role": r["role"]},
            )
            if status not in (200, 204):
                print("%-6s perfil nao ativado (%s)" % (r["member_id"], (out or {}).get("message", status)))
                failed += 1

    print("\ncriados: %d | pulados: %d | falhas: %d" % (created, skipped, failed))
    if args.password:
        print("Oriente cada integrante a trocar a senha inicial na tela Conta Corrente do aplicativo.")
    else:
        print("Cada integrante recebe o e-mail de convite e define a propria senha.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
