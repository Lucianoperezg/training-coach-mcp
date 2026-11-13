[English](README.md) · **Español**

# Training Coach MCP

**La arquitectura para montar tu propio entrenador con IA** en una cuenta gratis de Cloudflare. Trabaja con tus datos reales: los de tu reloj y, si quieres, los de tu app de gimnasio.

El núcleo es genérico. Sincroniza tus datos, los guarda en tu propia base de datos y deja que Claude los consulte con un conector MCP remoto, desde la web, el móvil o el escritorio.

El **entrenador de carrera y fuerza** de [`claude-ai/`](claude-ai/) es solo un ejemplo montado encima. Cópialo y adáptalo a tu deporte, tus objetivos y tus reglas.

<!-- screenshots -->

## Qué conecta

- **intervals.icu.** Recibe tus actividades de **Garmin, COROS, Polar, Suunto, Wahoo** y muchos más, y calcula carga, zonas y forma. Es la fuente principal.
- **Hevy** (opcional). Tus entrenos de fuerza y tus rutinas. Sin Hevy, todo lo demás funciona igual.

```
Reloj ─► app del reloj ─► intervals.icu ─┐
                                         ├─► Cloudflare Worker (sincroniza cada 15 min) ─► base D1
App Hevy (opcional) ─────────────────────┘                                                  │
                                                                                            ▼
                                             Claude (claude.ai) ◄── conector MCP ◄── herramientas
```

Tres capas, cada una con su función:

| Capa | Dónde | Qué hace |
|---|---|---|
| **Datos** | Servidor MCP + D1 (esta repo) | Sincroniza, guarda y calcula. Es igual para cualquier entrenador |
| **Reglas** | Instrucciones del proyecto en claude.ai | Quién es el entrenador y cómo responde |
| **Procedimientos** | Skills de claude.ai | Cómo se hace una tarea concreta, por ejemplo dibujar una gráfica |

Más detalle, en inglés, en [`docs/architecture.md`](docs/architecture.md) y [`docs/data-provenance.md`](docs/data-provenance.md).

## Herramientas que usa Claude

> **Nota:** los nombres de las herramientas, los campos y las salidas están en **español**, porque el proyecto nació así. A Claude le da igual: puedes hablarle en el idioma que quieras.

| Herramienta | Para qué | ¿Escribe? |
|---|---|---|
| `revisar_actividad` | Revisión completa de un entreno en una llamada: zonas de FC, parciales por km, deriva, recuperación de FC, comparación con entrenos parecidos de las 8 semanas anteriores, plan del día, forma y alertas | No |
| `estado_atleta` | Resumen para planificar: forma, carga de 7 y 28 días, recuperación (sueño, FC en reposo, VFC, pasos), último entreno duro, gimnasio reciente, notas, umbrales, sincronización y alertas | No |
| `historial` | Resumen por semanas: volumen, tirada larga, zonas y series de gimnasio por grupo muscular | No |
| `progreso` | Tendencia de una métrica (eficiencia, ritmo, FC, cadencia, km, carga, forma, FC en reposo, VFC) o de un ejercicio, solo con semanas terminadas | No |
| `ver_plan` | Tu calendario de intervals.icu y, en los días pasados, lo que hiciste de verdad | No |
| `tramos` | Analiza tramos que no son vueltas oficiales: perfil de ritmo, cadencia y FC, escalones detectados, medias exactas de un tramo o un patrón de series | No |
| `consulta_sql` | Cualquier otra pregunta, solo lectura, sobre una lista fija de vistas | No |
| `nota` | Notas que el entrenador recuerda entre chats (sensaciones, molestias, objetivos). También marca alertas como resueltas | **Sí** |
| `estado` | Estado compartido entre chats, con historial de versiones: objetivo, plan, rutina, decisiones y reglas | **Sí** |
| `programar_entrenos` | Crea, cambia o borra entrenos de tu calendario de intervals.icu en dos pasos: primero la vista previa y, cuando confirmas, el cambio. Solo toca entrenos futuros creados por él | **Sí** |
| `programar_rutinas` | Crea, cambia o restaura rutinas de Hevy en dos pasos, con una copia antes de cada cambio. **Solo aparece si configuras Hevy** | **Sí** |

## Requisitos

- Una cuenta de **intervals.icu** (gratis), conectada a tu reloj.
- Una cuenta de **Cloudflare** (gratis).
- **Node.js** LTS en tu ordenador, solo para instalarlo. Después no se ejecuta nada en tu ordenador.
- Una cuenta de **claude.ai** que permita añadir conectores personalizados.
- Opcional: **Hevy**.

