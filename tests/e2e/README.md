# Pruebas de uso real (end-to-end)

Se ejecutan **siempre contra una copia aislada** de la base de producción (nunca contra producción):

```bash
./testenv.sh                      # copia de la DB + API temporal en :3099 (claves de fábrica solo en la copia)
docker run -d --name libsam-vite --network host \
  -v $PWD/../../web/src:/app/web/src -v $PWD/../../web/public:/app/web/public -v $PWD/../../web/index.html:/app/web/index.html \
  -v $PWD/vite.test.config.ts:/app/web/vite.test.config.ts <imagen-de-la-app> sh -c 'cd /app/web && /app/node_modules/.bin/vite --config vite.test.config.ts'
ln -s <ruta>/node_modules pw/node_modules   # Playwright 1.55 + chromium 1187 (ver executablePath en los scripts)
node crawl.mjs                    # todas las pantallas y pestañas: errores JS/HTTP y desbordes
node fuzz-get.mjs                 # GET de todas las rutas con filtros vacíos/inválidos: ningún 500 (get-routes.txt: grep de `.get('` en server/src)
node formfuzz.mjs                 # abre y envía todos los formularios "Nuevo…"
node pos-e2e.mjs / store-e2e.mjs / orders-e2e.mjs / purch-e2e.mjs / money-api.mjs / roles-e2e.mjs / acct-e2e.mjs
node ui-uso.mjs <dir> <foto.jpg>  # producto con foto de 10 MB y montos tecleados dígito a dígito
```
