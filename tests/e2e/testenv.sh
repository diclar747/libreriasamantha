#!/bin/bash
# Entorno aislado: copia de la base de producción + API temporal en :3099 con el código del repo (nunca toca producción)
IMG=libreriasamantha-libreriasamantha-ukljz7:latest
docker rm -f libsam-testapi libsam-testdb >/dev/null 2>&1
docker run -d --name libsam-testdb -e POSTGRES_USER=libreria -e POSTGRES_PASSWORD=t -e POSTGRES_DB=libreria -p 127.0.0.1:56742:5432 postgres:18 >/dev/null
until docker exec libsam-testdb pg_isready -U libreria >/dev/null 2>&1; do sleep 1; done; sleep 3
docker exec $(docker ps -q -f name=libreriasamantha-libreria-hxawh6) pg_dump -U libreria -d libreria -Fc | docker exec -i libsam-testdb pg_restore -U libreria -d libreria --no-owner >/dev/null 2>&1
NK=$(docker exec $(docker ps -q -f name=libreriasamantha-libreriasamantha-ukljz7) printenv NIRO_API_KEY)
docker run -d --name libsam-testapi --network host -v /root/libreriasamantha/server/src:/app/server/src -e DATABASE_URL=postgres://libreria:t@127.0.0.1:56742/libreria -e PORT=3099 -e HTTPS_PORT=0 -e NODE_ENV=development -e NIRO_API_KEY=$NK -w /app/server $IMG npx tsx src/index.ts >/dev/null
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:3099/api/shop/cities && break; sleep 2; done
# Claves de fábrica SOLO en la copia de prueba
for u in admin:admin1234 caja:caja1234 compras:compras1234 deposito:deposito1234; do n=${u%%:*}; pw=${u##*:}
  H=$(docker exec libsam-testapi sh -c "cd /app/server && npx tsx -e \"import {hashPassword} from './src/auth.ts'; console.log(hashPassword('$pw'))\"" 2>/dev/null | tail -1)
  docker exec libsam-testdb psql -U libreria -d libreria -qc "update users set password_hash='$H' where username='$n'" >/dev/null
done
docker exec libsam-testdb psql -U libreria -d libreria -qc "delete from sessions" >/dev/null
curl -s -o /dev/null -w "api %{http_code}\n" http://127.0.0.1:3099/api/shop/cities
