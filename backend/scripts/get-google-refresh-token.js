// Script de un solo uso: autoriza esta app contra tu cuenta personal de Google
// y obtiene el "refresh token" que el backend va a usar para siempre después
// (no hace falta volver a correr esto salvo que revoques el acceso).
//
// Uso: node scripts/get-google-refresh-token.js
// Requiere GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET ya cargados en backend/.env

require("dotenv/config");
const http = require("http");
const { google } = require("googleapis");

const PORT = 4321;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en backend/.env. Completalos primero."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // fuerza a que Google devuelva refresh_token incluso si ya autorizaste antes
  scope: ["https://www.googleapis.com/auth/drive.file"],
});

console.log("\nAbrí esta URL en tu navegador, con la cuenta de Google que querés usar:\n");
console.log(authUrl);
console.log("\nEsperando que autorices en el navegador...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Falta el parámetro code en la respuesta de Google.");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Listo, ya podés cerrar esta pestaña y volver a la terminal.");

    console.log("Autorización exitosa. Agregá esta línea a backend/.env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("");

    if (!tokens.refresh_token) {
      console.warn(
        "ADVERTENCIA: Google no devolvió un refresh_token. Si ya habías autorizado esta app antes, " +
        "revocá el acceso en https://myaccount.google.com/permissions y volvé a correr este script."
      );
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Error intercambiando el código por tokens, mirá la terminal.");
    console.error("Error:", err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`(servidor temporal escuchando en http://localhost:${PORT})`);
});
