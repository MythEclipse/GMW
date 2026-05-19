import "./mock-crc";
import "libsodium-wrappers";
import "@snazzah/davey";
import "dotenv/config";
import { initializeApp } from "./app/bootstrap";
import { createChildLogger } from "./logger";

const logger = createChildLogger("bot");

initializeApp().catch((error) => {
  logger.error({ error }, "Failed to initialize app");
  process.exit(1);
});
