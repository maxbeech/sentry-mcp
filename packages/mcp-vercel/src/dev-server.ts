import app from "./index.js";

const port = Number(process.env.PORT) || 8790;
app.listen(port, () => {
  console.log(`sentry-mcp-vercel listening on http://localhost:${port}`);
});
