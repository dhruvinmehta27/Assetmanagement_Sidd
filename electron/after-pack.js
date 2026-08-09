"use strict";

/**
 * electron-builder afterPack hook.
 *
 * `extraResources` silently drops any `node_modules` directory, so the Next
 * standalone server ships without the packages it needs and the app dies on
 * launch with "Cannot find module 'next'". Copying the tree ourselves after
 * packing is the reliable way around it.
 *
 * This is Next's *traced* dependency set (~40 MB), not the dev tree — it
 * contains only what the server actually requires at runtime.
 */

const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  const source = path.join(packager.projectDir, ".next", "standalone", "node_modules");
  if (!fs.existsSync(source)) {
    throw new Error(
      `afterPack: ${source} does not exist. Run \`next build\` with output: "standalone" first.`
    );
  }

  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const target = path.join(resources, "standalone", "node_modules");
  fs.cpSync(source, target, { recursive: true, dereference: true });

  // Fail loudly here rather than shipping a .dmg that cannot boot.
  if (!fs.existsSync(path.join(target, "next"))) {
    throw new Error(`afterPack: copy completed but ${target}/next is missing.`);
  }

  console.log(`  • afterPack: copied standalone node_modules -> ${target}`);
};
