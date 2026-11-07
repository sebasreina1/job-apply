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

En otro equipo, restaura tu copia privada de `.local/profile.json`, `.local/template/main.tex` y `.local/template/assets/`. El repositorio contiene el código. Los datos, el historial, los CV y la sesión separada de Chrome viven en `.local/`, excluida de Git. El servidor escucha solamente en la interfaz local. La herramienta no necesita una clave de IA ni envía el perfil a un modelo externo.

## Verificación

`npm test` prueba la selección de experiencia, las posiciones LaTeX y la identificación de formularios. `TEST_BROWSER=1 npm test` también prueba Chrome con una oferta y un formulario simulados. La prueba intercepta el tráfico de la página y no contacta a ningún empleador.
