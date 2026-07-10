import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

// 輕量讀取 .env,不引入額外套件。已存在的環境變數不會被覆蓋。
export function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  const content = readFileSync(ENV_PATH, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
