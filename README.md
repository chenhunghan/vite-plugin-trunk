# vite-plugin-trunk

A zero-config vite plugin for seamless integrating WASM components in a React/Vue project.

```ts
import { vitePluginTrunk } from "vite-plugin-trunk"
export default defineConfig({
  plugins: [vitePluginTrunk()],
})
```

## Get started by frameworks

### React + [Leptos](https://leptos.dev/)

Start a new React project
```sh
npm create vite@latest my-react-app -- --template react-ts
cd my-react-app
npm install --save-dev vite-plugin-trunk
```

Import `vitePluginTrunk` plugin in `vite.config.ts`.
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { vitePluginTrunk } from "vite-plugin-trunk"

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), vitePluginTrunk()],
})
```

#### Create a Rust project

Create `Cargo.toml` (package.json, but for Rust) at the project root with [Leptos](https://leptos.dev/).
```toml
[package]
name = "hello-leptos"
version = "0.1.0"
edition = "2021"

[dependencies]
leptos = { version = "0.5.4", features = ["csr", "nightly"] }
```

Create `main.rs` in `./src` with a basic [Leptos](https://leptos.dev/) 
```rust
use leptos::*;

fn main() {
  leptos::mount_to_body(|| view! { <span>"Hello Leptos"</span> })
}
```

#### Set up Rust toolchain

Install Rust's nightly toolchain (because we are using Leptos with `nightly` feature.
```sh
rustup toolchain install nightly
rustup override set nightly # set toolchain to nightly for this project 
```

Install [Trunk](https://trunkrs.dev/)
```sh
cargo binstall trunk
```

#### Start Development

```
npm run dev
```

You should see both Vite + React logos, and "Hello Leptos" on the screen.

Production build
```
npm run build
```

### Vue + [Leptos](https://leptos.dev/)

```ts
import { vitePluginTrunk } from "vite-plugin-trunk"
import vue from "@vitejs/plugin-vue"

export default defineConfig({
  plugins: [vue(), vitePluginTrunk()],
})
```

### With tailwind

Follow <https://tailwindcss.com/docs/guides/vite> and include `.rs` in your `./tailwind.config.js`
```js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,rs}", // include rs!
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```
