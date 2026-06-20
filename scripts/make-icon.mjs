import sharp from "sharp";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "media/icon.svg"));

await sharp(svg)
  .resize(128, 128)
  .png()
  .toFile(join(root, "media/icon.png"));

console.log("✓ media/icon.png written (128×128)");
