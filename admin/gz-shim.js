// admin/gz-shim.js
// Reemplazo de qz-tray.js: implementa el subconjunto de la API `qz` que usa
// este admin (websocket, security no-op, printers, configs, print), hablando
// con el agente local GZ (gz-agent) en vez de QZ Tray. Sin certificados ni
// firma: es software propio, no hace falta pedir permiso a nadie por conexión.
(function () {
  if (window.qz && window.qz.__isGZ) return;

  var GZ_BASE = window.GZ_AGENT_URL || "http://127.0.0.1:8785";
  var connected = false;

  function req(path, opts) {
    return fetch(GZ_BASE + path, opts).then(function (res) {
      if (!res.ok) {
        return res
          .text()
          .catch(function () {
            return "";
          })
          .then(function (t) {
            throw new Error("GZ agent HTTP " + res.status + (t ? ": " + t : ""));
          });
      }
      return res.json();
    });
  }

  var qz = {
    __isGZ: true,

    websocket: {
      isActive: function () {
        return connected;
      },
      connect: function () {
        return req("/status")
          .then(function () {
            connected = true;
          })
          .catch(function (err) {
            connected = false;
            var e = new Error(
              "No se pudo conectar con el agente GZ en " +
                GZ_BASE +
                ". Verificá que gz-agent.exe esté corriendo en esta PC."
            );
            e.stack = err && err.stack;
            throw e;
          });
      },
      disconnect: function () {
        connected = false;
        return Promise.resolve();
      },
    },

    // GZ no usa certificados ni firma: no-ops para mantener compatible
    // el código que aún llama a estas funciones.
    security: {
      setCertificatePromise: function () {},
      setSignaturePromise: function () {},
      setSignatureAlgorithm: function () {},
    },

    printers: {
      find: function (query) {
        return req("/printers").then(function (data) {
          var list = data.printers || [];
          if (!query) return list;
          var q = String(query).toLowerCase();
          return list.filter(function (p) {
            return p.toLowerCase().indexOf(q) !== -1;
          });
        });
      },
      getDefault: function () {
        return req("/printers").then(function (data) {
          if (!data.default) {
            throw new Error("No hay impresora predeterminada configurada en Windows.");
          }
          return data.default;
        });
      },
    },

    configs: {
      create: function (printerName, options) {
        return { printer: printerName, options: options || {} };
      },
    },

    print: function (config, data) {
      var printerName = config && config.printer;
      if (!printerName) {
        return Promise.reject(new Error("Config de impresora inválida"));
      }
      return req("/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printer: printerName, jobs: data }),
      }).then(function () {});
    },
  };

  window.qz = qz;
})();
