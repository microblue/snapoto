import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { root } from "./store.mjs";
export function persistAsset(id, bytes) {
  const file = path.join(root, "assets", id),
    temp = file + ".tmp";
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    const directory = openSync(path.dirname(file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw e;
  }
  return file;
}
