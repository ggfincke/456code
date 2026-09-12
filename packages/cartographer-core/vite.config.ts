import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({ test: { testTimeout: 30000 } });