## Instalación paso a paso

No hace falta saber programar: copiarás y pegarás unos comandos en una terminal. Lleva unos 20 minutos.

### 1. intervals.icu

1. Crea una cuenta en [intervals.icu](https://intervals.icu).
2. En **Settings → Connections**, conecta tu reloj (Garmin, COROS, Polar, Suunto…). Empezarán a llegar tus actividades.
3. **Pon tus umbrales.** En **Settings**, en los ajustes del deporte de carrera (y de cualquier otro que hagas), rellena tu **FC umbral (LTHR)**, tu **FC máxima** y tu **ritmo umbral**. El MCP saca tus zonas de ahí y no tiene nada escrito a mano: si están mal, el análisis también lo estará.
4. Al final de **Settings**, en **Developer Settings**, crea tu **API key** y tenla a mano.

### 2. Hevy (opcional)

En la app de Hevy, abre **Ajustes → Developer** y genera tu **API key**. Si te saltas este paso, el entrenador funciona igual, solo que sin datos de gimnasio ni rutinas.

### 3. Cloudflare y Node.js

1. Crea una cuenta gratis en [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Instala **Node.js LTS** desde [nodejs.org](https://nodejs.org). Para comprobarlo, abre una terminal y escribe `node --version`.
3. Descarga esta repo: botón verde **Code** → **Download ZIP**, y descomprímela. Abre una terminal dentro de esa carpeta.

### 4. Instalar e iniciar sesión

```bash
npm install
```

```bash
npx wrangler login
```

El segundo comando abre el navegador para que des acceso a tu cuenta de Cloudflare.

### 5. Crear la base de datos (D1)

```bash
npx wrangler d1 create entrenos
```

Te enseña un `database_id`. Abre `wrangler.toml` con cualquier editor de texto y pégalo donde pone `PEGA_AQUI_EL_ID`.

### 6. Tu zona horaria y tu reloj en `wrangler.toml`

En el mismo archivo, en el apartado `[vars]`:

- **`TZ`**: tu zona horaria en [formato IANA](https://es.wikipedia.org/wiki/Anexo:Zonas_horarias_de_la_base_de_datos_tz), por ejemplo `"Europe/Madrid"` o `"America/Mexico_City"`. Decide qué es "hoy" y pasa las fechas de Hevy a tu fecha local. **Ponla siempre.** Si borras la línea, el servidor usa `Europe/Madrid`.
- **`WATCH`**: escribe `"suunto"` si tu reloj es un Suunto; si no, déjalo vacío (`""`). Suunto enseña la sensación del entreno ("feel") con la escala al revés, y con este ajuste el entrenador te dice también el valor tal como lo ves en el reloj.

Guarda el archivo.

### 7. Crear las tablas

```bash
npm run db:init
```

### 8. Guardar los secretos

Los secretos se guardan cifrados en Cloudflare, nunca en un archivo. Cada comando te pide el valor. Al pegarlo no se ve en pantalla.

Primero necesitas un **token**: una contraseña larga y aleatoria que protege tu servidor. Usa un generador de contraseñas con 40 caracteres o más, solo letras y números. O, en Windows, en PowerShell:

```powershell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
```

En Mac o Linux:

```bash
openssl rand -hex 32
```

Guárdalo en un sitio seguro y después:

```bash
npx wrangler secret put MCP_TOKEN
```

```bash
npx wrangler secret put INTERVALS_API_KEY
```

```bash
npx wrangler secret put HEVY_API_KEY
```

Sáltate el último si no usas Hevy.

### 9. Publicar

```bash
npm run deploy
```

Te enseña tu URL: `https://entrenos-mcp.<tu-subdominio>.workers.dev`. Para comprobar que funciona, abre `https://entrenos-mcp.<tu-subdominio>.workers.dev/health` en el navegador. Debe salir `{"ok":true,...}`.

**El histórico se importa solo, por tramos.** Cada 15 minutos importa unos 6 meses de actividades y hasta 80 entrenos de Hevy, así que varios años tardan unas pocas horas. Mientras tanto, `estado_atleta` dice por dónde va.

### 10. Conectarlo a claude.ai

1. En claude.ai, abre **Settings → Connectors** y añade un **conector personalizado**, sin OAuth, con esta URL:

   ```
   https://entrenos-mcp.<tu-subdominio>.workers.dev/mcp/<TU_MCP_TOKEN>
   ```

2. En los permisos de las herramientas del conector, pon las que escriben (`nota`, `estado`, `programar_entrenos`, `programar_rutinas`) en **"Preguntar siempre"**.
3. Crea un **proyecto** en claude.ai. Pega las instrucciones de ejemplo de [`claude-ai/es/instrucciones-proyecto.md`](claude-ai/es/instrucciones-proyecto.md) adaptadas a ti y, si quieres gráficas, añade la skill [`graficas`](claude-ai/es/skills/graficas/).

Prueba a preguntarle: *"¿Cómo ha evolucionado mi press banca en los últimos 3 meses?"* o *"¿Me estoy pasando esta semana sumando gimnasio y carrera?"*

## Coste

**0 € en el plan gratis de Cloudflare.** No pide tarjeta, así que no te puede cobrar. El uso queda muy por debajo de los límites:

- 100.000 peticiones al día. La sincronización gasta unas 100, más tus preguntas.
- 500 MB de base de datos, que dan para muchos años de entrenos.
- Un límite de CPU por ejecución. Por eso el histórico se importa por tramos.

Un aviso: los parciales por km se calculan con los datos segundo a segundo de intervals.icu. En una actividad muy larga (un ultra de muchas horas) podría pasarse del límite de CPU del plan gratis. En ese caso la revisión sale sin parciales y lo demás funciona igual.

intervals.icu es gratis. Hevy es opcional.

## Seguridad

- **El token va en la URL, así que la URL es tu contraseña: no la compartas.** Quien tenga la URL completa puede leer tus entrenos y también escribir: guardar notas, cambiar el estado compartido, tocar los entrenos del MCP en tu calendario de intervals.icu y cambiar tus rutinas de Hevy.
- Si se filtra, cámbialo con `npx wrangler secret put MCP_TOKEN` y actualiza el conector en claude.ai.
- Pon las herramientas que escriben en **"Preguntar siempre"** en claude.ai, para que Claude no cambie nada sin que lo veas antes.
- Con un token incorrecto el servidor responde 404, y `/health` no enseña datos. `/mcp` admite 60 peticiones por minuto y por IP, lo que también frena a quien intente adivinar el token.
- Las API keys se guardan como secretos cifrados en Cloudflare, no en el código.
- `consulta_sql` solo acepta una consulta `SELECT`/`WITH` sobre una lista de vistas permitidas. D1 no tiene modo de solo lectura, así que ese filtro es la única defensa: tenlo en cuenta si lo cambias.

## No es consejo médico

Es un proyecto personal para analizar tus propios datos de entrenamiento. **No es consejo médico y no sustituye a un médico, un fisioterapeuta ni un entrenador titulado.** La IA se puede equivocar. Si tienes dolor, síntomas raros o algún problema de salud, ve a un profesional.

## Mantenimiento

```bash
npm run logs        # ver en directo lo que hace (sincronizaciones, errores)
npm run deploy      # publicar cambios del código
npm run typecheck   # tipos + tests
npm run db:init     # aplicar migraciones nuevas a la base de datos
npx wrangler d1 export entrenos --remote --output=copia.sql   # copia de seguridad de tus datos
```

## Probar en local

```bash
cp .dev.vars.example .dev.vars           # rellena tus claves
npm run db:init:local
npm run dev                              # MCP en http://localhost:8787/mcp/<MCP_TOKEN>
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"   # lanza una sincronización
```

## Problemas frecuentes

### `/health` da `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` en una cuenta de Cloudflare nueva

Al abrir `https://entrenos-mcp.<tu-subdominio>.workers.dev/health`, el navegador dice "Este sitio web no puede proporcionar una conexión segura".

- **Causa:** tu subdominio workers.dev es nuevo y todavía no tiene el certificado. Cloudflare tarda en crearlo desde unos minutos hasta unos 30.
- **Solución:** espera, cierra la pestaña y vuelve a abrirla. El Worker ya funciona aunque el navegador falle.

<!-- Añade aquí más casos: ### Síntoma, y después **Causa** y **Solución**. -->

## Limitaciones

- Las métricas que calcula solo la app de tu marca de reloj (por ejemplo, su propia puntuación de recuperación) no llegan a intervals.icu, así que tampoco al entrenador. Sí llegan los datos del archivo de la actividad: FC, GPS, cadencia, altitud, vueltas…
- Los umbrales configurados en el propio reloj no se usan. Se usan los de intervals.icu.
- La API de Hevy no deja borrar rutinas ni cambiarlas de carpeta. Eso se hace en la app.

## Licencia

[MIT](LICENSE).
