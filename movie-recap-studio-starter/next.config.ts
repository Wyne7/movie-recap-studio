import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config) {
    // @ffmpeg/ffmpeg creates its module Worker with:
    // new Worker(new URL(classWorkerURL, import.meta.url), { type: "module" })
    // Webpack's URL parser treats the dynamic URL as a build-time asset and
    // fails with "Module not found". Leave this URL expression native so the
    // browser resolves the worker relative to FFmpeg's ESM module at runtime.
    config.module.parser = config.module.parser ?? {};
    config.module.parser.javascript = {
      ...config.module.parser.javascript,
      url: false,
    };
    return config;
  },
};

export default nextConfig;
