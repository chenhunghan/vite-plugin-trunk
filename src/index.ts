import {
  defineConfig,
  type Logger,
  type Plugin,
  type ResolvedConfig,
} from "vite";
import { $ } from "execa";
import fs from "fs-extra";
import path from "path";
import { load as jsTomlLoad } from "js-toml";

function vitePluginTrunk(vitePluginTruckConfig?: { debug?: boolean }): Plugin {
  let config: ResolvedConfig;
  let logger: Logger;
  const name = "vite-plugin-trunk";
  const debug = Boolean(vitePluginTruckConfig?.debug);

  const getTrunkDistDir = () =>
    // default to /node_modules/.vite/.trunk
    `${config.cacheDir}/.trunk`;
  const getTrunkDevArgs = () => [
    "--no-minification",
    `--dist=${getTrunkDistDir()}`,
    "--no-sri",
    `--filehash=true`,
  ];
  const getTrunkProdArgs = () => [
    "--release",
    `--dist=${getTrunkDistDir()}`,
    `--filehash=true`,
  ];
  const getTrunkCache = async () => {
    const files = await fs.readdir(getTrunkDistDir(), { withFileTypes: true });
    const wasmFiles = files.filter((file) => file.name.endsWith(".wasm"));
    const jsFiles = files.filter((file) => file.name.endsWith(".js"));
    return { wasmFiles, jsFiles };
  };
  const getTrunkCacheJsSync = () => {
    const files = fs.readdirSync(getTrunkDistDir(), { withFileTypes: true });
    const jsFiles = files.filter((file) => file.name.endsWith(".js"));
    return jsFiles;
  };
  const getTrunkCacheWasmSync = () => {
    const files = fs.readdirSync(getTrunkDistDir(), { withFileTypes: true });
    const wasmFiles = files.filter((file) => file.name.endsWith(".wasm"));
    return wasmFiles;
  };

  let cargoPackageName: string | undefined = undefined;

  return {
    name,
    async config() {
      try {
        const cargoToml: { package?: { name?: string } } = jsTomlLoad(
          (
            await fs.readFile(path.resolve(process.cwd(), "Cargo.toml"))
          ).toString(),
        );
        if (!cargoToml?.package?.name) {
          throw new Error("Cargo.toml is missing package name");
        }
        cargoPackageName = cargoToml.package.name;
        return {};
      } catch (error) {
        throw new Error("Can't find Cargo.toml at project root", {
          cause: error,
        });
      }
    },
    configResolved(resolvedConfig) {
      config = resolvedConfig;
      logger = config.logger;
    },
    async transformIndexHtml(html) {
      if (config.command === "serve") {
        const { wasmFiles, jsFiles } = await getTrunkCache();
        if (wasmFiles[0]?.name && jsFiles[0]?.name) {
          if (debug) {
            console.debug(
              `[${name}] injecting wasm file ${wasmFiles[0].name} and js file ${jsFiles[0].name} into index.html`,
            );
          }
          return {
            html,
            tags: [
              {
                tag: "link",
                attrs: {
                  rel: "preload",
                  href: `/${wasmFiles[0].name}`,
                  as: "fetch",
                  type: "application/wasm",
                },
                injectTo: "head",
              },
              {
                tag: "link",
                attrs: {
                  rel: "modulepreload",
                  href: `/${jsFiles[0].name}`,
                },
                injectTo: "head",
              },
              {
                tag: "script",
                attrs: {
                  type: "module",
                },
                children: `import init, * as bindings from '/${jsFiles[0].name}';
                init('/${wasmFiles[0].name}');
                window.wasmBindings = bindings;`,
                injectTo: "body",
              },
            ],
          };
        }
      }
      return html;
    },
    async buildStart() {
      // build wasm modules before dev server start
      if (config.command === "serve") {
        await fs.ensureDir(getTrunkDistDir());
        logger.info(
          `trunk building wasm modules (can be slow on first start)`,
          { timestamp: true },
        );
        await $`trunk build ${getTrunkDevArgs()}`;
        logger.info(`🦀 trunk successfully built wasm on start`, {
          timestamp: true,
          clear: true,
        });
      }
    },
    async handleHotUpdate({ file, modules, server }) {
      // include .rs files and exclude files in target directory
      if (file.indexOf(".rs") > 0 && file.indexOf("target") < 0) {
        if (debug) {
          console.debug(`[${name}] recompiling ${file}`);
        }
        try {
          await $`trunk build ${getTrunkDevArgs()}`;
          logger.info(`${file} recompiled successfully.`, { timestamp: true });
          // trigger transformIndexHtml when a .rs file changes
          server.ws.send({
            type: "full-reload",
            path: "*",
          });
        } catch (error: any) {
          logger.error(error?.stderr ?? "unknown trunk error", {
            timestamp: true,
          });
          server.ws.send({
            type: "error",
            err: {
              message: error?.stderr,
              stack: "",
              plugin: name,
            },
          });
        }
        return [];
      }
      return modules;
    },
    configureServer(server) {
      // return a post hook that is called after internal middlewares are
      // installed
      return () => {
        server.middlewares.use((req, res, next) => {
          if (
            cargoPackageName &&
            req.originalUrl?.includes(cargoPackageName) &&
            req.originalUrl.includes(".wasm")
          ) {
            const wasmName = getTrunkCacheWasmSync()[0]?.name;
            // serve whatever wasm file found in truck cache when the request url
            // contains the Cargo package name + ".wasm"
            if (wasmName) {
              if (debug) {
                console.debug(`[${name}] serving wasm file ${wasmName}`);
              }
              res.setHeader(
                "Cache-Control",
                "no-cache, no-store, must-revalidate",
              );
              res.writeHead(200, { "Content-Type": "application/wasm" });
              res.end(fs.readFileSync(`${getTrunkDistDir()}/${wasmName}`));
              next();
            }
          }
          if (
            cargoPackageName &&
            req.originalUrl?.includes(cargoPackageName) &&
            req.originalUrl.includes(".js")
          ) {
            const jsName = getTrunkCacheJsSync()[0]?.name;

            // serve whatever wasm file found in truck cache when the request url
            // contains the Cargo package name + ".wasm"
            if (jsName) {
              if (debug) {
                console.debug(`[${name}] serving js file ${jsName}`);
              }
              res.setHeader(
                "Cache-Control",
                "no-cache, no-store, must-revalidate",
              );
              res.writeHead(200, { "Content-Type": "application/javascript" });
              res.end(fs.readFileSync(`${getTrunkDistDir()}/${jsName}`));
              next();
            }
          }
          next();
        });
      };
    },
    async closeBundle() {
      // copy all files from trunk cache to dist directory
      if (config.command === "build") {
        logger.info(`🦀 copying intermediate artifact _index.html`, {
          timestamp: true,
        });
        await fs.copyFile(`${config.build.outDir}/index.html`, `_index.html`);
        logger.info(`🦀 trunk creating production build...`, {
          timestamp: true,
        });
        await $`trunk build ${getTrunkProdArgs()} _index.html`;
        logger.info(`🦀 removing intermediate artifact _index.html`, {
          timestamp: true,
        });
        await fs.remove("_index.html");
        logger.info(`🦀 copying built index.html to ${config.build.outDir}`, {
          timestamp: true,
        });
        await fs.copyFile(
          `${getTrunkDistDir()}/index.html`,
          `${config.build.outDir}/index.html`,
        );
        const { wasmFiles, jsFiles } = await getTrunkCache();
        for (const wasmFile of wasmFiles) {
          logger.info(`🦀 copying built wasm to ${config.build.outDir}`, {
            timestamp: true,
          });
          await fs.copyFile(
            `${getTrunkDistDir()}/${wasmFile.name}`,
            `${config.build.outDir}/${wasmFile.name}`,
          );
        }
        for (const jsFile of jsFiles) {
          logger.info(`🦀 copying built js to ${config.build.outDir}`, {
            timestamp: true,
          });
          await fs.copyFile(
            `${getTrunkDistDir()}/${jsFile.name}`,
            `${config.build.outDir}/${jsFile.name}`,
          );
        }
        logger.info(`🦀 trunk successfully built wasm modules`, { timestamp: true });
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vitePluginTrunk()],
});
