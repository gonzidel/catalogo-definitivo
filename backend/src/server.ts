import "dotenv/config";
import express from "express";
import cors from "cors";
import invoicesRouter from "./routes/invoices";

const app = express();

const corsOrigin =
  process.env.CORS_ORIGIN || "http://localhost:5500";

app.use(
  cors({
    origin: corsOrigin,
    exposedHeaders: ["Content-Disposition", "X-Drive-Upload"],
  })
);
app.use(express.json());
app.use("/api/invoices", invoicesRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`Invoice server → http://localhost:${port}`);
});
