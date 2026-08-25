# Desplegar en Railway

Arquitectura: **un servicio Node** (sirve el front y la API) + **un Postgres
administrado**. No hay build step, no hay Dockerfile, no hay volúmenes.

```
Railway Project
├── web        Node/Express — front estático + API + sesiones
└── Postgres   managed, con backups automáticos (plan Pro)
```

---

## Paso 1 — Subir el repo a GitHub

```powershell
git init
git add .
git commit -m "Generador de Contratos SDG - backend + Postgres"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

Hazlo **privado**: aunque no hay secretos en el código, es software interno de RH.

## Paso 2 — Crear el proyecto en Railway

1. **New Project** → **Deploy from GitHub repo** → elige el repo.
2. El primer deploy **va a fallar**, y está bien: todavía no hay base de datos.

## Paso 3 — Agregar Postgres

1. Dentro del proyecto: **+ New** → **Database** → **Add PostgreSQL**.
2. Ve al servicio **web** → pestaña **Variables** → **+ New Variable** →
   **Add Reference** → selecciona `Postgres.DATABASE_URL`.

Con eso el servicio web ya sabe conectarse. Las migraciones corren solas al
arrancar (`src/db.js`), así que no hay que ejecutar nada a mano.

## Paso 4 — Crear el primer master

En **Variables** del servicio web, agrega:

| Variable | Valor |
|---|---|
| `ADMIN_EMAIL` | `it@thecostaricacollection.com` |
| `ADMIN_PASSWORD` | una contraseña temporal (mín. 10 caracteres, letras y números) |
| `ADMIN_NOMBRE` | `Master SDG` |
| `NODE_ENV` | `production` |

Se llaman `ADMIN_*` por compatibilidad, pero crean el rol `master` (ve y
administra todas las propiedades) — es el mismo rol que antes se llamaba
"administrador".

`NODE_ENV=production` **no es opcional**: activa el flag `Secure` en la cookie
de sesión. Sin él la cookie viajaría sin esa protección.

Esas tres variables `ADMIN_*` solo actúan **si no existe ningún master todavía**.
Una vez creado, se pueden borrar — de hecho conviene borrarlas después del
primer ingreso, para no dejar una contraseña en la configuración del proyecto.

## Paso 5 — Generar el dominio

Servicio web → **Settings** → **Networking** → **Generate Domain**.

Con Pro también puedes poner un dominio propio (`rh.thecostaricacollection.com`)
con un CNAME.

## Paso 6 — Entrar

1. Abre `https://tu-dominio/empleador.html`
2. Entra con `ADMIN_EMAIL` y la contraseña temporal.
3. Te va a obligar a cambiarla — es intencional.
4. Crea los usuarios de cada propiedad desde ahí.
5. Cada persona entra en `https://tu-dominio/` con su cuenta.

---

## Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | sí | La inyecta Railway al referenciar Postgres |
| `NODE_ENV` | sí | `production` activa la cookie `Secure` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | primer arranque | Crea el master inicial |
| `ADMIN_NOMBRE` | no | Nombre del master inicial |
| `SESION_HORAS` | no | Duración de sesión (por defecto 12) |
| `PG_POOL_MAX` | no | Conexiones del pool (por defecto 10) |
| `PGSSL` | no | `require` si el Postgres es externo a Railway |
| `PORT` | **no la definas** | La inyecta Railway |

---

## Verificación post-deploy

```
https://tu-dominio/healthz       → ok
https://tu-dominio/healthz/db    → {"ok":true,"hora":...,"bd":"railway"}
https://tu-dominio/              → app de contratos (pide login)
https://tu-dominio/empleador.html → panel de administración
```

`/healthz` a propósito **no** toca la base de datos: si Postgres se pone lento,
Railway no debe matar el servicio web. Para diagnosticar la BD está `/healthz/db`.

---

## Cómo funciona el histórico

Esta es la parte que justifica todo lo demás.

