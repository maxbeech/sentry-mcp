import app from "./index.js";
import { serve, shutdownOnSignals } from "./listen.js";

// The container entry. dev-server.ts stays as the local watch-mode listener and
// keeps its own default port; this one follows the platform's PORT.
const server = await serve(app);
shutdownOnSignals(server);
const address = server.address();
console.log(
  `sentry-mcp listening on ${typeof address === "object" && address ? `${address.address}:${address.port}` : address}`,
);
