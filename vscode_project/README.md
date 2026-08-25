# Generador de Contratos SDG

App de RH para generar contratos, acciones de personal y permisos de las cuatro
propiedades (Corcovado, Oxygen, Ojochal, Amarena), con usuarios, base de datos y
histórico legal.

## Archivos de esta carpeta (el front)

| Archivo | Qué es |
|---|---|
| `index.html`, `style.css`, `app.js` | La app **Trabajadores** (contratos, empleados, permisos) |
| `storage-api.js` | Capa de datos contra la API. Define `window.storage` y `window.sdgApi` |
| `empleador.html` | Panel de **administración**: crea y administra usuarios, ve la bitácora |
| `archivo_unico_respaldo.html` | Versión antigua en un solo archivo, sin backend (histórica) |

El backend vive en `../src/` y el esquema en `../migrations/`. Para desplegar,
ver **`../DESPLIEGUE_RAILWAY.md`**.

## Cómo funciona

- **Los datos viven en Postgres**, no en el navegador. Todo el equipo ve la
  misma información y nada se pierde si alguien cambia de computadora.
- **Cada persona entra con su cuenta.** La propiedad se asigna según el usuario;
  el servidor no le muestra datos de otra propiedad aunque manipule la petición.
- **Nada se borra.** Borrar marca el registro como eliminado; el histórico
  conserva todas las versiones con autor, fecha e IP.
- **Los contratos emitidos se congelan** con su huella SHA-256, para que el
  documento archivado sea exactamente el que se firmó.

## Probar en local

Necesita Postgres y las variables de entorno. Desde la raíz del proyecto:

```powershell
npm install
$env:DATABASE_URL="postgresql://postgres:local@127.0.0.1:5432/postgres"
$env:ADMIN_EMAIL="admin@local.test"
$env:ADMIN_PASSWORD="LocalAdmin2026"
npm start
```

Y abre `http://localhost:8000` (Trabajadores) o
`http://localhost:8000/empleador.html` (administración).

⚠️ No abras estos archivos con doble clic (`file://`) — sin servidor no hay API,
ni sesión, ni datos.

### Modo sin backend

Si se quita `<script src="storage-api.js">` de `index.html`, la app cae a
`localStorage` y al selector manual de propiedad, como funcionaba antes. Sirve
para probar la interfaz sin levantar nada, pero **los datos quedan solo en ese
navegador** — no usar en producción.

## Librerías de terceros

Empaquetadas en `vendor/` (no se cargan desde ningún CDN):

- **xlsx.js** — leer archivos Excel al importar empleados
- **pdf.js** — leer los PDF de las colillas de pago

Antes se cargaban desde cdnjs.cloudflare.com; un firewall corporativo o un
bloqueador de anuncios que frenara ese dominio dejaba a algunas personas sin
poder importar Excel, en silencio. Al vivir dentro del propio proyecto, esas
dos funciones ya no dependen de la red de quien las use — solo de que el
servidor esté arriba, igual que el resto de la app.

## Roles

| Rol | Leer | Editar y subir | Administrar usuarios |
|---|---|---|---|
| **Administrador** | sí | sí | sí |
| **Gerente** | sí | sí | no |
| **Colaborador** | sí | no | no |

Los tres permisos los aplica el **servidor** en cada petición. La interfaz
esconde botones y marca la app en modo solo lectura para los colaboradores,
pero eso es comodidad visual: quien manipule la petición choca igual contra el
permiso del backend.

Los roles se asignan desde `empleador.html`. Un cambio de rol surte efecto de
inmediato, sin que la persona tenga que volver a entrar.

## Archivado automático

Al generar un contrato, constancia, carta de despido, recomendación o acción de
personal, el documento se archiva solo en `documentos_emitidos`: se guarda el
HTML tal como se mostró, con el CSS incrustado y su huella SHA-256. No se
regenera desde plantillas, así que el archivo de enero se abre igual aunque la
plantilla cambie en marzo.

Los adjuntos de empleado (cédula, foto, títulos) también van al servidor; en la
ficha queda solo una referencia `doc:<id>`, no el archivo incrustado.
