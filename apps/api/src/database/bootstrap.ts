import { migrate } from "./migrate";
import { seed } from "./seed";
import { settings } from "../config";
migrate(settings.migrationUrl)
  .then(() => seed())
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
