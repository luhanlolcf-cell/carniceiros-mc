#!/usr/bin/env bash
# Teste E2E: Solicitar Cadastro -> login bloqueado -> Diretoria aprova -> login OK -> RBAC da lista
set -u
API=http://127.0.0.1:4000/api
C() { curl -s --noproxy "*" -H "Content-Type: application/json" "$@"; }
J=/tmp/cmc_dir.jar; P=/tmp/cmc_pro.jar; rm -f $J $P
EMAIL="pistao$RANDOM@mail.com"
ROAD=$(tr -dc a-z </dev/urandom | head -c6)
REG='{"fullName":"João Pistão","roadName":"Pistão '$ROAD'","email":"'$EMAIL'","password":"Moto#2026x","phoneWhatsapp":"(41) 99999-1234","emergencyContactName":"Maria","emergencyContactPhone":"(41) 98888-1111","motorcycle":"Yamaha Drag Star","referral":"Caveira","acceptTerms":true,"website":""}'
echo "1) register:"; C -X POST $API/auth/register -d "$REG" -w ' [%{http_code}]\n'
echo "2) register duplicado (resposta idêntica):"; C -X POST $API/auth/register -d "$REG" -w ' [%{http_code}]\n'
echo "3) honeypot preenchido:"; C -X POST $API/auth/register -d "${REG/\"website\":\"\"/\"website\":\"spam\"}" -w ' [%{http_code}]\n' | cut -c1-80
echo "4) login pendente:"; C -X POST $API/auth/login -d '{"email":"'$EMAIL'","password":"Moto#2026x"}' -w ' [%{http_code}]\n'
echo "5) login diretoria:"; C -c $J -X POST $API/auth/login -d '{"email":"bob@carniceirosmc.com.br","password":"Carniceiros#2026"}' -o /dev/null -w '[%{http_code}]\n'
echo "6) pendentes:"; PEND=$(C -b $J $API/club/members/pending); echo "$PEND" | cut -c1-200; echo
ID=$(echo "$PEND" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d).pending;console.log(p[p.length-1].id)})")
echo "7) aprovar $ID:"; C -b $J -X PATCH $API/club/members/$ID/approve -w ' [%{http_code}]\n'
echo "8) login aprovado:"; C -c $P -X POST $API/auth/login -d '{"email":"'$EMAIL'","password":"Moto#2026x"}' -o /dev/null -w '[%{http_code}]\n'
echo "9) lista vista pelo prospect (sem contatos):"; C -b $P $API/club/members | cut -c1-260; echo
echo "10) prospect tenta aprovar (RBAC):"; C -b $P -X PATCH $API/club/members/$ID/approve -w ' [%{http_code}]\n'
echo "11) diretoria promove a Full Patch:"; C -b $J -X PATCH $API/club/members/$ID/role -d '{"role":"MEMBRO"}' -w ' [%{http_code}]\n'
echo "12) diretoria suspende:"; C -b $J -X PATCH $API/club/members/$ID/status -d '{"status":"SUSPENSO"}' -w ' [%{http_code}]\n'
echo "13) login suspenso:"; C -X POST $API/auth/login -d '{"email":"'$EMAIL'","password":"Moto#2026x"}' -w ' [%{http_code}]\n'
