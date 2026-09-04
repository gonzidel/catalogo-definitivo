// gz-agent/tray.js
// Icono en la bandeja del sistema (Windows) para saber que GZ está corriendo,
// con opción de salir desde ahí. Usa systray2, que ejecuta un binario nativo
// (portable, sin Electron); copyDir:true lo saca del snapshot de pkg a un
// directorio real antes de ejecutarlo.
const fs = require("fs");
const path = require("path");
const SysTray = require("systray2").default;

function resourcePath(...segments) {
  // Cuando corre empaquetado con pkg, __dirname apunta al snapshot virtual,
  // pero los assets sueltos (no .js) se resuelven igual gracias a la config
  // "assets" del package.json (pkg los deja disponibles en el mismo layout).
  return path.join(__dirname, ...segments);
}

function startTray(port, onExit) {
  const iconPath = resourcePath("assets", "tray-icon.ico");
  if (!fs.existsSync(iconPath)) {
    console.warn("[GZ] tray-icon.ico no encontrado, se omite el ícono de bandeja");
    return null;
  }

  const itemExit = {
    title: "Salir",
    tooltip: "Cerrar GZ Agent",
    checked: false,
    enabled: true,
    click: () => {
      systray.kill(false);
      if (onExit) onExit();
      process.exit(0);
    },
  };

  const systray = new SysTray({
    menu: {
      icon: iconPath,
      title: "GZ",
      tooltip: `GZ Agent — imprimiendo en 127.0.0.1:${port}`,
      items: [
        {
          title: `GZ Agent activo (puerto ${port})`,
          tooltip: "",
          checked: false,
          enabled: false,
        },
        SysTray.separator,
        itemExit,
      ],
    },
    debug: false,
    copyDir: true,
  });

  systray.onClick((action) => {
    if (action.item && action.item.click) action.item.click();
  });

  systray.ready().catch((err) => {
    console.warn("[GZ] no se pudo iniciar el ícono de bandeja:", err.message);
  });

  return systray;
}

module.exports = { startTray };
