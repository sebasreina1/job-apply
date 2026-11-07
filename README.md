# Job Apply

Aplicación local para preparar candidaturas con tu propio CV. Pega la URL, elige inglés, francés o español y pulsa **Preparar CV** o **Preparar y aplicar**.

El programa lee la oferta, compara sus requisitos con tu perfil local y elige los textos correspondientes. Los ejemplos conservan su proyecto o empleo original. La plantilla LaTeX mantiene la foto, las dos columnas, los tipos de letra y la ubicación de cada bloque.

## Ejecutar en VS Code

1. Abre esta carpeta en VS Code. Se necesita Node.js 22 o posterior, Google Chrome y Tectonic accesible desde la terminal.
2. Ejecuta `npm install`. En el equipo de Codex también funciona con Playwright ya instalado en el entorno local.
3. Ejecuta `npm start` en la terminal integrada o selecciona la tarea **Iniciar Job Apply**.
4. Abre [Job Apply](http://127.0.0.1:4328). Mantén abierta la terminal mientras lo usas.

## Flujo de trabajo

- **Preparar CV** crea el PDF sin rellenar el formulario. Puedes revisar el resultado antes de continuar.
- **Preparar y aplicar** rellena y envía cuando el enlace corresponde a un formulario compatible de Lever o Greenhouse y el formulario está completo. Si el enlace original redirige a otro portal, la tarjeta muestra el destino y permite iniciarlo desde allí.
- **Requiere datos** significa que hay campos pendientes, login u otro paso que revisar en la ventana de Chrome. Complétalos allí y pulsa **Rellenar y enviar**. El programa conserva lo que introdujiste. Los campos desconocidos, las preguntas de autorización laboral y las declaraciones legales quedan para que las respondas en el portal.
- Si la página no se puede leer, pega su descripción en la opción manual. Para portales sin integración, la aplicación prepara el CV y ofrece el enlace para aplicar manualmente.
- **Enviado** requiere un mensaje de recepción del portal. **Sin confirmación** requiere revisar la pestaña o el correo. Los intentos de envío se registran antes de pulsar el botón y no se reintentan automáticamente.

## Perfil privado y formato

Este equipo ya tiene configurado `.local/profile.json` con los datos de candidatura y los ejemplos documentados. Modifícalo en VS Code al confirmar nueva experiencia o preferencias. Cada ejemplo contiene etiquetas y texto breve en los tres idiomas. Las claves de posición `x:y` coinciden con los bloques `\place` de `.local/template/main.tex`.

En otro equipo, restaura tu copia privada de `.local/profile.json`, `.local/template/main.tex` y `.local/template/assets/`. El repositorio contiene el código. Los datos, el historial, los CV y la sesión separada de Chrome viven en `.local/`, excluida de Git. El servidor escucha solamente en la interfaz local. El modo local funciona sin clave de IA. El modo de análisis opcional usa únicamente las fichas técnicas descritas abajo.

## Verificación

`npm test` prueba la selección de experiencia, las posiciones LaTeX y la identificación de formularios. `TEST_BROWSER=1 npm test` también prueba Chrome con una oferta y un formulario simulados. La prueba intercepta el tráfico de la página y no contacta a ningún empleador.

## Job Apply 2.0

1. Arranca con `npm start`. En **Fuentes vigiladas**, pega el enlace de la bolsa de una empresa en Greenhouse, Lever o Ashby (por ejemplo, `https://jobs.lever.co/empresa`). La primera lectura guarda las vacantes abiertas para revisión. Después se consultan novedades cada cinco minutos mientras el Mac y Job Apply están activos. **Consultar ahora** adelanta la lectura.
2. Para analizar con IA, configura `.local/.env` con `OPENAI_API_KEY` y `JOB_APPLY_MODEL`, un modelo de OpenAI habilitado para salidas estructuradas. Reinicia Job Apply. El análisis envía el texto público de la oferta y las fichas técnicas necesarias, sin identidad ni contacto. Sin esas variables, Job Apply ofrece puntuación local y prepara borradores.
3. Revisa las vacantes iniciales y activa el envío automático desde el panel cuando esté listo. Solo se encolan coincidencias por encima del 80 % con apoyo explícito para permiso de trabajo. Se prioriza Francia y se aplican los filtros de idioma, puesto y elegibilidad. El máximo son diez intentos por día de Toronto. Las condiciones que no se puedan comprobar, los formularios incompletos y los portales incompatibles quedan para revisión.
4. También puedes pegar hasta 50 enlaces por lote o seleccionar vacantes detectadas. Elige el idioma y usa **Preparar CV** o **Preparar y aplicar**. Los envíos del lote usan los mismos filtros y límite diario. Desde cada tarjeta puedes revisar el CV y continuar explícitamente en Chrome. En el historial, **Ver comprobante** muestra la confirmación guardada y el enlace del portal si está disponible. LinkedIn se tramita manualmente y acepta la descripción pegada para preparar el CV.

### Evidencia para las viñetas

Cada elemento de `experience[].items` en `.local/profile.json` conserva `tags` y `text` (`en`, `fr`, `es`). Para permitir variaciones, añade `facts` por idioma con `action`, `solution`, `technologies` (lista), `scope`, `result` y `metrics` (lista de frases con cifras aprobadas). El modelo elige la estructura y tecnologías de una sola ficha. El programa compone la viñeta usando esos datos, comprueba el espacio en LaTeX y recurre al texto revisado si no cabe. Una cifra sin confirmar no se añade al perfil.

La detección guarda su estado en `.local/monitor.json`. Los intentos, formularios, ofertas, PDF y comprobantes permanecen en `.local/runs`. Un envío sin confirmación permanece bloqueado contra duplicados hasta revisión. Los avisos se muestran mediante las notificaciones locales de macOS.
