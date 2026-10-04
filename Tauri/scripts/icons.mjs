// Regenerates src-tauri/icons from the two sources in assets/ (`npm run icons`).
//
// Two sources because the platforms disagree on margins: Windows and Linux show
// an icon edge to edge, while a macOS icon sits on Apple's 1024 grid with room
// around the tile for its shadow — rendered edge to edge it looks oversized next
// to every other icon in the Dock. Everything comes from icon.svg except
// icon.icns. The mobile sets are dropped; this app is desktop only.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "src-tauri/icons";

function icon(source, output) {
  execFileSync("npx", ["tauri", "icon", source, "--output", output], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

icon("assets/icon.svg", OUT);

const mac = mkdtempSync(join(tmpdir(), "chat-icons-"));
try {
  icon("assets/icon-macos.svg", mac);
  copyFileSync(join(mac, "icon.icns"), join(OUT, "icon.icns"));
} finally {
  rmSync(mac, { recursive: true, force: true });
}

for (const dir of ["android", "ios"]) {
  rmSync(join(OUT, dir), { recursive: true, force: true });
}
