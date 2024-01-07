import type { Logger, Plugin, ResolvedConfig } from "vite";
import { $ } from "execa";
import fs from "fs-extra";
import path from "path";
import { load as jsTomlLoad } from "js-toml";

export function vitePluginTrunk(vitePluginTruckConfig?: {
  debug?: boolean;
}): Plugin {
  let config: ResolvedConfig;
  let logger: Logger;
  const name = "vite-plugin-trunk";
  const filehash = true;
  const debug = Boolean(vitePluginTruckConfig?.debug);

  const getTrunkCacheDir = () =>
    // default to /node_modules/.vite/.trunk
    `${config.cacheDir}/.trunk`;
  const getTrunkDevArgs = () => [
    "--no-minification",
    `--dist=${getTrunkCacheDir()}`,
    "--no-sri",
    `--filehash=${filehash}`,
  ];
  const getTrunkCache = async () => {
    const files = await fs.readdir(getTrunkCacheDir(), { withFileTypes: true });
    const wasmFiles = files.filter((file) => file.name.endsWith(".wasm"));
    const jsFiles = files.filter((file) => file.name.endsWith(".js"));
    return { wasmFiles, jsFiles };
  };
  const getTrunkCacheJsSync = () => {
    const files = fs.readdirSync(getTrunkCacheDir(), { withFileTypes: true });
    const jsFiles = files.filter((file) => file.name.endsWith(".js"));
    return jsFiles;
  };
  const getTrunkCacheWasmSync = () => {
    const files = fs.readdirSync(getTrunkCacheDir(), { withFileTypes: true });
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
      await fs.ensureDir(getTrunkCacheDir());
      await $`trunk build ${getTrunkDevArgs()}`;
      logger.info(`trunk build successfully on start`, { timestamp: true });
    },
    async handleHotUpdate({ file, modules, server }) {
      if (file.indexOf(".rs") > 0) {
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
              res.end(fs.readFileSync(`${getTrunkCacheDir()}/${wasmName}`));
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
              res.end(fs.readFileSync(`${getTrunkCacheDir()}/${jsName}`));
              next();
            }
          }
          next();
        });
      };
    },
  };
}