**Nada se borra.** `DELETE` desde la app marca `eliminado_en` y sube la versión;
la fila sigue ahí. Cada escritura queda registrada en `documentos_historial`
con el valor anterior, quién lo hizo, desde qué IP y cuándo.

**El historial lo escribe un trigger de Postgres, no la API.** Si mañana un bug
en el backend olvidara registrar un cambio, el trigger igual lo registra. Y las
tablas de histórico tienen un trigger que **rechaza cualquier UPDATE o DELETE**.

**Los contratos emitidos se congelan.** `POST /api/documentos` guarda el archivo
tal como se generó, con su SHA-256. No se regenera desde plantillas: si la
plantilla cambia en marzo, regenerar un contrato de enero produciría un
documento distinto al que la persona firmó.

Consultar el histórico de un documento:

```
GET /api/historial?clave=contrato:001
GET /api/historial                      (actividad reciente de la propiedad)
```

**Alcance honesto de la inmutabilidad:** los triggers detienen bugs de la
aplicación y errores manuales. Un superusuario de Postgres podría quitarlos.
La protección contra eso son los backups de Railway y el control de acceso a
las credenciales de la base de datos.

---

## Roles

| Rol | Leer | Editar y subir | Administrar usuarios | Propiedades |
|---|---|---|---|---|
| **Master** | sí | sí | sí | todas |
| **Gerente** | sí | sí | no | solo la suya |
| **Colaborador** | sí | no | no | solo la suya |

El master además puede consultar cualquier propiedad — pero tiene que fijar
con cuál está trabajando en cada momento (menú Ajustes → Cambiar de
propiedad); esa elección viaja en cada llamada a la API. Gerentes y
colaboradores no eligen nada: su propiedad es la que tiene fija su cuenta.

Los permisos los aplica el servidor en cada petición (`requiereEscritura`,
`requiereAdmin`). El front esconde botones y marca la app en modo solo lectura,
pero eso es comodidad visual, no seguridad.

Un cambio de rol surte efecto de inmediato, sin que la persona vuelva a entrar:
las sesiones consultan el rol en cada petición, no lo llevan congelado en un
token.

`ADMIN_EMAIL` crea siempre un master. Los demás usuarios se crean desde
`empleador.html` eligiendo su rol.

---

## Aislamiento entre propiedades

La propiedad **siempre sale de la sesión del usuario**, nunca de un parámetro
del navegador. Un trabajador de Oxygen que manipule la petición para pedir
`?propiedad=corcovado` recibe sus propios datos, no los de Corcovado. Solo un
master puede consultar otra propiedad.

Esto es lo que antes no existía: el candado vivía en el navegador, donde
cualquiera con las herramientas de desarrollador podía saltárselo.

---

## Backups

Railway Pro hace backups automáticos de Postgres. Verifica en el servicio
Postgres → **Settings** → **Backups** que estén activos y con la retención que
necesites.

Como los archivos congelados viven **dentro** de Postgres (columna `bytea`),
entran en esos mismos backups. Ese fue el motivo de la decisión: para un
histórico legal, que los documentos y sus metadatos se respalden juntos vale
más que la escalabilidad de un almacenamiento externo.

Si el volumen crece a varios GB, migrar a S3/R2 es un cambio acotado —
`documentos_emitidos` ya separa metadatos de contenido.

---

## Probar en local

Necesitas un Postgres. Con Docker:

```powershell
docker run -d --name sdg-pg -e POSTGRES_PASSWORD=local -p 5432:5432 postgres:16
$env:DATABASE_URL="postgresql://postgres:local@127.0.0.1:5432/postgres"
$env:ADMIN_EMAIL="admin@local.test"
$env:ADMIN_PASSWORD="LocalAdmin2026"
npm start
```

Sin `NODE_ENV=production` la cookie no lleva `Secure`, que es lo correcto para
`http://localhost`.

---

## Costo

Servicio web + Postgres en Pro. La app consume poco; el gasto real lo marca
Postgres y su almacenamiento. Con documentos congelados dentro de la BD, vigila
el crecimiento en la pestaña de métricas del servicio Postgres.
